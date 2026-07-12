// CLI entry point for Quark
//
// Usage:
//   quark --profile coder --prompt "help me fix this bug"
//   quark -p coder -m "help me fix this bug"
//   quark "quick prompt without flags"
//   quark --sub-agent --profile researcher --prompt "research this topic"
//   quark --parent-session <id> --profile researcher --prompt "research this topic"
//   quark --model claude-sonnet-4.5 "one-off with a specific model"
//   quark acp                       Start ACP agent (JSON-RPC over stdio)

import { parseArgs } from "util"
import { bootstrap } from "./bootstrap"
import { prompt } from "./session/prompt"
import { resolveProfile, readPromptFile, listProfiles } from "./profile/profile"
import { agentFromProfile } from "./agent"
import { bus } from "./session/events"
import { startEventWriter } from "./session/event-writer"
import { loadConfig } from "./config/config"
import { getActive } from "./notification/notification"
import { setVerbose, debug } from "./debug"
import { formatArgs } from "./debug/format-tool-args"

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

function exitForConfigurationError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Configuration error: ${message}`)
  process.exit(1)
}

function printHelp() {
  console.log(`
Usage: quark [options] [prompt]

Options:
  -p, --profile <name>          Profile to use (default: from config)
  -m, --prompt <text>           Prompt text (alternative to positional)
  -s, --session <id>            Resume an existing session
      --model <id>              Model to use for this run (e.g. copilot/claude-sonnet-4.5)
      --parent-session <id>     Create a child session under this parent
      --sub-agent               Create a child session (reads QUARK_SESSION_ID from env)
      --no-store                Run an ephemeral session — never written to disk
      --verbose                 Print every tool call + result to stderr.
                                For engine internals use QUARK_DEBUG=* (see README).
  -l, --list-profiles           List available profiles
  -h, --help                    Show this help message

Examples:
  quark --profile coder --prompt "fix the bug in main.ts"
  quark -p coder "fix the bug in main.ts"
  quark "quick question"
  quark --model copilot/claude-sonnet-4.5 "use a specific model for this run"
  quark --no-store "quick one-off question that should not be saved"
  quark --sub-agent --profile researcher --prompt "research auth flow"
  quark --parent-session sess_abc --profile researcher --prompt "research auth flow"
`)
}

interface ParsedArgs {
  profile?: string
  prompt?: string
  sessionId?: string
  parentSessionId?: string
  model?: string
  subAgent?: boolean
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
        prompt: { type: "string", short: "m" },
        session: { type: "string", short: "s" },
        model: { type: "string" },
        "parent-session": { type: "string" },
        "sub-agent": { type: "boolean" },
        "no-store": { type: "boolean" },
        verbose: { type: "boolean" },
        "list-profiles": { type: "boolean", short: "l" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    })

    // Positional argument is treated as prompt if --prompt not given
    const positionalPrompt = positionals.join(" ")
    const promptText = values.prompt ?? (positionalPrompt || undefined)

    // Resolve parent session ID
    let parentSessionId: string | undefined = values["parent-session"]
    if (values["sub-agent"]) {
      if (parentSessionId) {
        console.error("Error: --sub-agent and --parent-session are mutually exclusive")
        process.exit(1)
      }
      parentSessionId = process.env.QUARK_SESSION_ID
      if (!parentSessionId) {
        console.error("Error: --sub-agent requires QUARK_SESSION_ID environment variable")
        process.exit(1)
      }
    }

    // --session and --parent-session are mutually exclusive
    if (values.session && parentSessionId) {
      console.error("Error: --session and --parent-session/--sub-agent are mutually exclusive")
      process.exit(1)
    }

    // --no-store and --session are mutually exclusive (can't resume an ephemeral session)
    if (values["no-store"] && values.session) {
      console.error("Error: --no-store and --session are mutually exclusive")
      process.exit(1)
    }

    return {
      profile: values.profile,
      prompt: promptText,
      sessionId: values.session,
      parentSessionId,
      model: values.model,
      subAgent: values["sub-agent"],
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
  // Route "quark acp" subcommand to ACP agent entry point
  if (process.argv[2] === "acp") {
    const { runAcpEntry } = await import("./acp/entry")
    await runAcpEntry()
    process.exit(0)
  }

  const args = parseArguments()

  if (args.verbose) setVerbose(true)

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args.listProfiles) {
    try {
      const profiles = listProfiles()
      console.log("Available profiles:")
      for (const p of profiles) {
        console.log(`  - ${p}`)
      }
    } catch (error) {
      exitForConfigurationError(error)
    }
    process.exit(0)
  }

  // No prompt provided → launch interactive TUI
  if (!args.prompt) {
    const { execSync } = await import("child_process")
    const { fileURLToPath } = await import("url")
    const { dirname, resolve } = await import("path")
    const thisDir = typeof import.meta.dir === "string"
      ? import.meta.dir
      : dirname(fileURLToPath(import.meta.url))
    const quarkDir = process.env.QUARK_DIR ?? resolve(thisDir, "..")
    execSync(`bun --preload "${quarkDir}/preload.ts" "${quarkDir}/src/tui/index.tsx"`, {
      stdio: "inherit",
      env: { ...process.env, QUARK_DIR: quarkDir },
    })
    process.exit(0)
  }

  // Resolve profile
  let profile
  try {
    profile = resolveProfile(args.profile)
  } catch (error) {
    exitForConfigurationError(error)
  }
  const promptResult = readPromptFile(profile)
  const agent = agentFromProfile(profile, promptResult.content)

  for (const notification of getActive()) {
    if (notification.type === "warn") {
      console.error(`${notification.title}: ${notification.message}`)
    }
  }

  // Bootstrap with profile tools and skills
  await bootstrap({
    profileTools: profile.tools,
    boundSkills: profile.skills,
  })

  // When running as a sub-agent, stream structured events to stderr
  // so the parent's Bash tool can render sub-agent activity in the TUI.
  let cleanupEventWriter: (() => void) | undefined
  if (args.subAgent) {
    cleanupEventWriter = startEventWriter()
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
      parentSessionId: args.parentSessionId,
      ephemeral: args.noStore,
      parts: [{ type: "text", text: args.prompt }],
      model: modelOverride,
      agent,
    })

    dlog(`session: ${result.sessionId}`)
    cleanupEventWriter?.()
    process.exit(0)
  } catch (err: any) {
    console.error("Error:", err.message)
    cleanupEventWriter?.()
    process.exit(1)
  }
}

main().catch(exitForConfigurationError)
