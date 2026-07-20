// Tests for SolidJS state layer — createAppState + dispatch
//
// SolidJS stores need a reactive owner (createRoot) to work properly.

import { describe, test, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createAppState, dbToTuiMessages, dispatch } from "../../src/tui/state"
import { dbToConversationMessages } from "../../src/shared/conversation-view"
import type { TuiMessage, TuiPart } from "../../src/tui/state"

// Helper: run a test inside a SolidJS reactive root
function withRoot<T>(fn: () => T): T {
  let result!: T
  createRoot((dispose) => {
    result = fn()
    dispose()
  })
  return result
}

describe("createAppState", () => {
  test("returns store with correct initial values", () => {
    withRoot(() => {
      const { store } = createAppState({
        sessionId: "s1",
        modelName: "smart",
        skillCount: 3,
      })
      expect(store.sessionId).toBe("s1")
      expect(store.messages).toEqual([])
      expect(store.running).toBe(false)
      expect(store.status.tokensUsed).toBe(0)
      expect(store.status.tokenLimit).toBeGreaterThanOrEqual(0)
      expect(store.status.cost).toBe(0)
      expect(store.status.modelName).toBe("smart")
      expect(store.status.skillCount).toBe(3)
      expect(store.error).toBeUndefined()
      expect(store.permission).toBeUndefined()
    })
  })

  test("accepts null sessionId", () => {
    withRoot(() => {
      const { store } = createAppState({
        sessionId: null,
        modelName: "smart",
        skillCount: 0,
      })
      expect(store.sessionId).toBeNull()
    })
  })

  // Worktree fields — added to AppStore, must be initialized correctly.
  // Accessed via (store as any) until the AppStore interface is updated.
  test("initialises worktree fields with defaults", () => {
    withRoot(() => {
      const { store } = createAppState({
        sessionId: "s1",
        modelName: "smart",
        skillCount: 3,
       })
      // rootProjectDir should be captured at startup
      expect((store as any).rootProjectDir).toBeString()
      // cwd should match rootProjectDir initially
      expect((store as any).cwd).toBe((store as any).rootProjectDir)
      // No active worktree until one is selected
      expect((store as any).activeWorktree).toBeNull()
      expect((store as any).activeBranch).toBeNull()
      // Not currently switching
      expect((store as any).worktreeSwitching).toBe(false)
    })
  })
})

describe("dispatch: thinking actions", () => {
  test("cycles configured effort and applies the active profile's effort on model switches", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "gpt-5", skillCount: 0, thinkingEffort: "high" })
      expect(s.store.thinkingEffort).toBe("high")
      dispatch(s, { type: "cycle-thinking", modelId: "gpt-5" })
      expect(s.store.thinkingEffort).toBe("xhigh")
      dispatch(s, { type: "model-switched", modelSpec: "gpt-5-mini", thinkingEffort: "low" })
      expect(s.store.thinkingEffort).toBe("low")
    })
  })
})

describe("dispatch: session actions", () => {
  test("set-session updates sessionId", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: null, modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "set-session", sessionId: "s2" })
      expect(s.store.sessionId).toBe("s2")
    })
  })

  test("reset-session resets state with new sessionId", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })
      // Add some state first
      dispatch(s, { type: "add-user-message", id: "m1", text: "hello" })
      dispatch(s, { type: "set-running", running: true })
      dispatch(s, { type: "update-status", partial: { tokensUsed: 500, cost: 0.01 } })

      dispatch(s, { type: "reset-session", sessionId: "s2" })
      expect(s.store.sessionId).toBe("s2")
      expect(s.store.messages).toEqual([])
      expect(s.store.running).toBe(false)
      expect(s.store.status.tokensUsed).toBe(0)
      expect(s.store.status.cost).toBe(0)
      // model and skills preserved
      expect(s.store.status.modelName).toBe("smart")
      expect(s.store.status.skillCount).toBe(3)
    })
  })

  test("reset-session with null sets sessionId to null and clears state", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-user-message", id: "m1", text: "hello" })
      dispatch(s, { type: "set-running", running: true })

      dispatch(s, { type: "reset-session", sessionId: null })
      expect(s.store.sessionId).toBeNull()
      expect(s.store.messages).toEqual([])
      expect(s.store.running).toBe(false)
    })
  })

  test("load-session replaces messages and sessionId", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      const msgs: TuiMessage[] = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ]
      dispatch(s, { type: "load-session", sessionId: "s3", messages: msgs })
      expect(s.store.sessionId).toBe("s3")
      expect(s.store.messages.length).toBe(2)
      expect(s.store.messages[0]!.id).toBe("m1")
      expect(s.store.messages[1]!.id).toBe("m2")
    })
  })
})

describe("dbToTuiMessages and dbToConversationMessages aborted filtering", () => {
  test("both functions skip aborted assistant messages", () => {
    const messages = [
      {
        id: "m1",
        sessionId: "s1",
        role: "user" as const,
        modelId: null,
        providerId: null,
        finish: null as "stop" | "tool-calls" | "length" | "aborted" | null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        // Aborted assistant — should be skipped
        id: "m2",
        sessionId: "s1",
        role: "assistant" as const,
        modelId: "gpt-5",
        providerId: "copilot",
        finish: "aborted" as const,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
      {
        id: "m3",
        sessionId: "s1",
        role: "assistant" as const,
        modelId: "gpt-5",
        providerId: "copilot",
        finish: "stop" as const,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 3,
        timeCompleted: 3,
      },
    ];
    const parts = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "text" as const, data: JSON.stringify({ text: "user query" }) },
      { id: "p2", messageId: "m2", sessionId: "s1", type: "text" as const, data: JSON.stringify({ text: "aborted answer" }) },
      { id: "p3", messageId: "m3", sessionId: "s1", type: "text" as const, data: JSON.stringify({ text: "real answer" }) },
    ];

    const tuiResult = dbToTuiMessages(messages, parts);
    const convResult = dbToConversationMessages(messages, parts);

    // Both should have 2 messages: m1 (user) + m3 (assistant), skipping m2
    expect(tuiResult.length).toBe(2);
    expect(tuiResult[0]!.id).toBe("m1");
    expect(tuiResult[1]!.id).toBe("m3");
    expect((tuiResult[1]!.parts[0] as any).text).toBe("real answer");

    expect(convResult.length).toBe(2);
    expect(convResult[0]!.id).toBe("m1");
    expect(convResult[1]!.id).toBe("m3");
    expect((convResult[1]!.parts[0] as any).text).toBe("real answer");
  });

  test("normal messages are still included when aborted messages are present", () => {
    const messages = [
      {
        id: "m1",
        sessionId: "s1",
        role: "user" as const,
        modelId: null,
        providerId: null,
        finish: null as "stop" | "tool-calls" | "length" | "aborted" | null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        id: "a-aborted",
        sessionId: "s1",
        role: "assistant" as const,
        modelId: "gpt-5",
        providerId: "copilot",
        finish: "aborted" as const,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
      {
        id: "m2",
        sessionId: "s1",
        role: "user" as const,
        modelId: null,
        providerId: null,
        finish: null as "stop" | "tool-calls" | "length" | "aborted" | null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 3,
        timeCompleted: 3,
      },
      {
        id: "a-ok",
        sessionId: "s1",
        role: "assistant" as const,
        modelId: "gpt-5",
        providerId: "copilot",
        finish: "stop" as const,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 4,
        timeCompleted: 4,
      },
    ];
    const parts = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "text" as const, data: JSON.stringify({ text: "q1" }) },
      { id: "p2", messageId: "a-aborted", sessionId: "s1", type: "text" as const, data: JSON.stringify({ text: "aborted" }) },
      { id: "p3", messageId: "m2", sessionId: "s1", type: "text" as const, data: JSON.stringify({ text: "q2" }) },
      { id: "p4", messageId: "a-ok", sessionId: "s1", type: "text" as const, data: JSON.stringify({ text: "ok" }) },
    ];

    const tuiResult = dbToTuiMessages(messages, parts);
    const convResult = dbToConversationMessages(messages, parts);

    // Both should have 3 messages (user, user, assistant), skipping the aborted one
    expect(tuiResult.length).toBe(3);
    expect(tuiResult.map((m) => m.id)).toEqual(["m1", "m2", "a-ok"]);

    expect(convResult.length).toBe(3);
    expect(convResult.map((m) => m.id)).toEqual(["m1", "m2", "a-ok"]);
  });
});

describe("dbToTuiMessages", () => {
  test("preserves text from user messages with steer variant", () => {
    const messages = [{
      id: "m1",
      sessionId: "s1",
      role: "user" as const,
      modelId: null,
      providerId: null,
      finish: "stop" as const,
      cost: null,
      tokensIn: null,
      tokensOut: null,
      timeCreated: 1,
      timeCompleted: 1,
    }]
    const parts = [{
      id: "p1",
      messageId: "m1",
      sessionId: "s1",
      type: "text" as const,
      data: JSON.stringify({ text: "Improving the TUI", variant: "steer" }),
    }]

    // Steer variant is no longer exposed in TUI parts — it is a DB-only
    // signal for the branching system. The text is preserved as-is.
    expect(dbToTuiMessages(messages, parts)[0]!.parts[0]).toEqual({
      type: "text",
      text: "Improving the TUI",
    })
    expect(dbToConversationMessages(messages, parts)[0]!.parts[0]).toEqual({
      type: "text",
      text: "Improving the TUI",
    })
  })
})

describe("dispatch: message lifecycle", () => {
  test("add-user-message appends a sent user message", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-user-message", id: "m1", text: "hello world" })
      expect(s.store.messages.length).toBe(1)
      expect(s.store.messages[0]!.role).toBe("user")
      expect(s.store.messages[0]!.userStatus).toBe("sent")
      expect(s.store.messages[0]!.parts.length).toBe(1)
      expect(s.store.messages[0]!.parts[0]!.type).toBe("text")
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("hello world")
    })
  })

  test("updates only the targeted user message lifecycle status", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-user-message", id: "u1", text: "first" })
      dispatch(s, { type: "add-user-message", id: "u2", text: "second" })
      dispatch(s, { type: "set-user-message-status", messageId: "u1", status: "aborted" })

      expect(s.store.messages[0]!.userStatus).toBe("aborted")
      expect(s.store.messages[1]!.userStatus).toBe("sent")
    })
  })

  test("add-assistant-message appends a streaming assistant message", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      expect(s.store.messages.length).toBe(1)
      expect(s.store.messages[0]!.role).toBe("assistant")
      expect(s.store.messages[0]!.parts).toEqual([])
      expect(s.store.messages[0]!.streaming).toBe(true)
    })
  })

  test("assistant-done clears streaming flag", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "assistant-done", messageId: "m1" })
      expect(s.store.messages[0]!.streaming).toBe(false)
    })
  })
})

// Tests for gh issue #36: user messages appearing twice
// https://github.com/user/repo/issues/36
//
// Bug: User messages appeared twice because:
//   1. Bus event handler (src/tui/events.ts:135-137) dispatches 'add-user-message' 
//      when it receives 'user-message' event (from session/prompt.ts:134)
//   2. [OLD BUG] handleSubmit also dispatched 'add-user-message' optimistically
//
// Fix: Removed optimistic dispatch from handleSubmit. Now only the bus event adds the message.
//
// These tests verify:
//   1. Single dispatch → exactly 1 message (the normal path after the fix)
//   2. Double dispatch with different IDs → 2 messages (documents that deduplication
//      must happen at call-site, not in the reducer)
describe("dispatch: add-user-message deduplication (gh issue #36)", () => {
  test("single add-user-message dispatch produces exactly one message in store", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      
      // Simulate the current (fixed) path: only bus event dispatches add-user-message
      dispatch(s, { type: "add-user-message", id: "msg-db-123", text: "hello world" })
      
      expect(s.store.messages.length).toBe(1)
      expect(s.store.messages[0]!.id).toBe("msg-db-123")
      expect(s.store.messages[0]!.role).toBe("user")
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("hello world")
    })
  })

  test("double add-user-message dispatch with different IDs produces two messages (reducer does NOT dedupe)", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      
      // Simulate the OLD buggy path: 
      // 1. Optimistic dispatch with client-generated ID
      // 2. Bus event dispatch with DB-generated ID
      // Both have the same content but different IDs
      dispatch(s, { type: "add-user-message", id: "client-temp-id", text: "hello world" })
      dispatch(s, { type: "add-user-message", id: "msg-db-123", text: "hello world" })
      
      // The reducer itself does NOT deduplicate — it appends both
      expect(s.store.messages.length).toBe(2)
      expect(s.store.messages[0]!.id).toBe("client-temp-id")
      expect(s.store.messages[1]!.id).toBe("msg-db-123")
      
      // Both messages have the same text
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("hello world")
      expect((s.store.messages[1]!.parts[0] as any).text).toBe("hello world")
    })
  })

  test("add-user-message with same ID twice still produces two messages (no ID-based deduplication)", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      
      // Even with the same ID, the reducer appends (doesn't check for duplicates)
      dispatch(s, { type: "add-user-message", id: "m1", text: "first" })
      dispatch(s, { type: "add-user-message", id: "m1", text: "second" })
      
      expect(s.store.messages.length).toBe(2)
      expect(s.store.messages[0]!.id).toBe("m1")
      expect(s.store.messages[1]!.id).toBe("m1")
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("first")
      expect((s.store.messages[1]!.parts[0] as any).text).toBe("second")
    })
  })

  test("add-user-message with images produces correct message structure", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      
      dispatch(s, { 
        type: "add-user-message", 
        id: "m1", 
        text: "look at this",
        images: [
          { mime: "image/png", data: "base64data1", label: "Screenshot" },
          { mime: "image/jpeg", data: "base64data2", label: "Photo" }
        ]
      })
      
      expect(s.store.messages.length).toBe(1)
      expect(s.store.messages[0]!.parts.length).toBe(3) // 1 text + 2 images
      expect(s.store.messages[0]!.parts[0]!.type).toBe("text")
      expect(s.store.messages[0]!.parts[1]!.type).toBe("image")
      expect(s.store.messages[0]!.parts[2]!.type).toBe("image")
      expect((s.store.messages[0]!.parts[1] as any).label).toBe("Screenshot")
      expect((s.store.messages[0]!.parts[2] as any).label).toBe("Photo")
    })
  })
})

describe("dispatch: text streaming", () => {
  test("text-start adds a streaming text part", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "text-start", messageId: "m1" })
      expect(s.store.messages[0]!.parts.length).toBe(1)
      const part = s.store.messages[0]!.parts[0]!
      expect(part.type).toBe("text")
      expect((part as any).text).toBe("")
      expect((part as any).streaming).toBe(true)
    })
  })

  test("text-delta updates the last text part", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "text-start", messageId: "m1" })
      dispatch(s, { type: "text-delta", messageId: "m1", delta: "Hello", text: "Hello" })
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("Hello")

      dispatch(s, { type: "text-delta", messageId: "m1", delta: " world", text: "Hello world" })
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("Hello world")
    })
  })

  test("text-delta only updates the matching message", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-user-message", id: "m1", text: "user msg" })
      dispatch(s, { type: "add-assistant-message", id: "m2" })
      dispatch(s, { type: "text-start", messageId: "m2" })
      dispatch(s, { type: "text-delta", messageId: "m2", delta: "hi", text: "hi" })

      // User message unchanged
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("user msg")
      // Assistant updated
      expect((s.store.messages[1]!.parts[0] as any).text).toBe("hi")
    })
  })

  test("text-end finalizes text part", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "text-start", messageId: "m1" })
      dispatch(s, { type: "text-delta", messageId: "m1", delta: "done", text: "done" })
      dispatch(s, { type: "text-end", messageId: "m1", text: "done" })

      const part = s.store.messages[0]!.parts[0] as any
      expect(part.text).toBe("done")
      expect(part.streaming).toBe(false)
    })
  })
})

describe("dispatch: tool lifecycle", () => {
  test("tool-start adds a pending tool part", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "tool-start", messageId: "m1", tool: "read", callId: "c1" })

      const part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.type).toBe("tool")
      expect(part.tool).toBe("read")
      expect(part.callId).toBe("c1")
      expect(part.status).toBe("pending")
      expect(part.input).toEqual({})
    })
  })

  test("tool-input sets tool to awaiting_approval with input", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "tool-start", messageId: "m1", tool: "read", callId: "c1" })
      dispatch(s, { type: "tool-input", messageId: "m1", callId: "c1", input: { path: "/foo.ts" } })

      const part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.status).toBe("awaiting_approval")
      expect(part.input).toEqual({ path: "/foo.ts" })

      // tool-running transitions to running
      dispatch(s, { type: "tool-running", messageId: "m1", callId: "c1" })
      expect(part.status).toBe("running")
    })
  })

  test("tool-end completes tool with output", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "tool-start", messageId: "m1", tool: "read", callId: "c1" })
      dispatch(s, { type: "tool-end", messageId: "m1", callId: "c1", status: "completed", output: "file contents" })

      const part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.status).toBe("completed")
      expect(part.output).toBe("file contents")
    })
  })

  test("tool-end with error", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "tool-start", messageId: "m1", tool: "read", callId: "c1" })
      dispatch(s, { type: "tool-end", messageId: "m1", callId: "c1", status: "error", error: "not found" })

      const part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.status).toBe("error")
      expect(part.error).toBe("not found")
    })
  })

  test("tool-input matches by callId across multiple tools", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "tool-start", messageId: "m1", tool: "read", callId: "c1" })
      dispatch(s, { type: "tool-start", messageId: "m1", tool: "write", callId: "c2" })
      dispatch(s, { type: "tool-input", messageId: "m1", callId: "c2", input: { path: "/bar.ts" } })

      const p0 = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      const p1 = s.store.messages[0]!.parts[1]! as Extract<TuiPart, { type: "tool" }>
      expect(p0.status).toBe("pending") // c1 unchanged
      expect(p1.status).toBe("awaiting_approval") // c2 updated
      expect(p1.input).toEqual({ path: "/bar.ts" })
    })
  })
})

describe("dispatch: running, status, error, permission", () => {
  test("set-running toggles running flag", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "set-running", running: true })
      expect(s.store.running).toBe(true)
      dispatch(s, { type: "set-running", running: false })
      expect(s.store.running).toBe(false)
    })
  })

  test("update-status merges partial status", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "update-status", partial: { tokensUsed: 1000, cost: 0.05 } })
      expect(s.store.status.tokensUsed).toBe(1000)
      expect(s.store.status.cost).toBe(0.05)
      expect(s.store.status.modelName).toBe("smart") // unchanged
    })
  })

  test("set-error sets error and clears running", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "set-running", running: true })
      dispatch(s, { type: "set-error", message: "boom" })
      expect(s.store.error).toBe("boom")
      expect(s.store.running).toBe(false)
    })
  })

  test("clear-error clears error", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "set-error", message: "boom" })
      dispatch(s, { type: "clear-error" })
      expect(s.store.error).toBeUndefined()
    })
  })

  test("set-permission stores request and clears running", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "set-running", running: true })
      dispatch(s, {
        type: "set-permission",
        request: { requestId: "r1", tool: "bash", input: { cmd: "rm -rf" } },
      })
      expect(s.store.permission).toEqual({ requestId: "r1", tool: "bash", input: { cmd: "rm -rf" } })
      expect(s.store.running).toBe(false)
    })
  })

  test("clear-permission clears permission", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, {
        type: "set-permission",
        request: { requestId: "r1", tool: "bash", input: {} },
      })
      dispatch(s, { type: "clear-permission" })
      expect(s.store.permission).toBeUndefined()
    })
  })

  test("dismiss-permissions removes visible and queued child requests precisely", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "set-running", running: true })
      dispatch(s, { type: "set-permission", request: { requestId: "remote-1", tool: "read", input: {} } })
      dispatch(s, { type: "set-permission", request: { requestId: "remote-2", tool: "write", input: {} } })
      dispatch(s, { type: "set-permission", request: { requestId: "local-1", tool: "bash", input: {} } })

      dispatch(s, { type: "dismiss-permissions", requestIds: ["remote-1", "remote-2"] })
      expect(s.store.permission?.requestId).toBe("local-1")
      expect(s.store.permissionQueue).toEqual([])
      expect(s.store.running).toBe(false)
    })
  })
})

describe("dispatch: full streaming lifecycle", () => {
  test("simulates a complete assistant response with text and tools", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })

      // User sends message
      dispatch(s, { type: "add-user-message", id: "u1", text: "fix the bug" })

      // Assistant starts
      dispatch(s, { type: "add-assistant-message", id: "a1" })
      dispatch(s, { type: "text-start", messageId: "a1" })
      dispatch(s, { type: "text-delta", messageId: "a1", delta: "Let me ", text: "Let me " })
      dispatch(s, { type: "text-delta", messageId: "a1", delta: "check.", text: "Let me check." })
      dispatch(s, { type: "text-end", messageId: "a1", text: "Let me check." })

      // Tool call
      dispatch(s, { type: "tool-start", messageId: "a1", tool: "read", callId: "c1" })
      dispatch(s, { type: "tool-input", messageId: "a1", callId: "c1", input: { path: "src/bug.ts" } })
      dispatch(s, { type: "tool-end", messageId: "a1", callId: "c1", status: "completed", output: "content" })

      // More text
      dispatch(s, { type: "text-start", messageId: "a1" })
      dispatch(s, { type: "text-delta", messageId: "a1", delta: "Fixed!", text: "Fixed!" })
      dispatch(s, { type: "text-end", messageId: "a1", text: "Fixed!" })

      // Done
      dispatch(s, { type: "assistant-done", messageId: "a1" })

      expect(s.store.messages.length).toBe(2)
      const assistant = s.store.messages[1]!
      expect(assistant.streaming).toBe(false)
      expect(assistant.parts.length).toBe(3)
      expect(assistant.parts[0]!.type).toBe("text")
      expect((assistant.parts[0] as any).text).toBe("Let me check.")
      expect(assistant.parts[1]!.type).toBe("tool")
      expect((assistant.parts[1] as any).status).toBe("completed")
      expect(assistant.parts[2]!.type).toBe("text")
      expect((assistant.parts[2] as any).text).toBe("Fixed!")
    })
  })
})

describe("dispatch: subagent-done marks parent tool completed", () => {
  test("subagent-done sets parent tool part status to completed", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      
      // Setup: add assistant message with bash tool
      dispatch(s, { type: "add-assistant-message", id: "a1" })
      dispatch(s, { type: "tool-start", messageId: "a1", tool: "bash", callId: "parent-1" })
      dispatch(s, { type: "tool-input", messageId: "a1", callId: "parent-1", input: { command: "quark --sub-agent --profile coder" } })
      
      // Verify tool is awaiting_approval
      let part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.status).toBe("awaiting_approval")

      // tool-running transitions to running
      dispatch(s, { type: "tool-running", messageId: "a1", callId: "parent-1" })
      expect(part.status).toBe("running")
      
      // Dispatch subagent-done
      dispatch(s, { type: "subagent-done", messageId: "a1", parentCallId: "parent-1", profile: "coder" })
      
      // Assert: parent tool part status is completed
      part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.status).toBe("completed")
      
      // Assert: subAgent.done is true
      expect(part.subAgent).toBeDefined()
      expect(part.subAgent!.done).toBe(true)
    })
  })

  test("spinner stops: parent tool is not running after subagent-done", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      
      // Setup: add assistant message with bash tool
      dispatch(s, { type: "add-assistant-message", id: "a1" })
      dispatch(s, { type: "tool-start", messageId: "a1", tool: "bash", callId: "parent-2" })
      dispatch(s, { type: "tool-input", messageId: "a1", callId: "parent-2", input: { command: "quark --sub-agent" } })
      
      // Dispatch subagent-done
      dispatch(s, { type: "subagent-done", messageId: "a1", parentCallId: "parent-2", profile: "sub-agent" })
      
      // Assert: the condition that shows InlineSpinner is false
      const part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.status).not.toBe("running")
    })
  })

  test("subagent-done without existing subAgent still marks parent completed", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      
      // Setup: add assistant message with bash tool
      dispatch(s, { type: "add-assistant-message", id: "a1" })
      dispatch(s, { type: "tool-start", messageId: "a1", tool: "bash", callId: "parent-3" })
      dispatch(s, { type: "tool-input", messageId: "a1", callId: "parent-3", input: { command: "some command" } })
      
      // Directly dispatch subagent-done (skip any subagent-tool-start events)
      dispatch(s, { type: "subagent-done", messageId: "a1", parentCallId: "parent-3", profile: "coder" })
      
      // Assert: parent tool part status is completed
      const part = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part.status).toBe("completed")
    })
  })
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// dispatch: worktree actions
// ---------------------------------------------------------------------------

describe("dispatch: worktree actions", () => {
  interface TuiWorktree {
    id: string
    path: string
    branch: string | null
    shortHash: string
    isRoot: boolean
  }

  describe("worktree-switch-start", () => {
    test("sets worktreeSwitching to true", () => {
      withRoot(() => {
        const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })
        expect((s.store as any).worktreeSwitching).toBe(false)

        dispatch(s, { type: "worktree-switch-start" } as any)
        expect((s.store as any).worktreeSwitching).toBe(true)
      })
    })
  })

  describe("worktree-switched", () => {
    test("clears sessionId, messages, tokens, cost, permission, question", () => {
      withRoot(() => {
        const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })

        dispatch(s, { type: "add-user-message", id: "m1", text: "hello" })
        dispatch(s, { type: "update-status", partial: { tokensUsed: 500, cost: 0.01 } })
        dispatch(s, {
          type: "set-permission",
          request: { requestId: "r1", tool: "bash", input: {} },
        })
        dispatch(s, {
          type: "set-question",
          request: { requestId: "q1", sessionId: "s1", questions: [] },
        })

        dispatch(s, {
          type: "worktree-switched",
          cwd: "/new/worktree/path",
          activeWorktree: { id: "feat", path: "/new/worktree/path", branch: "feat/branch", shortHash: "abc1234", isRoot: false },
          activeBranch: "feat/branch",
          modelSpec: "gpt-4",
          skillCount: 5,
        } as any)

        expect(s.store.sessionId).toBeNull()
        expect(s.store.messages).toEqual([])
        expect(s.store.status.tokensUsed).toBe(0)
        expect(s.store.status.cost).toBe(0)
        expect(s.store.permission).toBeUndefined()
        expect(s.store.question).toBeUndefined()
        expect(s.store.permissionQueue).toEqual([])
        expect(s.store.questionQueue).toEqual([])
      })
    })

    test("clears error and resets running to false", () => {
      withRoot(() => {
        const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })
        dispatch(s, { type: "set-error", message: "old error" })
        dispatch(s, { type: "set-running", running: true })

        dispatch(s, {
          type: "worktree-switched",
          cwd: "/new/path",
          activeWorktree: null,
          activeBranch: "main",
          modelSpec: "claude",
          skillCount: 2,
        } as any)

        expect(s.store.error).toBeUndefined()
        expect(s.store.running).toBe(false)
      })
    })

    test("updates cwd, activeWorktree, activeBranch, modelSpec, skillCount", () => {
      withRoot(() => {
        const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })

        const wt: TuiWorktree = {
          id: "feature-login-auth",
          path: "/Users/mac/projects/Quark/.quark/worktrees/feature-login-auth",
          branch: "feature/login-auth",
          shortHash: "abc1234",
          isRoot: false,
        }

        dispatch(s, {
          type: "worktree-switched",
          cwd: wt.path,
          activeWorktree: wt,
          activeBranch: "feature/login-auth",
          modelSpec: "gpt-4",
          skillCount: 5,
        } as any)

        expect((s.store as any).cwd).toBe(wt.path)
        expect((s.store as any).activeWorktree).toEqual(wt)
        expect((s.store as any).activeBranch).toBe("feature/login-auth")
        expect(s.store.status.modelName).toBe("gpt-4")
        expect(s.store.status.skillCount).toBe(5)
      })
    })

    test("handles null activeWorktree (switching to root)", () => {
      withRoot(() => {
        const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })

        dispatch(s, {
          type: "worktree-switched",
          cwd: "/Users/mac/projects/Quark",
          activeWorktree: null,
          activeBranch: "main",
          modelSpec: "claude",
          skillCount: 4,
        } as any)

        expect((s.store as any).activeWorktree).toBeNull()
        expect((s.store as any).activeBranch).toBe("main")
        expect((s.store as any).cwd).toBe("/Users/mac/projects/Quark")
        expect(s.store.sessionId).toBeNull()
        expect(s.store.messages).toEqual([])
      })
    })
  })

  describe("worktree-switch-failed", () => {
    test("clears worktreeSwitching flag", () => {
      withRoot(() => {
        const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })

        dispatch(s, { type: "worktree-switch-start" } as any)
        expect((s.store as any).worktreeSwitching).toBe(true)

        dispatch(s, {
          type: "worktree-switch-failed",
          message: "Agent is running — cannot switch worktrees",
        } as any)

        expect((s.store as any).worktreeSwitching).toBe(false)
      })
    })

    test("sets error message and clears running", () => {
      withRoot(() => {
        const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 3 })
        dispatch(s, { type: "set-running", running: true })

        dispatch(s, {
          type: "worktree-switch-failed",
          message: "Agent is running — cannot switch worktrees",
        } as any)

        expect(s.store.error).toBe("Agent is running — cannot switch worktrees")
        expect(s.store.running).toBe(false)
        expect(s.store.sessionId).toBe("s1")
        expect(s.store.status.modelName).toBe("smart")
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Async Panel state tests (gh issue /async-msg)
// ---------------------------------------------------------------------------

describe("dispatch: async-panel lifecycle", () => {
  test("open-async-panel creates panel with sessionId and title", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })

      expect(s.store.asyncPanel).toBeDefined()
      expect(s.store.asyncPanel!.sessionId).toBe("side-1")
      expect(s.store.asyncPanel!.title).toBe("bug-report")
      expect(s.store.asyncPanel!.collapsed).toBe(false)
      expect(s.store.asyncPanel!.running).toBe(false)
      expect(s.store.asyncPanel!.done).toBe(false)
      expect(s.store.asyncPanel!.toolsUsed).toBe(0)
      expect(s.store.asyncPanel!.unread).toBe(0)
      expect(s.store.asyncPanel!.messages).toEqual([])
    })
  })

  test("close-async-panel removes panel", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })
      dispatch(s, { type: "close-async-panel" })
      expect(s.store.asyncPanel).toBeNull()
    })
  })

  test("async-add-user-message appends to panel messages", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })
      dispatch(s, { type: "async-add-user-message", id: "m1", text: "crash on save" })

      expect(s.store.asyncPanel!.messages.length).toBe(1)
      expect(s.store.asyncPanel!.messages[0]!.role).toBe("user")
      expect((s.store.asyncPanel!.messages[0]!.parts[0] as any).text).toBe("crash on save")
    })
  })

  test("async-add-assistant-message + async-text-delta builds condensed text", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })
      dispatch(s, { type: "async-add-assistant-message", id: "a1" })
      dispatch(s, { type: "async-text-start", messageId: "a1" })
      dispatch(s, { type: "async-text-delta", messageId: "a1", delta: "It", text: "It" })
      dispatch(s, { type: "async-text-delta", messageId: "a1", delta: " works.", text: "It works." })
      dispatch(s, { type: "async-text-end", messageId: "a1", text: "It works." })

      const msg = s.store.asyncPanel!.messages[0]!
      expect(msg.role).toBe("assistant")
      expect((msg.parts[0] as any).text).toBe("It works.")
      expect((msg.parts[0] as any).streaming).toBe(false)
    })
  })

  test("async-tool-start increments toolsUsed counter", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })
      dispatch(s, { type: "async-add-assistant-message", id: "a1" })
      dispatch(s, { type: "async-tool-start", messageId: "a1", tool: "read", callId: "c1" })

      expect(s.store.asyncPanel!.toolsUsed).toBe(1)
    })
  })

  test("async-set-running toggles panel running flag", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })
      dispatch(s, { type: "async-set-running", running: true })
      expect(s.store.asyncPanel!.running).toBe(true)
      dispatch(s, { type: "async-set-running", running: false })
      expect(s.store.asyncPanel!.running).toBe(false)
    })
  })

  test("toggle-async-collapse flips collapsed state", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })
      expect(s.store.asyncPanel!.collapsed).toBe(false)
      dispatch(s, { type: "toggle-async-collapse" })
      expect(s.store.asyncPanel!.collapsed).toBe(true)
      dispatch(s, { type: "toggle-async-collapse" })
      expect(s.store.asyncPanel!.collapsed).toBe(false)
    })
  })

  test("async-assistant-done sets done=true", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "open-async-panel", sessionId: "side-1", title: "bug-report" })
      dispatch(s, { type: "async-set-running", running: true })
      dispatch(s, { type: "async-assistant-done", messageId: "a1" })
      expect(s.store.asyncPanel!.done).toBe(true)
      expect(s.store.asyncPanel!.running).toBe(false)
    })
  })
})

describe("dispatch: ship observability", () => {
  const snapshot = {
    sessionId: "s1",
    runId: "ship-run-1",
    request: "add export output",
    status: "running" as const,
    attempt: 1,
    maxAttempts: 3,
    branch: "ship/add-export-output-12345678",
    phases: [
      { id: "preflight" as const, status: "pass" as const },
      { id: "plan" as const, status: "running" as const },
      { id: "implement" as const, status: "pending" as const },
      { id: "verify" as const, status: "pending" as const },
      { id: "publish" as const, status: "pending" as const },
    ],
  }

  test("replaces a run snapshot instead of appending duplicate cards", () => {
    withRoot(() => {
      const state = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(state, { type: "ship-update", snapshot })
      dispatch(state, {
        type: "ship-update",
        snapshot: { ...snapshot, attempt: 2, reason: "A test still fails" },
      })

      expect(state.store.shipRuns).toHaveLength(1)
      expect(state.store.shipRuns[0]).toMatchObject({
        runId: "ship-run-1",
        attempt: 2,
        reason: "A test still fails",
      })
    })
  })
})
