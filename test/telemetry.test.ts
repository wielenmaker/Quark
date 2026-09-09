import { describe, expect, it } from "bun:test"
import {
  clearTelemetryAdapters,
  emitTelemetry,
  flushTelemetry,
  registerTelemetryAdapter,
  createSpanTelemetryAdapter,
} from "../src/telemetry"

describe("telemetry", () => {
  it("is inert without configuration or a registered adapter", async () => {
    clearTelemetryAdapters()
    expect(() => emitTelemetry("run-1", "loop.start", { sessionId: "session-1" })).not.toThrow()
    await expect(flushTelemetry()).resolves.toBeUndefined()
  })

  it("emits only sanitized allowlisted fields", async () => {
    const events: unknown[] = []
    const unregister = registerTelemetryAdapter({ emit: (event) => events.push(event) })
    emitTelemetry("run-1", "tool.start", {
      sessionId: "session-1",
      tool: "read",
      callId: "call-1",
      ...( { input: "secret" } as never),
    })
    await flushTelemetry()
    unregister()
    clearTelemetryAdapters()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: "tool.start", runId: "run-1", sessionId: "session-1", tool: "read", callId: "call-1" })
    expect(events[0]).not.toHaveProperty("input")
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
    expect(tool.attributes).toEqual({ tool: "read", session_id: "session-1", status: "completed" })
    expect(tool).not.toHaveProperty("input")
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
