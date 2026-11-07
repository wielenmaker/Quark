import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { createSession, MemorySessionStore, TypedBus, type AgentDefinition } from "@quark/runner"
import { startEventWriter } from "@quark/runner/session/event-writer"
import { SUBAGENT_EVENT_PREFIX, type ChildEvent } from "@quark/runner/subagent/protocol"
import { closeSubagents } from "@quark/runner/subagent/supervisor"
import { createQuarkRuntime, type QuarkRuntime } from "./runtime"
import { SubagentCheckpoints } from "./subagent-checkpoints"

export interface SubagentWorkerOptions {
  agent: AgentDefinition
  profile: string
  model?: string
  message?: string
  /** Test seam: use the real store/bus, with a fake provider executor. */
  createRuntime?: typeof createQuarkRuntime
}

function emit(event: ChildEvent): void {
  process.stderr.write(`${SUBAGENT_EVENT_PREFIX}${JSON.stringify(event)}\n`)
}

/** Worker lifetime is tied to its stdin pipe, not to one completed turn. */
export async function runSubagentWorker(options: SubagentWorkerOptions): Promise<void> {
  const sessionId = process.env.QUARK_SUBAGENT_SESSION_ID ?? `sa-${randomUUID()}`
  if (!/^sa-[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Invalid subagent session ID")
  const store = new MemorySessionStore()
  const bus = new TypedBus()
  createSession({ id: sessionId, kind: "subagent", directory: process.cwd(), parentSessionId: process.env.QUARK_PARENT_SESSION_ID }, store)
  const runtime: QuarkRuntime = await (options.createRuntime ?? createQuarkRuntime)({ agent: options.agent, bus, store })
  const checkpoints = new SubagentCheckpoints(process.cwd())
  const onUserMessage = ({ messageId }: { messageId: string }) => checkpoints.begin(messageId)
  bus.on("user-message", onUserMessage)
  // Registered last: capture the actual target after permission/argument hooks.
  runtime.runner.hooks.register("tool.execute.before", async ({ tool }, output) => {
    await checkpoints.capture(tool, output.args)
  })
  runtime.runner.hooks.register("loop.step.after", async ({ result }) => {
    if (result === "branch") throw new Error("Subagent context is full; start a new subagent conversation")
  })
  const cleanupWriter = startEventWriter({ resolvedModel: options.model, profile: options.profile, eventBus: bus })
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let stopped = false
  let active: Promise<void> | undefined
  let answer = ""
  let turnError: Error | undefined

  const onText = ({ delta }: { delta: string }) => {
    answer = (answer + delta).slice(0, 50_000)
    process.stdout.write(delta)
  }
  const onError = ({ error }: { error: unknown }) => { turnError = error instanceof Error ? error : new Error(String(error)) }
  bus.on("text-delta", onText)
  bus.on("error", onError)

  const stop = () => {
    if (stopped) return
    stopped = true
    runtime.cancel(sessionId)
    closeSubagents()
    input.close()
  }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  input.once("close", stop)

  async function turn(prompt: string): Promise<void> {
    answer = ""
    turnError = undefined
    try {
      await runtime.prompt({
        sessionId,
        parentSessionId: process.env.QUARK_PARENT_SESSION_ID,
        parts: [{ type: "text", text: prompt }],
        model: options.model,
        policies: { undo: false, smallModel: null, branching: { auto: false, threshold: 0.9 } },
      })
      if (turnError) throw turnError
      if (stopped) return
      const footer = `Keep talking to ${options.agent.name ?? options.profile} with ${sessionId}`
      process.stdout.write(`\n\n${footer}\n`)
      emit({ e: "result", sessionId, profile: options.profile, output: `${answer.trim() || "(subagent returned no text)"}\n\n${footer}` })
    } catch (error) {
      if (!stopped) {
        emit({ e: "error", kind: "provider", message: error instanceof Error ? error.message : String(error) })
        process.exitCode = 1
        stop()
      }
    }
  }

  const submit = (prompt: string) => {
    if (active) throw new Error("Subagent is busy")
    if (!prompt.trim()) throw new Error("Subagent prompt must not be empty")
    active = turn(prompt).finally(() => { active = undefined })
  }

  emit({ e: "ready", sessionId, profile: options.profile, model: options.model })
  input.on("line", (line) => {
    if (stopped) return
    try {
      const request: unknown = JSON.parse(line)
      if (!request || typeof request !== "object" || !("prompt" in request) || typeof request.prompt !== "string") throw new Error("Expected a JSON request with a prompt string")
      submit(request.prompt)
    } catch (error) {
      emit({ e: "error", kind: "protocol", message: error instanceof Error ? error.message : String(error) })
      process.exitCode = 1
      stop()
    }
  })
  if (options.message) submit(options.message)

  try {
    await new Promise<void>((resolve) => {
      if (stopped) resolve()
      else input.once("close", resolve)
    })
    await active
  } finally {
    stop()
    cleanupWriter()
    bus.off("text-delta", onText)
    bus.off("error", onError)
    bus.off("user-message", onUserMessage)
    checkpoints.clear()
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    store.delete(sessionId)
  }
}
