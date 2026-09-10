// Sanitized, decoupled telemetry contract.
// This module deliberately does not consume the agent event bus or message data.

export interface TelemetryTokenCounts {
  input?: number
  inputNoCache?: number
  output?: number
  outputText?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
}

export interface TelemetryDiagnostics {
  provider?: string
  model?: string
  tokens?: TelemetryTokenCounts
}

type WithDiagnostics<T> = T & TelemetryDiagnostics

export interface TelemetryPayloads {
  "run.start": WithDiagnostics<{ sessionId: string; resumed: boolean }>
  "run.end": WithDiagnostics<{ sessionId: string; status: "completed" | "aborted" | "error"; durationMs: number }>
  "loop.start": WithDiagnostics<{ sessionId: string }>
  "loop.end": WithDiagnostics<{ sessionId: string }>
  "step.start": WithDiagnostics<{ sessionId: string; step: number }>
  "step.end": WithDiagnostics<{ sessionId: string; step: number; result: "stop" | "continue" | "branch" }>
  "tool.start": WithDiagnostics<{ sessionId: string; tool: string; callId: string }>
  "tool.end": WithDiagnostics<{ sessionId: string; tool: string; callId: string; status: "completed" | "error" }>
  retry: WithDiagnostics<{ sessionId: string; attempt: number; delayMs: number }>
  error: WithDiagnostics<{ sessionId: string; kind: "provider" | "tool" | "branch" | "unknown" }>
}

export interface TelemetryConfig {
  diagnostic: boolean
}

let telemetryConfig: TelemetryConfig = { diagnostic: false }

/** Configure optional metadata capture. Raw content is never part of this contract. */
export function configureTelemetry(config: Partial<TelemetryConfig>): void {
  if (typeof config.diagnostic === "boolean") telemetryConfig.diagnostic = config.diagnostic
}

export function isTelemetryDiagnosticModeEnabled(): boolean {
  return telemetryConfig.diagnostic
}

export type TelemetryEventName = keyof TelemetryPayloads

export const TELEMETRY_SCHEMA_VERSION = 1 as const

export type TelemetryEvent = {
  [K in TelemetryEventName]: TelemetryPayloads[K] & {
    schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
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
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
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
  const value = payload as unknown as TelemetryDiagnostics & Record<string, unknown>
  const diagnostics = sanitizeDiagnostics(value)
  switch (name) {
    case "run.start":
      return { sessionId: value.sessionId, resumed: value.resumed, ...diagnostics } as TelemetryPayloads[K]
    case "run.end":
      return { sessionId: value.sessionId, status: value.status, durationMs: value.durationMs, ...diagnostics } as TelemetryPayloads[K]
    case "loop.start":
    case "loop.end":
      return { sessionId: value.sessionId, ...diagnostics } as TelemetryPayloads[K]
    case "step.start":
      return { sessionId: value.sessionId, step: value.step, ...diagnostics } as TelemetryPayloads[K]
    case "step.end":
      return { sessionId: value.sessionId, step: value.step, result: value.result, ...diagnostics } as TelemetryPayloads[K]
    case "tool.start":
      return { sessionId: value.sessionId, tool: value.tool, callId: value.callId, ...diagnostics } as TelemetryPayloads[K]
    case "tool.end":
      return { sessionId: value.sessionId, tool: value.tool, callId: value.callId, status: value.status, ...diagnostics } as TelemetryPayloads[K]
    case "retry":
      return { sessionId: value.sessionId, attempt: value.attempt, delayMs: value.delayMs, ...diagnostics } as TelemetryPayloads[K]
    case "error":
      return { sessionId: value.sessionId, kind: value.kind, ...diagnostics } as TelemetryPayloads[K]
  }
}

function sanitizeDiagnostics(value: TelemetryDiagnostics): TelemetryDiagnostics {
  if (!telemetryConfig.diagnostic) return {}
  const diagnostics: TelemetryDiagnostics = {}
  if (safeIdentifier(value.provider)) diagnostics.provider = value.provider
  if (safeIdentifier(value.model)) diagnostics.model = value.model
  if (value.tokens && typeof value.tokens === "object") {
    const tokens: TelemetryTokenCounts = {}
    for (const key of ["input", "inputNoCache", "output", "outputText", "reasoning", "cacheRead", "cacheWrite", "total"] as const) {
      const token = value.tokens[key]
      if (typeof token === "number" && Number.isFinite(token) && token >= 0) tokens[key] = token
    }
    if (Object.keys(tokens).length) diagnostics.tokens = tokens
  }
  return diagnostics
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_./:@+\\-]{1,256}$/.test(value)
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
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  name: string
  timestamp: number
  attributes: Readonly<Record<string, TelemetryAttribute>>
}

export interface TelemetrySpan {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
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
        Object.assign(root.attributes, diagnosticAttributes(event))
        break
      }
      case "run.end": {
        const root = rootFor(event)
        finish(root, timestamp, event.status === "completed" ? "ok" : "error", { status: event.status, duration_ms: event.durationMs, ...diagnosticAttributes(event) })
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
        const step = makeSpan(event.runId, "step", timestamp, parentFor(event).spanId, { step: event.step, session_id: event.sessionId, ...diagnosticAttributes(event) })
        steps.set(stepKey(event.sessionId, event.step), step)
        break
      }
      case "step.end": {
        const key = stepKey(event.sessionId, event.step)
        const step = steps.get(key) ?? makeSpan(event.runId, "step", timestamp, parentFor(event).spanId, { step: event.step, session_id: event.sessionId })
        finish(step, timestamp, event.result === "stop" ? "ok" : "unset", { result: event.result, ...diagnosticAttributes(event) })
        steps.delete(key)
        break
      }
      case "tool.start": {
        const tool = makeSpan(event.runId, "tool", timestamp, activeStep(event.runId, event.sessionId)?.spanId ?? parentFor(event).spanId, { tool: event.tool, session_id: event.sessionId, ...diagnosticAttributes(event) })
        tools.set(toolKey(event.callId), tool)
        break
      }
      case "tool.end": {
        const key = toolKey(event.callId)
        const tool = tools.get(key) ?? makeSpan(event.runId, "tool", timestamp, activeStep(event.runId, event.sessionId)?.spanId ?? parentFor(event).spanId, { tool: event.tool, session_id: event.sessionId })
        finish(tool, timestamp, event.status === "error" ? "error" : "ok", { status: event.status, ...diagnosticAttributes(event) })
        tools.delete(key)
        break
      }
      case "retry": {
        const retry = makeSpan(event.runId, "retry", timestamp, activeStep(event.runId, event.sessionId)?.spanId ?? parentFor(event).spanId, { attempt: event.attempt, delay_ms: event.delayMs, session_id: event.sessionId, ...diagnosticAttributes(event) })
        finish(retry, timestamp, "unset")
        break
      }
      case "error": {
        const parent = activeStep(event.runId, event.sessionId) ?? loops.get(event.runId) ?? rootFor(event)
        parent.events.push({ schemaVersion: TELEMETRY_SCHEMA_VERSION, name: "error", timestamp, attributes: { kind: event.kind, session_id: event.sessionId, ...diagnosticAttributes(event) } })
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
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    attributes: Object.freeze({ ...span.attributes }),
    events: Object.freeze(span.events.map((event) => ({ ...event, schemaVersion: TELEMETRY_SCHEMA_VERSION, attributes: Object.freeze({ ...event.attributes }) }))),
  }
}

function diagnosticAttributes(value: TelemetryDiagnostics): Record<string, TelemetryAttribute> {
  const diagnostics = sanitizeDiagnostics(value)
  const tokens = diagnostics.tokens
  return {
    ...(diagnostics.provider ? { provider: diagnostics.provider } : {}),
    ...(diagnostics.model ? { model: diagnostics.model } : {}),
    ...(tokens?.input !== undefined ? { tokens_input: tokens.input } : {}),
    ...(tokens?.inputNoCache !== undefined ? { tokens_input_no_cache: tokens.inputNoCache } : {}),
    ...(tokens?.output !== undefined ? { tokens_output: tokens.output } : {}),
    ...(tokens?.outputText !== undefined ? { tokens_output_text: tokens.outputText } : {}),
    ...(tokens?.reasoning !== undefined ? { tokens_reasoning: tokens.reasoning } : {}),
    ...(tokens?.cacheRead !== undefined ? { tokens_cache_read: tokens.cacheRead } : {}),
    ...(tokens?.cacheWrite !== undefined ? { tokens_cache_write: tokens.cacheWrite } : {}),
    ...(tokens?.total !== undefined ? { tokens_total: tokens.total } : {}),
  }
}

function safeTimestamp(timestamp: number): number { return Number.isFinite(timestamp) ? timestamp : Date.now() }
function stepKey(sessionId: string, step: number): string { return `${sessionId}:${step}` }
function toolKey(callId: string): string { return callId }

export const createTelemetrySpanAdapter = createSpanTelemetryAdapter
