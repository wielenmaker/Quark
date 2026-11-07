// CLI entry point for Quark
//
// Usage:
//   quark --agent coder --message "help me fix this bug"
//   quark -a coder -m "help me fix this bug"
//   quark "quick message without flags"
//   quark --model claude-sonnet-4.5 "one-off with a specific model"

import { parseArgs } from "util"
import { ensureStorageRoot } from "@quark/runner/storage/session-jsonl"
import { materializeAgent, resolveAgent, listAgents } from "./agent/agent"
import { bus, type TypedBus } from "@quark/runner/session/events"
import { startEventWriter } from "@quark/runner/session/event-writer"
import { setVerbose, debug } from "@quark/runner/debug"
import { formatArgs } from "@quark/runner/debug/format-tool-args"
import { closeSubagents } from "@quark/runner/subagent/supervisor"
import { createQuarkRuntime } from "./runtime"
import { useRunnerSessionRoot } from "./session-root"
import { tuiLaunchArgs } from "./tui-launch"

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
       quark acp [--profile <name>]   Serve ACP (Agent Client Protocol) over stdio
                                     --agent/-a is an alias; -p for --profile
       quark doctor                   Diagnose the install, config, tools, and runtimes

Options:
  -a, --agent <name>            Agent to use (default: from config)
  -m, --message <text>          Message text (alternative to positional)
  -s, --session <id>            Resume an existing session
      --model <id>              Model to use for this run (e.g. copilot/claude-sonnet-4.5)
      --no-store                Run an ephemeral session — never written to disk
      --sub-agent               Memory-only worker; accepts JSON prompts on stdin
      --verbose                 Print every tool call + result to stderr.
                                For engine internals use QUARK_DEBUG=* (see README).
  -l, --list-agents             List available agents
  -h, --help                    Show this help message

Examples:
  quark --agent coder --message "fix the bug in main.ts"
  quark -a coder "fix the bug in main.ts"
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
  subAgent?: boolean
  verbose?: boolean
  listAgents?: boolean
  help?: boolean
}

function parseArguments(): ParsedArgs {
  try {
    const { values, positionals } = parseArgs({
      options: {
        agent: { type: "string", short: "a" },
        message: { type: "string", short: "m" },
        session: { type: "string", short: "s" },
        model: { type: "string" },
        "no-store": { type: "boolean" },
        "sub-agent": { type: "boolean" },
        verbose: { type: "boolean" },
        "list-agents": { type: "boolean", short: "l" },
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
      agent: values.agent,
      message,
      sessionId: values.session,
      model: values.model,
      noStore: values["no-store"],
      subAgent: values["sub-agent"],
      verbose: values.verbose,
      listAgents: values["list-agents"],
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

  // `quark acp` — long-lived NDJSON agent over stdio. Dispatched before argument
  // parsing so "acp" is never treated as a positional message. stdout is the
  // protocol channel; this branch must never write diagnostics there.
  if (process.argv[2] === "acp") {
    try {
      const { runAcpCommand } = await import("./acp-host")
      // QUA-267: let teardown finish before exiting instead of force-exiting.
      process.exitCode = await runAcpCommand(process.argv.slice(3))
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
    return
  }

  // `quark doctor` — read-only diagnosis. Dispatched before argument parsing
  // so "doctor" is never treated as a positional message.
  if (process.argv[2] === "doctor") {
    try {
      const { runDoctorCommand } = await import("./doctor")
      process.exit(await runDoctorCommand(process.argv.slice(3)))
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
    for (const a of agents) {
      console.log(`  - ${a}`)
    }
    process.exit(0)
  }

  if (args.subAgent) {
    if (args.sessionId) {
      console.error("Error: --sub-agent resumes through its live stdin connection, not --session")
      process.exitCode = 1
      return
    }
    try {
      if (args.agent && !listAgents().includes(args.agent)) throw new Error(`Unknown subagent profile: ${args.agent}`)
      const agentDef = resolveAgent(args.agent)
      const agent = await materializeAgent(agentDef)
      const { runSubagentWorker } = await import("./subagent-worker")
      await runSubagentWorker({ agent, profile: agentDef.id, model: args.model ?? agentDef.model, message: args.message })
    } catch (error) {
      const { SUBAGENT_EVENT_PREFIX } = await import("@quark/runner/subagent/protocol")
      console.error(SUBAGENT_EVENT_PREFIX + JSON.stringify({ e: "error", kind: "process", message: error instanceof Error ? error.message : String(error) }))
      process.exitCode = 1
    }
    return
  }

  // No message provided → launch interactive TUI
  if (!args.message) {
    const { execFileSync } = await import("child_process")
    const { resolveAppPaths, findBun } = await import("./app-paths")
    const { appRoot } = resolveAppPaths()
    const bun = findBun()
    if (!bun) {
      console.error("Interactive mode requires Bun. Install it from https://bun.sh, then run quark again.")
      process.exit(1)
    }
    try {
      execFileSync(bun, tuiLaunchArgs(appRoot, args), {
        stdio: "inherit",
        env: { ...process.env, QUARK_DIR: appRoot },
      })
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        console.error("Interactive mode requires Bun. Install it from https://bun.sh, then run quark again.")
        process.exit(1)
      }
      if (String(error?.message).includes("Compiled TUI is missing")) {
        console.error(error.message)
        process.exit(1)
      }
      throw error
    }
    process.exit(0)
  }

  // Resolve agent manifest, then materialize it into a portable AgentDefinition.
  // Tools and skills travel with the definition — nothing is registered globally.
  const agentDef = resolveAgent(args.agent)
  const agent = await materializeAgent(agentDef)

  // Use the REST runner session namespace for new and resumed CLI sessions.
  useRunnerSessionRoot()
  ensureStorageRoot()

  // The internal subagent supervisor opts into structured stderr events through
  // environment variables, keeping the public CLI free of subagent flags.
  const parentSessionId = process.env.QUARK_PARENT_SESSION_ID
  const modelOverride = args.model ?? undefined

  if (parentSessionId) {
    const runtime = await createQuarkRuntime({ agent, bus })
    const cleanupEventWriter = startEventWriter({
      resolvedModel: args.model ?? agentDef.model,
      profile: agentDef.id,
      eventBus: runtime.bus,
    })
    wireCliBus(runtime.bus)
    try {
      const result = await runtime.prompt({
        sessionId: args.sessionId,
        parentSessionId,
        ephemeral: args.noStore,
        parts: [{ type: "text", text: args.message }],
        model: modelOverride,
      })
      dlog(`session: ${result.sessionId}`)
      cleanupEventWriter()
      closeSubagents()
      // QUA-267: return with an exit code so pending teardown can settle.
      process.exitCode = 0
      return
    } catch (err: any) {
      console.error("Error:", err.message)
      cleanupEventWriter()
      closeSubagents()
      process.exitCode = 1
      return
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
    // One-shot runs end here: live subagents must die with the process, so a
    // finished child never keeps the event loop (and the CLI) alive.
    closeSubagents()
    // QUA-267: return with an exit code so pending teardown can settle.
    process.exitCode = 0
    return
  } catch (err: any) {
    console.error("Error:", err.message)
    closeSubagents()
    process.exitCode = 1
    return
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
