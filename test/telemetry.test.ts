import { describe, expect, it } from "bun:test"
import {
  clearTelemetryAdapters,
  emitTelemetry,
  flushTelemetry,
  registerTelemetryAdapter,
  createSpanTelemetryAdapter,
  configureTelemetry,
} from "../src/telemetry"

describe("telemetry", () => {
  it("is inert without configuration or a registered adapter", async () => {
    clearTelemetryAdapters()
    expect(() => emitTelemetry("run-1", "loop.start", { sessionId: "session-1" })).not.toThrow()
    await expect(flushTelemetry()).resolves.toBeUndefined()
  })

  it("keeps every raw-content sentinel out when diagnostics are default-off", async () => {
    const events: unknown[] = []
    configureTelemetry({ diagnostic: false })
    const unregister = registerTelemetryAdapter({ emit: (event) => events.push(event) })
    const payloads: Record<string, unknown>[] = [
      { sessionId: "session-1", resumed: false },
      { sessionId: "session-1", status: "completed", durationMs: 1 },
      { sessionId: "session-1" },
      { sessionId: "session-1", step: 1 },
      { sessionId: "session-1", step: 1, result: "stop" },
      { sessionId: "session-1", tool: "read", callId: "call-1" },
      { sessionId: "session-1", tool: "read", callId: "call-1", status: "completed" },
      { sessionId: "session-1", attempt: 1, delayMs: 1 },
      { sessionId: "session-1", kind: "provider" },
    ]
    const names = ["run.start", "run.end", "loop.start", "loop.end", "step.start", "step.end", "tool.start", "tool.end", "retry", "error"] as const
    for (const [index, name] of names.entries()) {
      emitTelemetry("run-1", name, {
        ...payloads[index],
        provider: "provider-id",
        model: "model-id",
        tokens: { input: 1 },
        prompt: "sentinel prompt",
        text: "sentinel text",
        reasoning: "sentinel reasoning",
        question: "sentinel question",
        input: "sentinel tool input",
        output: "sentinel tool output",
        rawError: "sentinel raw error",
      } as never)
    }
    await flushTelemetry()
    unregister()
    clearTelemetryAdapters()

    expect(events).toHaveLength(names.length)
    for (const event of events) {
      expect(JSON.stringify(event)).not.toMatch(/sentinel (prompt|text|reasoning|question|tool input|tool output|raw error)/)
      expect(event).toHaveProperty("schemaVersion", 1)
      expect(event).not.toHaveProperty("provider")
      expect(event).not.toHaveProperty("model")
      expect(event).not.toHaveProperty("tokens")
    }
  })

  it("allows only provider/model and normalized token diagnostics when enabled", async () => {
    const events: unknown[] = []
    configureTelemetry({ diagnostic: true })
    const unregister = registerTelemetryAdapter({ emit: (event) => events.push(event) })
    emitTelemetry("run-1", "step.end", {
      sessionId: "session-1", step: 1, result: "stop",
      provider: "openai", model: "gpt-5",
      tokens: { input: 4, inputNoCache: 3, output: 2, outputText: 1, reasoning: 1, cacheRead: 1, cacheWrite: 0, total: 6, ignored: 99 } as never,
      ...( { prompt: "sentinel prompt", rawUsage: { text: "sentinel text" }, rawError: "sentinel raw error" } as never),
    })
    await flushTelemetry()
    unregister()
    configureTelemetry({ diagnostic: false })
    clearTelemetryAdapters()

    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      provider: "openai",
      model: "gpt-5",
      tokens: { input: 4, inputNoCache: 3, output: 2, outputText: 1, reasoning: 1, cacheRead: 1, cacheWrite: 0, total: 6 },
    })
    expect(Object.keys((events[0] as any).tokens)).toEqual([
      "input", "inputNoCache", "output", "outputText", "reasoning", "cacheRead", "cacheWrite", "total",
    ])
    expect(JSON.stringify(events[0])).not.toMatch(/sentinel (prompt|text|raw error)/)
    expect(events[0]).not.toHaveProperty("rawUsage")
  })

  it("maps sanitized lifecycle events to a run hierarchy", async () => {
    const spans: any[] = []
    const adapter = createSpanTelemetryAdapter((records) => spans.push(...records))
    const event = (name: any, payload: any, timestamp: number) => adapter.emit({ name, runId: "run-1", timestamp, ...payload })

    event("run.start", { sessionId: "session-1", resumed: false }, 1)
    event("loop.start", { sessionId: "session-1" }, 2)
    event("step.start", { sessionId: "session-1", step: 1 }, 3)
    event("tool.start", { sessionId: "session-1", tool: "read", callId: "call-1" }, 4)
    event("tool.end", { sessionId: "session-1", tool: "read", callId: "call-1", status: "completed" }, 5)
    event("step.end", { sessionId: "session-1", step: 1, result: "stop" }, 6)
    event("loop.end", { sessionId: "session-1" }, 7)
    event("run.end", { sessionId: "session-1", status: "completed", durationMs: 6 }, 8)
    await adapter.flush?.()

    expect(spans.map((span) => span.name)).toEqual(["tool", "step", "loop", "run"])
    const [tool, step, loop, run] = spans
    expect(tool.parentSpanId).toBe(step.spanId)
    expect(step.parentSpanId).toBe(loop.spanId)
    expect(loop.parentSpanId).toBe(run.spanId)
    expect(tool.schemaVersion).toBe(1)
    expect(step.schemaVersion).toBe(1)
    expect(loop.schemaVersion).toBe(1)
    expect(run.schemaVersion).toBe(1)
    expect(tool.attributes).toEqual({ tool: "read", session_id: "session-1", status: "completed" })
    expect(tool).not.toHaveProperty("input")
    expect(run.events).toEqual([])
  })

  it("sanitizes diagnostics on span adapters in both policy modes", async () => {
    for (const diagnostic of [false, true]) {
      configureTelemetry({ diagnostic })
      const spans: any[] = []
      const adapter = createSpanTelemetryAdapter((records) => spans.push(...records))
      const event = (name: any, payload: any, timestamp: number) => adapter.emit({ name, runId: "run-1", timestamp, ...payload })
      event("run.start", { sessionId: "session-1", resumed: false, provider: "openai", model: "gpt-5", tokens: { input: 4, output: 2 }, prompt: "sentinel prompt" }, 1)
      event("run.end", { sessionId: "session-1", status: "completed", durationMs: 1 }, 2)
      await adapter.flush?.()
      const run = spans[0]
      expect(run.schemaVersion).toBe(1)
      expect(JSON.stringify(run)).not.toContain("sentinel prompt")
      expect(run.attributes).toMatchObject(diagnostic ? { provider: "openai", model: "gpt-5", tokens_input: 4, tokens_output: 2 } : {})
      if (!diagnostic) expect(run.attributes).not.toHaveProperty("provider")
    }
    configureTelemetry({ diagnostic: false })
  })

  it("flushes adapters and isolates emit and flush failures", async () => {
    let flushed = 0
    const unregister = registerTelemetryAdapter({
      emit: () => { throw new Error("ignored") },
      flush: () => { flushed++ },
    })
    expect(() => emitTelemetry("run-1", "loop.start", { sessionId: "session-1" })).not.toThrow()
    await flushTelemetry()
    expect(flushed).toBe(1)
    unregister()

    registerTelemetryAdapter({
      emit: () => {},
      flush: () => { throw new Error("ignored") },
    })
    await expect(flushTelemetry()).resolves.toBeUndefined()
    clearTelemetryAdapters()
  })
})
