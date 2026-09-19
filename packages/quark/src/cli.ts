// CLI entry point for Quark
//
// Usage:
//   quark --agent coder --message "help me fix this bug"
//   quark -a coder -m "help me fix this bug"
//   quark "quick message without flags"
//   quark --model claude-sonnet-4.5 "one-off with a specific model"
//
// `--profile` / `-p` remain accepted as aliases for `--agent` / `-a`.

import { parseArgs } from "util"
import { prompt as legacyPrompt } from "@quark/runner/session/prompt"
import { resolveAgent, listAgents, materializeAgent } from "./agent/agent"
import { ensureStorageRoot } from "@quark/runner/storage/session-jsonl"
import { loadPlugins } from "./plugin-loader"
import { bus, type TypedBus } from "@quark/runner/session/events"
import { startEventWriter } from "@quark/runner/session/event-writer"
import { setVerbose, debug } from "@quark/runner/debug"
import { formatArgs } from "@quark/runner/debug/format-tool-args"
import { createQuarkRuntime } from "./runtime"
import { loadConfig } from "./config/config"
import { loadAmbientInstructions } from "./ambient"

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
  -a, --agent <name>            Agent to use (default: config default_agent)
  -p, --profile <name>          Alias for --agent
  -m, --message <text>          Message text (alternative to positional)
  -s, --session <id>            Resume an existing session
      --model <id>              Model to use for this run (e.g. copilot/claude-sonnet-4.5)
      --no-store                Run an ephemeral session — never written to disk
      --verbose                 Print every tool call + result to stderr.
                                For engine internals use QUARK_DEBUG=* (see README).
  -l, --list-agents             List available agents (alias: --list-profiles)
  -h, --help                    Show this help message

Examples:
  quark --agent coder --message "fix the bug in main.ts"
  quark -p coder "fix the bug in main.ts"
  quark "quick question"
  quark --model copilot/claude-sonnet-4.5 "use a specific model for this run"
  quark --no-store "quick one-off question that should not be saved"
`)
}

interface ParsedArgs {
  agent?: string
  message?: string
  sessionId?: string
  model?: string
  noStore?: boolean
  verbose?: boolean
  listAgents?: boolean
  help?: boolean
}

function parseArguments(): ParsedArgs {
  try {
    const { values, positionals } = parseArgs({
      options: {
        agent: { type: "string", short: "a" },
        profile: { type: "string", short: "p" },
        message: { type: "string", short: "m" },
        session: { type: "string", short: "s" },
        model: { type: "string" },
        "no-store": { type: "boolean" },
        verbose: { type: "boolean" },
        "list-agents": { type: "boolean", short: "l" },
        "list-profiles": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    })

    if (values.agent && values.profile && values.agent !== values.profile) {
      console.error("Error: --agent and --profile refer to different values; use --agent (--profile is an alias)")
      process.exit(1)
    }

    // Positional argument is treated as a message if --message is not given.
    const positionalMessage = positionals.join(" ")
    const message = values.message ?? (positionalMessage || undefined)

    // --no-store and --session are mutually exclusive (can't resume an ephemeral session)
    if (values["no-store"] && values.session) {
      console.error("Error: --no-store and --session are mutually exclusive")
      process.exit(1)
    }

    return {
      agent: values.agent ?? values.profile,
      message,
      sessionId: values.session,
      model: values.model,
      noStore: values["no-store"],
      verbose: values.verbose,
      listAgents: values["list-agents"] || values["list-profiles"],
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
      const { runAuthCommand } = await import("./auth-cli")
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

  if (args.listAgents) {
    const agents = listAgents()
    console.log("Available agents:")
    for (const agent of agents) {
      console.log(`  - ${agent}`)
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
    try {
      execFileSync("bun", [
        "--preload", `${quarkDir}/preload.ts`, `${quarkDir}/src/tui/index.tsx`,
        // Forward the launch flags the TUI understands instead of silently
        // dropping them (`--model` maps to the TUI's runtime model override).
        ...(args.agent ? ["--agent", args.agent] : []),
        ...(args.sessionId ? ["--session", args.sessionId] : []),
        ...(args.model ? ["--model", args.model] : []),
      ], {
        stdio: "inherit",
        env: { ...process.env, QUARK_DIR: quarkDir },
      })
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        console.error("Interactive mode requires Bun. Install it from https://bun.sh, then run quark again.")
        process.exit(1)
      }
      throw error
    }
    process.exit(0)
  }

  // Resolve the agent manifest, then materialize it into a portable
  // AgentDefinition. Tools and skills travel with the definition — nothing is
  // registered globally.
  const agentDef = resolveAgent(args.agent)
  const agent = await materializeAgent(agentDef)

  // Portable runtime init: storage root only (no global tools).
  ensureStorageRoot()

  // The internal subagent supervisor opts into structured stderr events through
  // environment variables, keeping the public CLI free of subagent flags.
  const parentSessionId = process.env.QUARK_PARENT_SESSION_ID
  const modelOverride = args.model ?? undefined

  // Sub-agent child: keep the legacy singleton path. Instance runners are
  // intentionally isolated from process-global turn state, so they never flip
  // the custom-fetch force-agent flag a sub-agent session needs.
  if (parentSessionId) {
    await loadPlugins()
    const cleanupEventWriter = startEventWriter({
      resolvedModel: args.model ?? agentDef.model,
      profile: agentDef.id,
    })
    wireCliBus(bus)
    try {
      const config = loadConfig()
      const result = await legacyPrompt({
        sessionId: args.sessionId,
        parentSessionId,
        ephemeral: args.noStore,
        parts: [{ type: "text", text: args.message }],
        model: modelOverride,
        agent,
        ambientInstructions: loadAmbientInstructions,
        policies: {
          maxSteps: config.maxSteps,
          branching: config.branching,
          smallModel: modelOverride ?? config.models.small,
          undo: true,
        },
      })
      dlog(`session: ${result.sessionId}`)
      cleanupEventWriter()
      process.exit(0)
    } catch (err: any) {
      console.error("Error:", err.message)
      cleanupEventWriter()
      process.exit(1)
    }
  }

  // Main CLI path: one instance runner bound to the materialized definition.
  const runtime = await createQuarkRuntime({ agent, bus })
  wireCliBus(runtime.bus)

  try {
    const result = await runtime.prompt({
      sessionId: args.sessionId,
      ephemeral: args.noStore,
      parts: [{ type: "text", text: args.message }],
      model: modelOverride,
    })

    dlog(`session: ${result.sessionId}`)
    if (!args.noStore) {
      process.stdout.write(`Resume the session with quark --session ${result.sessionId}\n`)
    }
    process.exit(0)
  } catch (err: any) {
    console.error("Error:", err.message)
    process.exit(1)
  }
}

/** Wire basic streaming/tool output for a CLI run onto `eventBus`. */
function wireCliBus(eventBus: TypedBus) {
  eventBus.on("text-start", () => {
    dlog("text-start")
  })

  eventBus.on("text-delta", ({ delta }) => {
    if (dlog.enabled) dlog(`text-delta len=${delta.length}`)
    process.stdout.write(delta)
  })

  eventBus.on("text-end", () => {
    dlog("text-end")
  })

  eventBus.on("assistant-message-start", ({ messageId }) => {
    dlog(`assistant-message-start id=${messageId}`)
  })

  eventBus.on("assistant-message-end", ({ messageId, finish }) => {
    dlog(`assistant-message-end id=${messageId} finish=${finish}`)
  })

  // Verbose tool-call logging. `--verbose` (= QUARK_DEBUG=*) enables this;
  // targeted use is `QUARK_DEBUG=tool-call,tool-result` for only tool
  // activity, or `QUARK_DEBUG=tool-call:raw` for full untruncated JSON.
  eventBus.on("tool-input", ({ tool, input }) => {
    if (tlogCall.enabled) {
      console.error(`[TOOL-CALL] ${tool}(${formatArgs(input)})`)
    }
    if (tlogRaw.enabled) {
      console.error(`[TOOL-CALL:RAW] ${tool} ${JSON.stringify(input)}`)
    }
  })

  eventBus.on("tool-end", ({ tool, status, output, error }) => {
    if (!tlogResult.enabled) return
    if (status === "error") {
      console.error(`[TOOL-RESULT] ${tool} error: ${error ?? "(unknown)"}`)
    } else {
      console.error(`[TOOL-RESULT] ${tool} ok${output ? ` (${output.length}b)` : ""}`)
    }
  })

  eventBus.on("error", ({ error }) => {
    console.error("\nError:", error)
  })

  eventBus.on("loop-end", () => {
    process.stdout.write("\n")
  })
}

main()
