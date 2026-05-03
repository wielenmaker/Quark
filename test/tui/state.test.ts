// Tests for SolidJS state layer — createAppState + dispatch
//
// SolidJS stores need a reactive owner (createRoot) to work properly.

import { describe, test, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createAppState, dispatch } from "../../src/tui/state"
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
      expect(store.status.tokenLimit).toBeGreaterThan(0)
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

describe("dispatch: message lifecycle", () => {
  test("add-user-message appends a user message", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-user-message", id: "m1", text: "hello world" })
      expect(s.store.messages.length).toBe(1)
      expect(s.store.messages[0]!.role).toBe("user")
      expect(s.store.messages[0]!.parts.length).toBe(1)
      expect(s.store.messages[0]!.parts[0]!.type).toBe("text")
      expect((s.store.messages[0]!.parts[0] as any).text).toBe("hello world")
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

  test("tool-input-delta streams inputPreview on pending tool", () => {
    withRoot(() => {
      const s = createAppState({ sessionId: "s1", modelName: "smart", skillCount: 0 })
      dispatch(s, { type: "add-assistant-message", id: "m1" })
      dispatch(s, { type: "tool-start", messageId: "m1", tool: "read", callId: "c1" })

      // First delta
      dispatch(s, { type: "tool-input-delta", messageId: "m1", callId: "c1", delta: '{"path":' })
      const part1 = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part1.status).toBe("pending")
      expect(part1.inputPreview).toBe('{"path":')

      // Second delta — accumulates
      dispatch(s, { type: "tool-input-delta", messageId: "m1", callId: "c1", delta: '{"path":"/foo.ts"}' })
      const part2 = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part2.inputPreview).toBe('{"path":"/foo.ts"}')

      // tool-input replaces inputPreview with full parsed input
      dispatch(s, { type: "tool-input", messageId: "m1", callId: "c1", input: { path: "/foo.ts" } })
      const part3 = s.store.messages[0]!.parts[0]! as Extract<TuiPart, { type: "tool" }>
      expect(part3.status).toBe("awaiting_approval")
      expect(part3.input).toEqual({ path: "/foo.ts" })
      // inputPreview is preserved (not cleared)
      expect(part3.inputPreview).toBe('{"path":"/foo.ts"}')
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
