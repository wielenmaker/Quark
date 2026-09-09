// CLI entry point for Quark
//
// Usage:
//   quark --profile coder --message "help me fix this bug"
//   quark -p coder -m "help me fix this bug"
//   quark "quick message without flags"
//   quark --model claude-sonnet-4.5 "one-off with a specific model"

import { parseArgs } from "util"
import { bootstrap } from "./bootstrap"
import { prompt } from "./session/prompt"
import { resolveProfile, readPromptFile, listProfiles } from "./profile/profile"
import { agentFromProfile } from "./agent"
import { bus } from "./session/events"
import { emitSubagentError, startEventWriter } from "./session/event-writer"
import { loadConfig } from "./config/config"
import { setVerbose, debug } from "./debug"
import { formatArgs } from "./debug/format-tool-args"
import { loadSkillFile } from "./skill/skill"
import { flushTelemetry } from "./telemetry"

const dlog = debug("cli")
// Tool-call logging uses explicit uppercase prefixes (`[TOOL-CALL]`,
// `[TOOL-RESULT]`) for readability; we only use `debug()` here as the
// on/off gate, then write to stderr ourselves with the standard prefix.
const tlogCall = debug("tool-call")
const tlogResult = debug("tool-result")
const tlogRaw = debug("tool-call:raw")

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
Usage: quark [options] [message]
       quark auth <login|status|logout> [provider]

Options:
  -p, --profile <name>          Profile to use (default: from config)
  -m, --message <text>          Message text (alternative to positional)
       --skill-file <path>       Inject a candidate SKILL.md for this run only
  -s, --session <id>            Resume an existing session
            --model <id>              Model to use for this run (e.g. copilot/claude-sonnet-4.5)
      --no-store                Run an ephemeral session — never written to disk
      --verbose                 Print every tool call + result to stderr.
                                For engine internals use QUARK_DEBUG=* (see README).
  -l, --list-profiles           List available profiles
  -h, --help                    Show this help message

Examples:
  quark --profile coder --message "fix the bug in main.ts"
  quark -p coder "fix the bug in main.ts"
  quark "quick question"
  quark --model copilot/claude-sonnet-4.5 "use a specific model for this run"
  quark --no-store "quick one-off question that should not be saved"
`)
}

interface ParsedArgs {
  profile?: string
  message?: string
  sessionId?: string
  model?: string
  skillFile?: string
  noStore?: boolean
  verbose?: boolean
  listProfiles?: boolean
  help?: boolean
}

function parseArguments(): ParsedArgs {
  try {
    const { values, positionals } = parseArgs({
      options: {
        profile: { type: "string", short: "p" },
        message: { type: "string", short: "m" },
        session: { type: "string", short: "s" },
        model: { type: "string" },
        "skill-file": { type: "string" },
        "no-store": { type: "boolean" },
        verbose: { type: "boolean" },
        "list-profiles": { type: "boolean", short: "l" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    })

    // Positional argument is treated as a message if --message is not given.
    const positionalMessage = positionals.join(" ")
    const message = values.message ?? (positionalMessage || undefined)

    // --no-store and --session are mutually exclusive (can't resume an ephemeral session)
    if (values["no-store"] && values.session) {
      console.error("Error: --no-store and --session are mutually exclusive")
      process.exit(1)
    }

    return {
      profile: values.profile,
      message,
      sessionId: values.session,
      model: values.model,
      skillFile: values["skill-file"],
      noStore: values["no-store"],
      verbose: values.verbose,
      listProfiles: values["list-profiles"],
      help: values.help,
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.argv[2] === "auth") {
    try {
      const { runAuthCommand } = await import("./commands/auth-cli")
      process.exit(await runAuthCommand(process.argv.slice(3)))
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }

  const args = parseArguments()

  if (args.verbose) setVerbose(true)

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args.listProfiles) {
    const profiles = listProfiles()
    console.log("Available profiles:")
    for (const p of profiles) {
      console.log(`  - ${p}`)
    }
    process.exit(0)
  }

  // No message provided → launch interactive TUI
  if (!args.message) {
    const { execFileSync } = await import("child_process")
    const { fileURLToPath } = await import("url")
    const { dirname, resolve } = await import("path")
    const thisDir = typeof import.meta.dir === "string"
      ? import.meta.dir
      : dirname(fileURLToPath(import.meta.url))
    const quarkDir = process.env.QUARK_DIR ?? resolve(thisDir, "..")
    execFileSync("bun", [
      "--preload", `${quarkDir}/preload.ts`, `${quarkDir}/src/tui/index.tsx`,
      ...(args.sessionId ? ["--session", args.sessionId] : []),
    ], {
      stdio: "inherit",
      env: { ...process.env, QUARK_DIR: quarkDir },
    })
    process.exit(0)
  }

  // Resolve profile
  const profile = resolveProfile(args.profile)
  const promptResult = readPromptFile(profile)
  const agent = agentFromProfile(profile, promptResult.content)
  if (args.skillFile) {
    agent.runtimeSkills = [loadSkillFile(args.skillFile)]
  }

  // Bootstrap with profile tools and skills
  await bootstrap({
    profileTools: profile.tools,
    boundSkills: profile.skills,
  })

  // The internal subagent supervisor opts into structured stderr events through
  // environment variables, keeping the public CLI free of subagent flags.
  const parentSessionId = process.env.QUARK_PARENT_SESSION_ID
  let cleanupEventWriter: (() => void) | undefined
  if (parentSessionId) {
    cleanupEventWriter = startEventWriter({
      resolvedModel: args.model ?? profile.model,
      profile: profile.id,
    })
  }

  // Wire up basic event output for CLI
  bus.on("text-start", () => {
    dlog("text-start")
  })

  bus.on("text-delta", ({ delta }) => {
    if (dlog.enabled) dlog(`text-delta len=${delta.length}`)
    process.stdout.write(delta)
  })

  bus.on("text-end", () => {
    dlog("text-end")
  })

  bus.on("assistant-message-start", ({ messageId }) => {
    dlog(`assistant-message-start id=${messageId}`)
  })

  bus.on("assistant-message-end", ({ messageId, finish }) => {
    dlog(`assistant-message-end id=${messageId} finish=${finish}`)
  })

  // Verbose tool-call logging. `--verbose` (= QUARK_DEBUG=*) enables this;
  // targeted use is `QUARK_DEBUG=tool-call,tool-result` for only tool
  // activity, or `QUARK_DEBUG=tool-call:raw` for full untruncated JSON.
  bus.on("tool-input", ({ tool, input }) => {
    if (tlogCall.enabled) {
      console.error(`[TOOL-CALL] ${tool}(${formatArgs(input)})`)
    }
    if (tlogRaw.enabled) {
      console.error(`[TOOL-CALL:RAW] ${tool} ${JSON.stringify(input)}`)
    }
  })

  bus.on("tool-end", ({ tool, status, output, error }) => {
    if (!tlogResult.enabled) return
    if (status === "error") {
      console.error(`[TOOL-RESULT] ${tool} error: ${error ?? "(unknown)"}`)
    } else {
      console.error(`[TOOL-RESULT] ${tool} ok${output ? ` (${output.length}b)` : ""}`)
    }
  })

  bus.on("error", ({ error }) => {
    console.error("\nError:", error)
  })

  bus.on("loop-end", () => {
    process.stdout.write("\n")
  })

  // Run the prompt
  try {
    const modelOverride = args.model ?? undefined

    const result = await prompt({
      sessionId: args.sessionId,
      parentSessionId,
      ephemeral: args.noStore,
      parts: [{ type: "text", text: args.message }],
      model: modelOverride,
      agent,
    })

    dlog(`session: ${result.sessionId}`)
    if (!args.noStore && !parentSessionId) {
      process.stdout.write(`Resume the session with quark --session ${result.sessionId}\n`)
    }
    cleanupEventWriter?.()
    await flushTelemetry()
    process.exit(0)
  } catch (err: any) {
    console.error("Error:", err.message)
    cleanupEventWriter?.()
    await flushTelemetry()
    process.exit(1)
  }
}

main()
