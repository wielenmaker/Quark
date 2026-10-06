// Tool: bash — execute shell commands
//
// When the command is a `quark --sub-agent` invocation, uses spawn() with
// line-by-line stderr parsing to forward structured QUARK_EVENT: lines to
// the parent's event bus, enabling real-time sub-agent observability in TUI.

import { spawn } from "child_process"
import { appendFileSync } from "fs"
import { z } from "zod"

const EVENT_PREFIX = "QUARK_EVENT:"
const MAX_OUTPUT = 50_000

/** Truncate output to prevent TUI crashes from massive tool results. */
function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  return text.slice(0, MAX_OUTPUT) + `\n\n... (truncated — ${text.length} bytes total)`
}

// Debug log to file (the TUI captures stderr). Opt-in only: writing this on
// every call would grow /tmp without bound.
function debugLog(msg: string) {
  if (!process.env.QUARK_BASH_DEBUG) return
  try {
    appendFileSync("/tmp/quark-bash-debug.log", `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // diagnostics must never break a tool call
  }
}

/** Detect whether a command spawns a quark sub-agent */
function isSubAgentCommand(command: string): boolean {
  return /\bquark\b.*--sub-agent\b/.test(command)
}

/**
 * Strip stderr-to-stdout redirects (`2>&1`) from a command.
 *
 * When `2>&1` is present, the shell merges stderr into stdout.
 * Sub-agent events are written to stderr via QUARK_EVENT: prefix —
 * the redirect would cause the parent to never see them on the stderr pipe,
 * breaking SubAgentView rendering.
 */
function stripStderrRedirect(command: string): string {
  return command.replace(/\s+2>&1\b/g, "")
}

export default {
  id: "bash",
  description: `Execute a bash command in the shell. Use for running CLI tools, git commands, npm, etc. When you should NOT use it:
  - Reading files → use Read tool instead of cat
  - Searching files → use Grep instead of grep/rg
  - Finding files → use Glob instead of find
  - Editing files → use Edit instead of sed/awk
  - Creating files → use Write instead of echo >`,
  parameters: z.object({
    command: z.string().describe("The bash command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 30000)"),
  }),
  async execute(args: { command: string; timeout?: number }, ctx?: any) {
    const { command, timeout: explicitTimeout } = args
    const cwd = ctx?.workspace ?? process.cwd()
    const isSubAgent = isSubAgentCommand(command)

    // Sub-agent commands get a much longer default timeout (10 minutes)
    // Regular commands default to 30s
    const timeout = explicitTimeout ?? (isSubAgent ? 600_000 : 30_000)

    // Sub-agent commands use spawn() for real-time stderr event parsing
    if (isSubAgent) {
      debugLog(`Sub-agent detected, ctx.callId=${ctx?.callId}, sessionId=${ctx?.sessionId}, messageId=${ctx?.messageId}`)
      return executeSubAgent(command, cwd, timeout, ctx)
    }

    // Regular commands stream their output (spawn), so a client can watch the
    // command run instead of seeing the result only at the end.
    return executeStreaming(command, cwd, timeout, ctx)
  },
}

// ---------------------------------------------------------------------------
// Regular execution — spawn with streaming output
// ---------------------------------------------------------------------------

/** Throttle for bus emissions: at most one `tool-output-delta` per this window. */
const OUTPUT_FLUSH_MS = 100

/**
 * Run a regular command with `spawn`, forwarding output chunks on the runner
 * bus as `tool-output-delta` (display-only) while collecting the same capped
 * result the tool has always returned. The result is unchanged by streaming;
 * a client that ignores the event sees exactly the old behavior.
 */
function executeStreaming(command: string, cwd: string, timeout: number, ctx?: any) {
  const bus: any = ctx?.bus ?? null
  const sessionId = ctx?.sessionId ?? ""
  const messageId = ctx?.messageId ?? ""
  const callId = ctx?.callId ?? ""

  return new Promise<any>((resolve, reject) => {
    let output = ""
    let pending = ""
    let truncated = false
    let killed = false
    let exited = false
    let lastFlush = 0

    const append = (text: string) => {
      if (output.length >= MAX_OUTPUT) {
        truncated = true
        return
      }
      const room = MAX_OUTPUT - output.length
      if (text.length > room) {
        truncated = true
        text = text.slice(0, room)
      }
      output += text
      pending += text
    }

    const flush = (force = false) => {
      if (!pending) return
      const now = Date.now()
      if (!force && now - lastFlush < OUTPUT_FLUSH_MS) return
      if (bus) {
        bus.emit("tool-output-delta", { sessionId, messageId, callId, delta: pending })
      }
      pending = ""
      lastFlush = now
    }

    const proc = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: {
        ...process.env,
        ...(sessionId ? { QUARK_SESSION_ID: sessionId } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    proc.stdout?.on("data", (chunk: Buffer) => {
      append(chunk.toString())
      flush()
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      append(chunk.toString())
      flush()
    })

    // Throttled deltas can leave a trailing chunk pending; this flushes it
    // while the command is still running instead of waiting for exit.
    const ticker = setInterval(() => flush(), OUTPUT_FLUSH_MS)

    const killHard = () => {
      // `proc.killed` only reports that kill() was called; the process can
      // still ignore SIGTERM, so fall back to SIGKILL on the real exit flag.
      setTimeout(() => {
        if (!exited) proc.kill("SIGKILL")
      }, 5000)
    }
    const timer = setTimeout(() => {
      killed = true
      proc.kill("SIGTERM")
      killHard()
    }, timeout)

    const onAbort = () => {
      killed = true
      proc.kill("SIGTERM")
      killHard()
    }
    if (ctx?.abort) {
      ctx.abort.addEventListener("abort", onAbort, { once: true })
    }

    proc.on("close", (code) => {
      exited = true
      clearTimeout(timer)
      clearInterval(ticker)
      if (ctx?.abort) {
        ctx.abort.removeEventListener("abort", onAbort)
      }
      flush(true)

      let finalOutput = output
      if (truncated || killed || (code !== 0 && !killed)) {
        // The notes below read as their own paragraph, not glued to output.
        finalOutput = finalOutput.replace(/\n+$/, "")
      }
      if (truncated) {
        finalOutput += `\n\n... (truncated at ${MAX_OUTPUT} bytes)`
      }
      if (killed) {
        finalOutput += "\n\n(process killed — timeout or abort)"
      }

      // A nonzero exit is a FAILED tool call: rejecting makes the runner emit
      // tool-end status "error", so the card shows the red ✗ and the model gets
      // the output as an error it can react to. The output itself is preserved.
      if (code !== 0 && !killed) {
        reject(
          new Error(
            `${finalOutput || "(no output)"}\n\nCommand failed with exit code ${code}`,
          ),
        )
        return
      }

      resolve({
        title: `bash: ${command.slice(0, 50)}${command.length > 50 ? "..." : ""}`,
        output: finalOutput || "(no output)",
        metadata: { command, cwd, exitCode: code, killed },
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Sub-agent execution — spawn with streaming stderr parsing
// ---------------------------------------------------------------------------

async function executeSubAgent(
  command: string,
  cwd: string,
  timeout: number,
  ctx?: any,
) {
  // Strip 2>&1 so sub-agent events stay on the stderr pipe
  const cleanCommand = stripStderrRedirect(command)
  const profile = cleanCommand.match(/--profile\s+(\S+)/)?.[1] ?? "sub-agent"
  const parentCallId = ctx?.callId ?? ""
  const sessionId = ctx?.sessionId ?? ""
  const messageId = ctx?.messageId ?? ""

  // Use the run's own event bus. Runner-supplied tool contexts always carry
  // `bus`; the old global-singleton import path no longer exists after the
  // runner/quark split.
  const bus: any = ctx?.bus ?? null
  debugLog(bus
    ? `Bus ready, parentCallId=${parentCallId}, sessionId=${sessionId}, messageId=${messageId}`
    : `Bus UNAVAILABLE (no ctx.bus) — sub-agent events will not stream`)

  return new Promise<any>((resolve) => {
    let output = ""
    let killed = false
    const MAX_OUTPUT = 50_000

    const proc = spawn("/bin/sh", ["-c", cleanCommand], {
      cwd,
      env: {
        ...process.env,
        ...(sessionId ? { QUARK_SESSION_ID: sessionId } : {}),
        QUARK_EMIT_EVENTS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const appendOutput = (text: string) => {
      if (output.length < MAX_OUTPUT) {
        output += text
      }
    }

    // stdout: collect output, but also parse QUARK_EVENT: lines as a safety
    // net in case stderr was still redirected via some other mechanism.
    let stdoutBuffer = ""
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split("\n")
      stdoutBuffer = lines.pop() ?? ""

      for (const line of lines) {
        if (line.startsWith(EVENT_PREFIX) && bus) {
          try {
            const event = JSON.parse(line.slice(EVENT_PREFIX.length))
            forwardEvent(bus, sessionId, messageId, parentCallId, profile, event)
          } catch {
            appendOutput(line + "\n")
          }
        } else {
          appendOutput(line + "\n")
        }
      }
    })

    // stderr: parse line-by-line for QUARK_EVENT: prefix
    let stderrBuffer = ""
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
      const lines = stderrBuffer.split("\n")
      stderrBuffer = lines.pop() ?? ""

      for (const line of lines) {
        if (line.startsWith(EVENT_PREFIX) && bus) {
          try {
            const event = JSON.parse(line.slice(EVENT_PREFIX.length))
            forwardEvent(bus, sessionId, messageId, parentCallId, profile, event)
          } catch {
            appendOutput(line + "\n")
          }
        } else {
          appendOutput(line + "\n")
        }
      }
    })

    // Timeout
    const timer = setTimeout(() => {
      killed = true
      proc.kill("SIGTERM")
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL")
      }, 5000)
    }, timeout)

    // Abort
    const onAbort = () => {
      killed = true
      proc.kill("SIGTERM")
    }
    if (ctx?.abort) {
      ctx.abort.addEventListener("abort", onAbort, { once: true })
    }

    proc.on("close", (code) => {
      clearTimeout(timer)
      if (ctx?.abort) {
        ctx.abort.removeEventListener("abort", onAbort)
      }

      // Flush remaining stderr buffer
      if (stderrBuffer) {
        if (stderrBuffer.startsWith(EVENT_PREFIX) && bus) {
          try {
            const event = JSON.parse(stderrBuffer.slice(EVENT_PREFIX.length))
            forwardEvent(bus, sessionId, messageId, parentCallId, profile, event)
          } catch {
            appendOutput(stderrBuffer)
          }
        } else {
          appendOutput(stderrBuffer)
        }
        stderrBuffer = ""
      }

      // Flush remaining stdout buffer
      if (stdoutBuffer) {
        if (stdoutBuffer.startsWith(EVENT_PREFIX) && bus) {
          try {
            const event = JSON.parse(stdoutBuffer.slice(EVENT_PREFIX.length))
            forwardEvent(bus, sessionId, messageId, parentCallId, profile, event)
          } catch {
            appendOutput(stdoutBuffer)
          }
        } else {
          appendOutput(stdoutBuffer)
        }
        stdoutBuffer = ""
      }

      let finalOutput = output
      if (output.length >= MAX_OUTPUT) {
        finalOutput = output.slice(0, MAX_OUTPUT) + `\n\n... (truncated at ${MAX_OUTPUT} bytes)`
      }
      if (killed) {
        finalOutput += "\n\n(process killed — timeout or abort)"
      }

      resolve({
        title: `bash: ${command.slice(0, 50)}${command.length > 50 ? "..." : ""}`,
        output: finalOutput || "(no output)",
        metadata: {
          command,
          exitCode: code,
          killed,
          isSubAgent: true,
          subAgentProfile: profile,
        },
      })
    })

    proc.on("error", (err: Error) => {
      clearTimeout(timer)
      if (ctx?.abort) {
        ctx.abort.removeEventListener("abort", onAbort)
      }
      resolve({
        title: `bash error: ${command.slice(0, 40)}`,
        output: `Failed to execute command: ${err.message}`,
        metadata: { command, error: err.message },
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Forward parsed sub-agent events to the parent's event bus
// ---------------------------------------------------------------------------

function forwardEvent(
  bus: any,
  sessionId: string,
  messageId: string,
  parentCallId: string,
  profile: string,
  event: any,
) {
  const base = { sessionId, messageId, parentCallId, profile }
  
  // DEBUG: log every event we forward
  debugLog(`Forwarding event: ${event.e}, parentCallId=${parentCallId}, tool=${event.t || "N/A"}`)

  switch (event.e) {
    case "tool-start":
      bus.emit("subagent-tool-start", { ...base, tool: event.t, callId: event.id })
      break
    case "tool-input":
      bus.emit("subagent-tool-input", { ...base, tool: event.t, callId: event.id, input: event.in })
      break
    case "tool-end":
      bus.emit("subagent-tool-end", { ...base, tool: event.t, callId: event.id, status: event.s, error: event.err })
      break
    case "step-finish":
      bus.emit("subagent-step-finish", { ...base, tokens: event.tokens, tokenLimit: event.tokenLimit, modelName: event.model })
      break
    case "text-delta":
      bus.emit("subagent-text-delta", { ...base, text: event.d })
      break
    case "loop-end":
      bus.emit("subagent-done", base)
      break
  }
}
