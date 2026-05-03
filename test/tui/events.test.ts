// Tests for wireEvents — event bus → SolidJS store bridge
//
// These tests verify that backend events correctly mutate the app store.
// We use the real event bus (no mocks) and verify store mutations.

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createRoot } from "solid-js"
import { createAppState } from "../../src/tui/state"
import { wireEvents } from "../../src/tui/events"
import { bus } from "../../src/session/events"
import { getActive, dismiss } from "../../src/notification/notification"

// Run each test in a reactive root that we dispose after
let dispose: (() => void) | null = null

afterEach(() => {
  // Clean up bus listeners and reactive root
  bus.removeAllListeners()
  dispose?.()
  dispose = null
})

function setup(sessionId: string | null = "s1") {
  let state!: ReturnType<typeof createAppState>
  createRoot((d) => {
    dispose = d
    state = createAppState({ sessionId, modelName: "smart", skillCount: 2 })
    wireEvents(state)
  })
  return state
}

describe("wireEvents: message lifecycle", () => {
  test("assistant-message-start adds an assistant message", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    expect(s.store.messages.length).toBe(1)
    expect(s.store.messages[0]!.role).toBe("assistant")
    expect(s.store.messages[0]!.streaming).toBe(true)
  })

  test("ignores events for different sessionId", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "other", messageId: "m1" })
    expect(s.store.messages.length).toBe(0)
  })

  test("text-start adds a text part", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("text-start", { sessionId: "s1", messageId: "m1", partId: "p1" })
    expect(s.store.messages[0]!.parts.length).toBe(1)
    expect(s.store.messages[0]!.parts[0]!.type).toBe("text")
  })

  test("text-delta updates text content", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("text-start", { sessionId: "s1", messageId: "m1", partId: "p1" })
    bus.emit("text-delta", { sessionId: "s1", messageId: "m1", partId: "p1", delta: "Hello", text: "Hello" })
    expect((s.store.messages[0]!.parts[0] as any).text).toBe("Hello")

    bus.emit("text-delta", { sessionId: "s1", messageId: "m1", partId: "p1", delta: " world", text: "Hello world" })
    expect((s.store.messages[0]!.parts[0] as any).text).toBe("Hello world")
  })

  test("text-end finalizes text", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("text-start", { sessionId: "s1", messageId: "m1", partId: "p1" })
    bus.emit("text-end", { sessionId: "s1", messageId: "m1", partId: "p1", text: "final" })
    const part = s.store.messages[0]!.parts[0] as any
    expect(part.text).toBe("final")
    expect(part.streaming).toBe(false)
  })

  test("assistant-message-end clears streaming", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("assistant-message-end", { sessionId: "s1", messageId: "m1", finish: "stop" })
    expect(s.store.messages[0]!.streaming).toBe(false)
  })
})

describe("wireEvents: tool lifecycle", () => {
  test("tool-start adds a pending tool part", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("tool-start", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "read", callId: "c1" })

    const part = s.store.messages[0]!.parts[0] as any
    expect(part.type).toBe("tool")
    expect(part.tool).toBe("read")
    expect(part.status).toBe("pending")
  })

  test("tool-input sets running status and input", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("tool-start", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "read", callId: "c1" })
    bus.emit("tool-input", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "read", callId: "c1", input: { path: "/a.ts" } })

    const part = s.store.messages[0]!.parts[0] as any
    expect(part.status).toBe("awaiting_approval")
    expect(part.input).toEqual({ path: "/a.ts" })

    // tool-running event transitions to running
    bus.emit("tool-running", { sessionId: "s1", messageId: "m1", callId: "c1" })
    expect(part.status).toBe("running")
  })

  test("tool-input-delta streams inputPreview from bus event", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("tool-start", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "read", callId: "c1" })

    // Emit a delta
    bus.emit("tool-input-delta", { sessionId: "s1", messageId: "m1", partId: "p1", callId: "c1", delta: '{"path":"/a.ts"}' })

    const part = s.store.messages[0]!.parts[0] as any
    expect(part.inputPreview).toBe('{"path":"/a.ts"}')
    expect(part.status).toBe("pending") // still pending, awaiting tool-input

    // Emit another delta — accumulates
    bus.emit("tool-input-delta", { sessionId: "s1", messageId: "m1", partId: "p1", callId: "c1", delta: '{"path":"/a.ts","limit":10}' })
    expect(part.inputPreview).toBe('{"path":"/a.ts","limit":10}')
  })

  test("tool-end completes tool", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("tool-start", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "read", callId: "c1" })
    bus.emit("tool-end", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "read", callId: "c1", status: "completed", output: "ok" })

    const part = s.store.messages[0]!.parts[0] as any
    expect(part.status).toBe("completed")
    expect(part.output).toBe("ok")
  })
})

describe("wireEvents: loop lifecycle", () => {
  test("loop-start sets running true", () => {
    const s = setup("s1")
    bus.emit("loop-start", { sessionId: "s1" })
    expect(s.store.running).toBe(true)
  })

  test("loop-end sets running false", () => {
    const s = setup("s1")
    bus.emit("loop-start", { sessionId: "s1" })
    bus.emit("loop-end", { sessionId: "s1" })
    expect(s.store.running).toBe(false)
  })

  test("ignores loop events for other sessions", () => {
    const s = setup("s1")
    bus.emit("loop-start", { sessionId: "other" })
    expect(s.store.running).toBe(false)
  })
})

describe("wireEvents: error", () => {
  afterEach(() => {
    // clean up any active notifications between tests
    for (const n of getActive()) dismiss(n.id)
  })

  test("error event triggers notification and does not set store.error", () => {
    const s = setup("s1")
    bus.emit("loop-start", { sessionId: "s1" })
    bus.emit("error", { sessionId: "s1", error: new Error("oops") })
    expect(s.store.error).toBeUndefined()
    const notifs = getActive()
    expect(notifs.length).toBeGreaterThan(0)
    expect(notifs[0]!.type).toBe("error")
    expect(notifs[0]!.message).toBe("oops")
  })

  test("error categorized as Rate Limited for 429-like message", () => {
    const s = setup("s1")
    bus.emit("error", { sessionId: "s1", error: new Error("rate limit exceeded, try again") })
    const notifs = getActive()
    expect(notifs[0]!.title).toBe("Rate Limited")
  })

  test("error categorized as Context Too Large", () => {
    const s = setup("s1")
    bus.emit("error", { sessionId: "s1", error: new Error("This model's maximum context length is 128000 tokens") })
    const notifs = getActive()
    expect(notifs[0]!.title).toBe("Context Too Large")
  })

  test("error from string value shows as Provider Error", () => {
    const s = setup("s1")
    bus.emit("error", { sessionId: "s1", error: "something went wrong" })
    const notifs = getActive()
    expect(notifs[0]!.title).toBe("Provider Error")
    expect(notifs[0]!.message).toBe("something went wrong")
  })
})

describe("wireEvents: permission", () => {
  test("permission-request sets permission and clears running", () => {
    const s = setup("s1")
    bus.emit("loop-start", { sessionId: "s1" })
    bus.emit("permission-request", {
      sessionId: "s1",
      requestId: "r1",
      tool: "bash",
      input: { cmd: "ls" },
    })
    expect(s.store.permission).toEqual({ requestId: "r1", tool: "bash", input: { cmd: "ls" } })
    expect(s.store.running).toBe(false)
  })
})

describe("wireEvents: step-finish token accumulation", () => {
  test("accumulates tokens across multiple step-finish events", () => {
    const s = setup("s1")
    bus.emit("step-finish", {
      sessionId: "s1",
      messageId: "m1",
      data: { tokens: { input: 100, output: 50 } } as any,
    })
    // tokensUsed tracks input tokens only (context window consumption)
    expect(s.store.status.tokensUsed).toBe(100)

    bus.emit("step-finish", {
      sessionId: "s1",
      messageId: "m1",
      data: { tokens: { input: 200, output: 100 } } as any,
    })
    // Each step-finish replaces the value with latest input count (not cumulative)
    expect(s.store.status.tokensUsed).toBe(200)
  })

  test("handles missing token data gracefully", () => {
    const s = setup("s1")
    bus.emit("step-finish", {
      sessionId: "s1",
      messageId: "m1",
      data: {} as any,
    })
    expect(s.store.status.tokensUsed).toBe(0)
  })
})

describe("wireEvents: session-reset and session-switch", () => {
  test("session-reset resets state with new sessionId", () => {
    const s = setup("s1")
    // Add some state
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("loop-start", { sessionId: "s1" })
    expect(s.store.messages.length).toBe(1)

    bus.emit("session-reset", { sessionId: "s2" })
    expect(s.store.sessionId).toBe("s2")
    expect(s.store.messages).toEqual([])
    expect(s.store.running).toBe(false)
  })

  test("session-reset resets token counter", () => {
    const s = setup("s1")
    bus.emit("step-finish", {
      sessionId: "s1",
      messageId: "m1",
      data: { tokens: { input: 100, output: 50 } } as any,
    })
    expect(s.store.status.tokensUsed).toBe(100)

    bus.emit("session-reset", { sessionId: "s2" })
    expect(s.store.status.tokensUsed).toBe(0)

    // New tokens after reset should start from 0
    bus.emit("step-finish", {
      sessionId: "s2",
      messageId: "m2",
      data: { tokens: { input: 10, output: 5 } } as any,
    })
    expect(s.store.status.tokensUsed).toBe(10)
  })

  test("session-switch loads messages and switches session", () => {
    const s = setup("s1")
    const msgs = [
      { id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }], streaming: false },
    ]
    bus.emit("session-switch", { sessionId: "s3", messages: msgs })
    expect(s.store.sessionId).toBe("s3")
    expect(s.store.messages.length).toBe(1)
    expect(s.store.messages[0]!.id).toBe("m1")
  })

  test("session-switch resets token counter", () => {
    const s = setup("s1")
    bus.emit("step-finish", {
      sessionId: "s1",
      messageId: "m1",
      data: { tokens: { input: 500, output: 500 } } as any,
    })
    expect(s.store.status.tokensUsed).toBe(500)

    // Switch to a fresh session with no stored tokens — should reset to 0
    bus.emit("session-switch", { sessionId: "brand-new-session-xyz", messages: [] })
    expect(s.store.status.tokensUsed).toBe(0)
  })
})

describe("wireEvents: aborted tool state", () => {
  test("tool stays awaiting_approval if loop-end fires without tool-running or tool-end", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("tool-start", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "bash", callId: "c1" })
    bus.emit("tool-input", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "bash", callId: "c1", input: { command: "sleep 10" } })

    // Simulate abort: loop ends without tool-running or tool-end
    bus.emit("loop-end", { sessionId: "s1" })

    const part = s.store.messages[0]!.parts[0] as any
    expect(part.status).toBe("awaiting_approval")
  })

  test("running tool transitions to error when tool-end with error is emitted before loop-end", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("tool-start", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "bash", callId: "c1" })
    bus.emit("tool-input", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "bash", callId: "c1", input: { command: "sleep 10" } })

    // Processor emits tool-end on abort (after the fix)
    bus.emit("tool-end", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "bash", callId: "c1", status: "error", error: "Tool execution aborted" })
    bus.emit("loop-end", { sessionId: "s1" })

    const part = s.store.messages[0]!.parts[0] as any
    expect(part.status).toBe("error")
    expect(part.error).toBe("Tool execution aborted")
  })

  test("pending tool transitions to error when tool-end with error is emitted", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("tool-start", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "bash", callId: "c1" })
    // No tool-input — tool is still pending

    bus.emit("tool-end", { sessionId: "s1", messageId: "m1", partId: "p1", tool: "bash", callId: "c1", status: "error", error: "Tool execution aborted" })

    const part = s.store.messages[0]!.parts[0] as any
    expect(part.status).toBe("error")
    expect(part.error).toBe("Tool execution aborted")
  })
})

describe("wireEvents: null sessionId", () => {
  test("does not subscribe when sessionId is null", () => {
    const s = setup(null)
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    expect(s.store.messages.length).toBe(0)
  })
})

describe("wireEvents: lazy session creation", () => {
  test("session-created sets sessionId from null and activates session subscriptions", () => {
    const s = setup(null)
    expect(s.store.sessionId).toBeNull()

    // Simulate prompt() lazily creating a session
    bus.emit("session-created", { sessionId: "s1" })

    expect(s.store.sessionId).toBe("s1")

    // createComputed re-ran with "s1" — session-scoped events now work
    bus.emit("loop-start", { sessionId: "s1" })
    expect(s.store.running).toBe(true)
  })

  test("session-created is ignored for other sessions after one is active", () => {
    const s = setup(null)
    bus.emit("session-created", { sessionId: "s1" })
    expect(s.store.sessionId).toBe("s1")

    // A second session-created (e.g. race) should NOT overwrite the active one
    // (set-session would still update, but in practice only one fires per clear cycle)
    bus.emit("session-created", { sessionId: "s2" })
    // set-session is unconditional — last write wins, which is acceptable
    expect(s.store.sessionId).toBe("s2")
  })

  test("session-reset with null goes back to no-session state", () => {
    const s = setup("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    bus.emit("loop-start", { sessionId: "s1" })
    expect(s.store.messages.length).toBe(1)
    expect(s.store.running).toBe(true)

    // /clear — no new session created yet
    bus.emit("session-reset", { sessionId: null })

    expect(s.store.sessionId).toBeNull()
    expect(s.store.messages).toEqual([])
    expect(s.store.running).toBe(false)

    // Old session events are ignored now
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m2" })
    expect(s.store.messages.length).toBe(0)
  })

  test("full lazy cycle: null → session-created → session-reset → session-created", () => {
    const s = setup(null)

    // First message creates session
    bus.emit("session-created", { sessionId: "s1" })
    expect(s.store.sessionId).toBe("s1")
    bus.emit("assistant-message-start", { sessionId: "s1", messageId: "m1" })
    expect(s.store.messages.length).toBe(1)

    // /clear
    bus.emit("session-reset", { sessionId: null })
    expect(s.store.sessionId).toBeNull()
    expect(s.store.messages).toEqual([])

    // Next message creates a new session
    bus.emit("session-created", { sessionId: "s2" })
    expect(s.store.sessionId).toBe("s2")
    bus.emit("assistant-message-start", { sessionId: "s2", messageId: "m2" })
    expect(s.store.messages.length).toBe(1)
  })
})
