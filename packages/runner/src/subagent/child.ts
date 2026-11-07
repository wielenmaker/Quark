import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { bus } from "../session/events"
import type { ToolContext } from "../tool/tool"
import type { SubagentCommand } from "./executable"
import { abortError, SubagentExecutionError } from "./errors"
import { forwardChildEvent } from "./forward-events"
import { parseChildEventLine } from "./protocol"

const MAX_DIAGNOSTICS = 50_000
const MAX_EVENT_LINE = 2_000_000

export interface SubagentRunResult {
  output: string
  childSessionId: string
  profile: string
  modelName?: string
  tokenLimit?: number
}

interface Pending {
  ctx: ToolContext
  resolve(result: SubagentRunResult): void
  reject(error: Error): void
  abort(): void
  text: string
}

/** One long-lived child, with exactly one request in flight. */
export class SubagentChild {
  private readonly proc: ChildProcessWithoutNullStreams
  private pending?: Pending
  private buffer = ""
  private diagnostics = ""
  private readonly decoder = new StringDecoder("utf8")
  private modelName?: string
  private tokenLimit?: number
  private dead = false
  private killTimer?: ReturnType<typeof setTimeout>

  constructor(
    readonly id: string,
    readonly profile: string,
    readonly owner: string,
    readonly workspace: string,
    command: SubagentCommand,
    private readonly onClose: () => void,
  ) {
    this.proc = spawn(command.command, [...command.args, "--agent", profile, "--sub-agent"], {
      cwd: workspace,
      env: { ...process.env, QUARK_PARENT_SESSION_ID: owner, QUARK_SUBAGENT_SESSION_ID: id, QUARK_EMIT_EVENTS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    // stdout is display-only; the result event is authoritative. Separate pipes
    // can arrive in either order, so stdout must not determine turn completion.
    this.proc.stdout.on("data", () => {})
    this.proc.stderr.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)))
    this.proc.stdin.on("error", (error) => this.fail(new SubagentExecutionError("process", error.message)))
    this.proc.once("error", (error) => this.fail(new SubagentExecutionError("process", `Failed to run subagent: ${error.message}`)))
    this.proc.once("close", (code, signal) => {
      if (this.killTimer) clearTimeout(this.killTimer)
      this.dead = true
      this.onClose()
      this.finish(new SubagentExecutionError("process", `Subagent session ${id} expired (${signal ?? `exit ${code}`})${this.diagnostics ? `: ${this.diagnostics.trim()}` : ""}`))
    })
  }

  run(prompt: string, ctx: ToolContext): Promise<SubagentRunResult> {
    if (ctx.abort.aborted) return Promise.reject(abortError())
    if (this.dead) return Promise.reject(new Error(`Subagent session expired: ${this.id}`))
    if (this.pending) return Promise.reject(new Error(`Subagent session is busy: ${this.id}`))
    this.diagnostics = ""
    this.setReferenced(true)
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(abortError())
      this.pending = { ctx, resolve, reject, abort, text: "" }
      forwardChildEvent({ e: "step-finish", model: this.modelName, tokenLimit: this.tokenLimit }, ctx, this.profile, ctx.bus ?? bus, "")
      ctx.abort.addEventListener("abort", abort, { once: true })
      this.proc.stdin.write(`${JSON.stringify({ prompt })}\n`, (error) => {
        if (error) this.fail(new SubagentExecutionError("process", error.message))
      })
      if (ctx.abort.aborted) abort()
    })
  }

  close(): void {
    if (this.dead) return
    this.dead = true
    this.onClose()
    this.finish(new Error(`Subagent session closed: ${this.id}`))
    this.proc.stdin.end()
    this.proc.kill("SIGTERM")
    this.killTimer = setTimeout(() => this.proc.kill("SIGKILL"), 5_000)
    this.killTimer.unref()
    this.setReferenced(false)
  }

  private fail(error: Error): void {
    this.finish(error)
    this.close()
  }

  private finish(error?: Error, result?: SubagentRunResult): void {
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    pending.ctx.abort.removeEventListener("abort", pending.abort)
    this.setReferenced(false)
    if (error) {
      if (error instanceof SubagentExecutionError) {
        forwardChildEvent({ e: "error", kind: error.kind, message: error.message }, pending.ctx, this.profile, pending.ctx.bus ?? bus, pending.text)
      }
      pending.reject(error)
    } else pending.resolve(result!)
  }

  private setReferenced(active: boolean): void {
    if (active) this.proc.ref()
    else this.proc.unref()
    for (const stream of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) {
      const socket = stream as typeof stream & { ref?: () => void; unref?: () => void }
      if (active) socket.ref?.()
      else socket.unref?.()
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > MAX_EVENT_LINE) {
        this.fail(new SubagentExecutionError("protocol", "Subagent event exceeds size limit"))
        return
      }
      try {
        const event = parseChildEventLine(line)
        if (!event) {
          this.diagnostics = (this.diagnostics + line + "\n").slice(0, MAX_DIAGNOSTICS)
          continue
        }
        if (event.e === "ready" || event.e === "result") {
          if (event.sessionId !== this.id || event.profile !== this.profile) throw new Error("Child session identity mismatch")
        }
        if (event.e === "ready" || event.e === "step-finish") {
          this.modelName = event.model ?? this.modelName
          this.tokenLimit = event.tokenLimit ?? this.tokenLimit
        }
        if (this.pending && event.e !== "error") {
          this.pending.text = forwardChildEvent(event, this.pending.ctx, this.profile, this.pending.ctx.bus ?? bus, this.pending.text)
        }
        if (event.e === "error") {
          this.fail(new SubagentExecutionError(event.kind, event.message))
          return
        }
        if (event.e === "result") {
          if (!this.pending) throw new Error("Unexpected subagent result without a request")
          this.finish(undefined, { output: event.output, childSessionId: this.id, profile: this.profile, modelName: this.modelName, tokenLimit: this.tokenLimit })
        }
      } catch (error) {
        this.fail(new SubagentExecutionError("protocol", `Malformed subagent event: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
    }
    if (this.buffer.length > MAX_EVENT_LINE) this.fail(new SubagentExecutionError("protocol", "Subagent event exceeds size limit"))
  }
}
