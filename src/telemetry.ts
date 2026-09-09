// Sanitized, decoupled telemetry contract.
// This module deliberately does not consume the agent event bus or message data.

export interface TelemetryPayloads {
  "run.start": { sessionId: string; resumed: boolean }
  "run.end": { sessionId: string; status: "completed" | "aborted" | "error"; durationMs: number }
  "loop.start": { sessionId: string }
  "loop.end": { sessionId: string }
  "step.start": { sessionId: string; step: number }
  "step.end": { sessionId: string; step: number; result: "stop" | "continue" | "branch" }
  "tool.start": { sessionId: string; tool: string; callId: string }
  "tool.end": { sessionId: string; tool: string; callId: string; status: "completed" | "error" }
  retry: { sessionId: string; attempt: number; delayMs: number }
  error: { sessionId: string; kind: "provider" | "tool" | "branch" | "unknown" }
}

export type TelemetryEventName = keyof TelemetryPayloads

export type TelemetryEvent = {
  [K in TelemetryEventName]: TelemetryPayloads[K] & {
    name: K
    runId: string
    timestamp: number
  }
}[TelemetryEventName]

export interface TelemetryAdapter {
  emit(event: TelemetryEvent): void | Promise<void>
  flush?(): void | Promise<void>
}

const adapters = new Set<TelemetryAdapter>()
const pending = new Set<Promise<void>>()

/** Register an adapter. Its failures are intentionally isolated from the agent. */
export function registerTelemetryAdapter(adapter: TelemetryAdapter): () => void {
  adapters.add(adapter)
  return () => adapters.delete(adapter)
}

/** Emit only allowlisted, metadata-only telemetry. This never waits for adapters. */
export function emitTelemetry<K extends TelemetryEventName>(
  runId: string,
  name: K,
  payload: TelemetryPayloads[K],
): void {
  // Copy only the contract fields. Extra properties supplied by an untyped caller
  // must not accidentally become telemetry content.
  const safePayload = sanitizePayload(name, payload)
  const event = {
    name,
    runId,
    timestamp: Date.now(),
    ...safePayload,
  } as TelemetryEvent

  for (const adapter of adapters) {
    const task = Promise.resolve()
      .then(() => adapter.emit(event))
      .catch(() => {})
    pending.add(task)
    task.then(() => pending.delete(task))
  }
}

/** Flush queued adapter work without allowing shutdown to wait indefinitely. */
export async function flushTelemetry(timeoutMs = 250): Promise<void> {
  const work = Promise.all([...pending]).then(async () => {
    await Promise.all([...adapters].map((adapter) =>
      Promise.resolve().then(() => adapter.flush?.()).catch(() => {}),
    ))
  })
  await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}

/** Useful for isolated runtimes and tests. */
export function clearTelemetryAdapters(): void {
  adapters.clear()
  pending.clear()
}

function sanitizePayload<K extends TelemetryEventName>(
  name: K,
  payload: TelemetryPayloads[K],
): TelemetryPayloads[K] {
  switch (name) {
    case "run.start":
      return { sessionId: (payload as TelemetryPayloads["run.start"]).sessionId, resumed: (payload as TelemetryPayloads["run.start"]).resumed } as TelemetryPayloads[K]
    case "run.end": {
      const value = payload as TelemetryPayloads["run.end"]
      return { sessionId: value.sessionId, status: value.status, durationMs: value.durationMs } as TelemetryPayloads[K]
    }
    case "loop.start":
    case "loop.end":
      return { sessionId: (payload as { sessionId: string }).sessionId } as TelemetryPayloads[K]
    case "step.start":
      return { sessionId: (payload as TelemetryPayloads["step.start"]).sessionId, step: (payload as TelemetryPayloads["step.start"]).step } as TelemetryPayloads[K]
    case "step.end": {
      const value = payload as TelemetryPayloads["step.end"]
      return { sessionId: value.sessionId, step: value.step, result: value.result } as TelemetryPayloads[K]
    }
    case "tool.start": {
      const value = payload as TelemetryPayloads["tool.start"]
      return { sessionId: value.sessionId, tool: value.tool, callId: value.callId } as TelemetryPayloads[K]
    }
    case "tool.end": {
      const value = payload as TelemetryPayloads["tool.end"]
      return { sessionId: value.sessionId, tool: value.tool, callId: value.callId, status: value.status } as TelemetryPayloads[K]
    }
    case "retry": {
      const value = payload as TelemetryPayloads["retry"]
      return { sessionId: value.sessionId, attempt: value.attempt, delayMs: value.delayMs } as TelemetryPayloads[K]
    }
    case "error":
      return { sessionId: (payload as TelemetryPayloads["error"]).sessionId, kind: (payload as TelemetryPayloads["error"]).kind } as TelemetryPayloads[K]
  }
}

export function createRunId(): string {
  return crypto.randomUUID()
}

export type RunStatus = TelemetryPayloads["run.end"]["status"]

export function telemetryErrorKind(error: unknown): TelemetryPayloads["error"]["kind"] {
  if (error && typeof error === "object") {
    const value = error as { kind?: unknown; name?: unknown }
    if (value.kind === "tool" || value.name === "ToolError") return "tool"
    if (value.kind === "branch") return "branch"
  }
  return "provider"
}

export type TelemetryAttribute = string | number | boolean

export interface TelemetrySpanEvent {
  name: string
  timestamp: number
  attributes: Readonly<Record<string, TelemetryAttribute>>
}

export interface TelemetrySpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: number
  endTime: number
  status: "ok" | "error" | "unset"
  attributes: Readonly<Record<string, TelemetryAttribute>>
  events: readonly TelemetrySpanEvent[]
}

export interface TelemetrySpanExporter {
  export(spans: readonly TelemetrySpan[]): void | Promise<void>
  flush?(): void | Promise<void>
}

export type TelemetryTransport = (spans: readonly TelemetrySpan[]) => void | Promise<void>

/** Converts sanitized lifecycle events into completed spans without observing the event bus. */
export function createSpanTelemetryAdapter(
  exporter: TelemetrySpanExporter | TelemetryTransport,
): TelemetryAdapter {
  const roots = new Map<string, MutableSpan>()
  const loops = new Map<string, MutableSpan>()
  const steps = new Map<string, MutableSpan>()
  const tools = new Map<string, MutableSpan>()
  const pending = new Set<Promise<void>>()

  const send = (span: MutableSpan) => {
    const record = freezeSpan(span)
    const task = Promise.resolve()
      .then(() => typeof exporter === "function" ? exporter([record]) : exporter.export([record]))
      .catch(() => {})
    pending.add(task)
    task.then(() => pending.delete(task))
  }

  const rootFor = (event: TelemetryEvent): MutableSpan => {
    let root = roots.get(event.runId)
    if (!root) {
      root = makeSpan(event.runId, "run", event.timestamp)
      roots.set(event.runId, root)
    }
    return root
  }

  const parentFor = (event: TelemetryEvent): MutableSpan =>
    event.name === "loop.start" || event.name === "loop.end"
      ? rootFor(event)
      : loops.get(event.runId) ?? rootFor(event)

  const finish = (
    span: MutableSpan,
    timestamp: number,
    status: TelemetrySpan["status"],
    attributes: Record<string, TelemetryAttribute> = {},
  ) => {
    if (span.endTime !== undefined) return
    span.endTime = Math.max(span.startTime, safeTimestamp(timestamp))
    span.status = status
    Object.assign(span.attributes, attributes)
    send(span)
  }

  const activeStep = (runId: string, sessionId: string): MutableSpan | undefined => {
    for (const step of steps.values()) {
      if (step.traceId === runId && step.attributes.session_id === sessionId) return step
    }
    return undefined
  }

  const emit: TelemetryAdapter["emit"] = (event) => {
    const timestamp = safeTimestamp(event.timestamp)
    switch (event.name) {
      case "run.start": {
        const root = rootFor(event)
        root.startTime = Math.min(root.startTime, timestamp)
        root.attributes.resumed = event.resumed
        break
      }
      case "run.end": {
        const root = rootFor(event)
        finish(root, timestamp, event.status === "completed" ? "ok" : "error", { status: event.status, duration_ms: event.durationMs })
        roots.delete(event.runId)
        break
      }
      case "loop.start": {
        const loop = makeSpan(event.runId, "loop", timestamp, rootFor(event).spanId)
        loops.set(event.runId, loop)
        break
      }
      case "loop.end": {
        const loop = loops.get(event.runId)
        if (loop) { finish(loop, timestamp, "ok"); loops.delete(event.runId) }
        break
      }
      case "step.start": {
        const step = makeSpan(event.runId, "step", timestamp, parentFor(event).spanId, { step: event.step, session_id: event.sessionId })
        steps.set(stepKey(event.sessionId, event.step), step)
        break
      }
      case "step.end": {
        const key = stepKey(event.sessionId, event.step)
        const step = steps.get(key) ?? makeSpan(event.runId, "step", timestamp, parentFor(event).spanId, { step: event.step, session_id: event.sessionId })
        finish(step, timestamp, event.result === "stop" ? "ok" : "unset", { result: event.result })
        steps.delete(key)
        break
      }
      case "tool.start": {
        const tool = makeSpan(event.runId, "tool", timestamp, activeStep(event.runId, event.sessionId)?.spanId ?? parentFor(event).spanId, { tool: event.tool, session_id: event.sessionId })
        tools.set(toolKey(event.callId), tool)
        break
      }
      case "tool.end": {
        const key = toolKey(event.callId)
        const tool = tools.get(key) ?? makeSpan(event.runId, "tool", timestamp, activeStep(event.runId, event.sessionId)?.spanId ?? parentFor(event).spanId, { tool: event.tool, session_id: event.sessionId })
        finish(tool, timestamp, event.status === "error" ? "error" : "ok", { status: event.status })
        tools.delete(key)
        break
      }
      case "retry": {
        const retry = makeSpan(event.runId, "retry", timestamp, activeStep(event.runId, event.sessionId)?.spanId ?? parentFor(event).spanId, { attempt: event.attempt, delay_ms: event.delayMs, session_id: event.sessionId })
        finish(retry, timestamp, "unset")
        break
      }
      case "error": {
        const parent = activeStep(event.runId, event.sessionId) ?? loops.get(event.runId) ?? rootFor(event)
        parent.events.push({ name: "error", timestamp, attributes: { kind: event.kind, session_id: event.sessionId } })
        break
      }
    }
  }

  const flush = async () => {
    await Promise.all([...pending])
    await Promise.resolve(typeof exporter === "function" ? undefined : exporter.flush?.()).catch(() => {})
  }

  return { emit, flush }
}

type MutableSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: number
  endTime?: number
  status: TelemetrySpan["status"]
  attributes: Record<string, TelemetryAttribute>
  events: TelemetrySpanEvent[]
}

function makeSpan(traceId: string, name: string, startTime: number, parentSpanId?: string, attributes: Record<string, TelemetryAttribute> = {}): MutableSpan {
  return { traceId, spanId: createRunId(), ...(parentSpanId ? { parentSpanId } : {}), name, startTime: safeTimestamp(startTime), status: "unset", attributes, events: [] }
}

function freezeSpan(span: MutableSpan): TelemetrySpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    startTime: span.startTime,
    endTime: span.endTime ?? span.startTime,
    status: span.status,
    attributes: Object.freeze({ ...span.attributes }),
    events: Object.freeze(span.events.map((event) => ({ ...event, attributes: Object.freeze({ ...event.attributes }) }))),
  }
}

function safeTimestamp(timestamp: number): number { return Number.isFinite(timestamp) ? timestamp : Date.now() }
function stepKey(sessionId: string, step: number): string { return `${sessionId}:${step}` }
function toolKey(callId: string): string { return callId }

export const createTelemetrySpanAdapter = createSpanTelemetryAdapter
