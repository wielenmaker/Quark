import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { bus } from "../session/events"
import type { ToolContext } from "../tool/tool"
import { resolveSubagentCommand, type SubagentCommand } from "./executable"
import {
  SUBAGENT_EVENT_PREFIX,
  parseChildEventLine,
  type ChildEvent,
  type SubagentErrorKind,
} from "./protocol"

const MAX_OUTPUT = 50_000
const TERMINATION_GRACE_MS = 5_000

export interface SubagentRunResult {
  output: string
  childSessionId?: string
  modelName?: string
  tokenLimit?: number
}

export class SubagentExecutionError extends Error {
  constructor(
    public readonly kind: SubagentErrorKind,
    message: string,
  ) {
    super(message)
    this.name = "SubagentExecutionError"
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

export async function runSubagent(
  input: { profile: string; prompt: string },
  ctx: ToolContext,
  /** Explicit child command; hosts resolve their own executable and pass it. */
  executable?: SubagentCommand,
): Promise<SubagentRunResult> {
  if (ctx.abort.aborted) {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
  }
  const eventBus = ctx.bus ?? bus
  const runtime = executable ?? resolveSubagentCommand()
  const childArgs = [
    ...runtime.args,
    "--agent", input.profile,
    "--message", input.prompt,
    "--no-store",
  ]

  return new Promise<SubagentRunResult>((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(runtime.command, childArgs, {
        cwd: ctx.workspace ?? process.cwd(),
        env: {
          ...process.env,
          QUARK_PARENT_SESSION_ID: ctx.sessionId,
          QUARK_EMIT_EVENTS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      reject(new SubagentExecutionError("process", `Failed to start subagent: ${messageOf(error)}`))
      return
    }

    const base = {
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      parentCallId: ctx.callId,
      profile: input.profile,
    }
    let stdout = ""
    let diagnostics = ""
    let stderrBuffer = ""
    let childSessionId: string | undefined
    let modelName: string | undefined
    let tokenLimit: number | undefined
    // The child now streams honest deltas. Keep the running text for in-process
    // consumers (TUI/web read `text` as a SET), while also forwarding the raw
    // chunk as `delta` so the live log can coalesce it and stay O(content).
    let textBuffer = ""
    let structuredError: SubagentExecutionError | undefined
    let sawLoopEnd = false
    let settled = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

    const append = (target: "stdout" | "diagnostics", text: string) => {
      if (target === "stdout") {
        if (stdout.length < MAX_OUTPUT) stdout += text.slice(0, MAX_OUTPUT - stdout.length)
      } else if (diagnostics.length < MAX_OUTPUT) {
        diagnostics += text.slice(0, MAX_OUTPUT - diagnostics.length)
      }
    }

    const failStructured = (kind: SubagentErrorKind, message: string) => {
      structuredError = structuredError ?? new SubagentExecutionError(kind, message)
      eventBus.emit("subagent-error", { ...base, kind, message })
    }

    const forward = (event: ChildEvent) => {
      switch (event.e) {
        case "ready":
          childSessionId = event.sessionId
          modelName = event.model
          tokenLimit = event.tokenLimit
          break
        case "tool-start":
          eventBus.emit("subagent-tool-start", { ...base, tool: event.t, callId: event.id })
          break
        case "tool-input":
          eventBus.emit("subagent-tool-input", { ...base, tool: event.t, callId: event.id, input: event.in })
          break
        case "tool-running":
          eventBus.emit("subagent-tool-running", { ...base, callId: event.id })
          break
        case "tool-end":
          eventBus.emit("subagent-tool-end", {
            ...base,
            tool: event.t,
            callId: event.id,
            status: event.s,
            ...(event.err ? { error: event.err } : {}),
          })
          break
        case "step-finish":
          modelName = event.model ?? modelName
          tokenLimit = event.tokenLimit ?? tokenLimit
          eventBus.emit("subagent-step-finish", {
            ...base,
            tokens: event.tokens,
            tokenLimit: event.tokenLimit,
            modelName: event.model,
          })
          break
        case "text-delta":
          textBuffer += event.d
          eventBus.emit("subagent-text-delta", { ...base, text: textBuffer, delta: event.d })
          break
        case "error":
          failStructured(event.kind, event.message)
          break
        case "loop-end":
          sawLoopEnd = true
          eventBus.emit("subagent-done", base)
          break
      }
    }

    const handleLine = (line: string, outputTarget: "stdout" | "diagnostics") => {
      if (!line.startsWith(SUBAGENT_EVENT_PREFIX)) {
        append(outputTarget, `${line}\n`)
        return
      }
      try {
        const event = parseChildEventLine(line)
        if (event) forward(event)
      } catch (error) {
        failStructured("protocol", `Malformed subagent event: ${messageOf(error)}`)
      }
    }

    const consumeStderr = (chunk: Buffer) => {
      const lines = `${stderrBuffer}${chunk.toString()}`.split("\n")
      stderrBuffer = lines.pop() ?? ""
      for (const line of lines) handleLine(line, "diagnostics")
    }

    // stdout is exclusively the child's model answer. Protocol is accepted only
    // from stderr so model-generated text cannot forge lifecycle events.
    proc.stdout.on("data", (chunk: Buffer) => append("stdout", chunk.toString()))
    proc.stderr.on("data", consumeStderr)

    const terminate = () => {
      if (settled || proc.exitCode !== null || proc.signalCode !== null) return
      proc.kill("SIGTERM")
      forceKillTimer = setTimeout(() => {
        if (!settled && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
      }, TERMINATION_GRACE_MS)
    }
    ctx.abort.addEventListener("abort", terminate, { once: true })
    if (ctx.abort.aborted) terminate()

    proc.once("error", (error) => {
      failStructured("process", `Failed to run subagent: ${error.message}`)
    })

    proc.once("close", (code, signal) => {
      settled = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      ctx.abort.removeEventListener("abort", terminate)
      if (stderrBuffer) handleLine(stderrBuffer, "diagnostics")

      if (ctx.abort.aborted) {
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
        return
      }
      if (code !== 0 && !structuredError) {
        const detail = diagnostics.trim()
        failStructured(
          "process",
          `Subagent exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`,
        )
      }
      if (!sawLoopEnd && code === 0 && !structuredError) {
        failStructured("protocol", "Subagent exited without a completion event")
      }
      if (structuredError) {
        reject(structuredError)
        return
      }
      resolve({
        output: stdout.trim() || "(subagent returned no text)",
        childSessionId,
        modelName,
        tokenLimit,
      })
    })
  })
}
