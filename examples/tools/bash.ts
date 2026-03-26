// Tool: bash — execute shell commands
//
// Copy to ~/.config/atom/tools/bash.ts
//
// When the command is an `atom --sub-agent` invocation, stderr is parsed
// for ATOM_EVENT: lines and forwarded to the parent's event bus so the
// TUI can render sub-agent tool activity in real time.

import { spawn } from "child_process"
import { z } from "zod"
import { bus } from "../../src/session/events"
import type { SubAgentEvent } from "../../src/session/event-writer"

const DEFAULT_TIMEOUT = 120_000 // 2 minutes
const MAX_OUTPUT = 50_000 // ~50KB output cap
const EVENT_PREFIX = "ATOM_EVENT:"

/** Detect whether a command spawns an atom sub-agent */
function isSubAgentCommand(command: string): boolean {
  // Match: atom --sub-agent, atom --sub-agent --profile ..., etc.
  // Also match full paths like /path/to/atom --sub-agent
  return /\batom\b.*--sub-agent\b/.test(command)
}

export default {
  id: "bash",
  description:
    "Execute a shell command and return its output (stdout + stderr combined). " +
    "Commands run in the current working directory. Use timeout to limit long-running commands.",
  parameters: z.object({
    command: z.string().describe("Shell command to execute"),
    timeout: z
      .number()
      .optional()
      .describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT})`),
  }),
  async execute(args: { command: string; timeout?: number }, ctx: any) {
    const timeout = args.timeout ?? DEFAULT_TIMEOUT
    const isSubAgent = isSubAgentCommand(args.command)

    // For sub-agent commands, extract the profile name for display
    const subAgentProfile = isSubAgent
      ? (args.command.match(/--profile\s+(\S+)/)?.[1] ?? "sub-agent")
      : undefined

    return new Promise((resolve) => {
      let output = ""
      let killed = false
      // Track the parent tool callId so TUI can associate child events
      // with the correct Bash tool invocation.
      const parentCallId = ctx.callId as string | undefined

      const proc = spawn("sh", ["-c", args.command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // Ensure child processes can discover their parent session
          ...(ctx.sessionId ? { ATOM_SESSION_ID: ctx.sessionId } : {}),
          // Tell the sub-agent to emit structured events on stderr
          ...(isSubAgent ? { ATOM_EMIT_EVENTS: "1" } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      const appendOutput = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT) {
          output += chunk.toString()
        }
      }

      // stdout always goes to output buffer
      proc.stdout?.on("data", appendOutput)

      if (isSubAgent) {
        // For sub-agent commands, parse stderr line-by-line.
        // Lines prefixed with ATOM_EVENT: are structured events — forward
        // to the parent bus. Everything else is regular stderr output.
        let stderrBuffer = ""

        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrBuffer += chunk.toString()
          const lines = stderrBuffer.split("\n")
          // Keep the last (possibly incomplete) line in the buffer
          stderrBuffer = lines.pop() ?? ""

          for (const line of lines) {
            if (line.startsWith(EVENT_PREFIX)) {
              try {
                const event = JSON.parse(line.slice(EVENT_PREFIX.length)) as SubAgentEvent
                emitSubAgentEvent(ctx.sessionId, ctx.messageId, parentCallId, subAgentProfile!, event)
              } catch {
                // Malformed event line — treat as regular stderr
                appendOutput(Buffer.from(line + "\n"))
              }
            } else {
              // Regular stderr — include in output
              appendOutput(Buffer.from(line + "\n"))
            }
          }
        })

        // Flush remaining buffer on close
        proc.on("close", () => {
          if (stderrBuffer) {
            if (stderrBuffer.startsWith(EVENT_PREFIX)) {
              try {
                const event = JSON.parse(stderrBuffer.slice(EVENT_PREFIX.length)) as SubAgentEvent
                emitSubAgentEvent(ctx.sessionId, ctx.messageId, parentCallId, subAgentProfile!, event)
              } catch {
                appendOutput(Buffer.from(stderrBuffer))
              }
            } else {
              appendOutput(Buffer.from(stderrBuffer))
            }
            stderrBuffer = ""
          }
        })
      } else {
        // Regular command — stderr goes to output like before
        proc.stderr?.on("data", appendOutput)
      }

      // Timeout handling
      const timer = setTimeout(() => {
        killed = true
        proc.kill("SIGTERM")
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL")
        }, 5000)
      }, timeout)

      // Abort signal handling
      const onAbort = () => {
        killed = true
        proc.kill("SIGTERM")
      }
      ctx.abort.addEventListener("abort", onAbort, { once: true })

      proc.on("close", (code) => {
        clearTimeout(timer)
        ctx.abort.removeEventListener("abort", onAbort)

        // Truncate if needed
        let finalOutput = output
        if (output.length >= MAX_OUTPUT) {
          finalOutput =
            output.slice(0, MAX_OUTPUT) +
            `\n\n... (output truncated at ${MAX_OUTPUT} bytes)`
        }

        if (killed) {
          finalOutput += "\n\n(process killed — timeout or abort)"
        }

        resolve({
          title: `bash: ${args.command.slice(0, 80)}`,
          output: finalOutput || "(no output)",
          metadata: {
            command: args.command,
            exitCode: code,
            killed,
            truncated: output.length >= MAX_OUTPUT,
            ...(isSubAgent ? { isSubAgent: true, subAgentProfile } : {}),
          },
        })
      })

      proc.on("error", (err: Error) => {
        clearTimeout(timer)
        ctx.abort.removeEventListener("abort", onAbort)
        resolve({
          title: `bash error: ${args.command.slice(0, 80)}`,
          output: `Failed to execute command: ${err.message}`,
          metadata: {
            command: args.command,
            error: err.message,
          },
        })
      })
    })
  },
}

// ---------------------------------------------------------------------------
// Forward parsed sub-agent events to the parent's event bus
// ---------------------------------------------------------------------------

function emitSubAgentEvent(
  sessionId: string,
  messageId: string,
  parentCallId: string | undefined,
  profile: string,
  event: SubAgentEvent,
) {
  switch (event.e) {
    case "tool-start":
      bus.emit("subagent-tool-start", {
        sessionId,
        messageId,
        parentCallId: parentCallId ?? "",
        profile,
        tool: event.t,
        callId: event.id,
      })
      break

    case "tool-input":
      bus.emit("subagent-tool-input", {
        sessionId,
        messageId,
        parentCallId: parentCallId ?? "",
        profile,
        tool: event.t,
        callId: event.id,
        input: event.in,
      })
      break

    case "tool-end":
      bus.emit("subagent-tool-end", {
        sessionId,
        messageId,
        parentCallId: parentCallId ?? "",
        profile,
        tool: event.t,
        callId: event.id,
        status: event.s,
        error: event.err,
      })
      break

    case "step-finish":
      bus.emit("subagent-step-finish", {
        sessionId,
        messageId,
        parentCallId: parentCallId ?? "",
        profile,
        tokens: event.tokens,
        tokenLimit: event.tokenLimit,
      })
      break

    case "text-delta":
      bus.emit("subagent-text-delta", {
        sessionId,
        messageId,
        parentCallId: parentCallId ?? "",
        profile,
        text: event.d,
      })
      break

    case "loop-end":
      bus.emit("subagent-done", {
        sessionId,
        messageId,
        parentCallId: parentCallId ?? "",
        profile,
      })
      break
  }
}
