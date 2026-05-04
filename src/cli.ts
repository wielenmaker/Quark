// CLI entry point for Quark
//
// Usage:
//   quark --profile coder --prompt "help me fix this bug"
//   quark -p coder -m "help me fix this bug"
//   quark "quick prompt without flags"
//   quark --sub-agent --profile researcher --prompt "research this topic"
//   quark --parent-session <id> --profile researcher --prompt "research this topic"
//   quark --model claude-sonnet-4.5 "one-off with a specific model"

import { parseArgs } from "util"
import { bootstrap } from "./bootstrap"
import { prompt } from "./session/prompt"
import { resolveProfile, readPromptFile, listProfiles } from "./profile/profile"
import { agentFromProfile } from "./agent"
import { bus } from "./session/events"
import { startEventWriter } from "./session/event-writer"
import { loadConfig } from "./config/config"

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

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
  const args = parseArguments()

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
  const profile = resolveProfile(args.profile)
  const promptResult = readPromptFile(profile)
  const agent = agentFromProfile(profile, promptResult.content)

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
  bus.on("text-delta", ({ delta }) => {
    process.stdout.write(delta)
  })

  bus.on("tool-start", ({ tool }) => {
    process.stdout.write(`\n[tool: ${tool}]\n`)
  })

  bus.on("tool-end", (data) => {
    if (data.output) {
      const output = typeof data.output === "string" ? data.output : JSON.stringify(data.output)
      // Truncate long outputs for human-readable CLI display.
      // Sub-agent mode: the parent model needs full tool results, so
      // use the same 50 KB limit as the Bash tool's output buffer.
      const maxLen = args.subAgent ? 50_000 : 500
      const display = output.length > maxLen ? output.slice(0, maxLen) + "..." : output
      process.stdout.write(`${display}\n`)
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

    console.log(`\n[session: ${result.sessionId}]`)
    cleanupEventWriter?.()
    process.exit(0)
  } catch (err: any) {
    console.error("Error:", err.message)
    cleanupEventWriter?.()
    process.exit(1)
  }
}

main()
