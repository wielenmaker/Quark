import { describe, it, expect } from "bun:test"
import { splitMessages } from "../../src/session/branch"
import type { MessageRow, PartRow } from "../../src/session/message"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0
function id(): string {
  return `id-${++counter}`
}

function msg(id: string, role: "user" | "assistant"): MessageRow {
  return {
    id,
    sessionId: "s1",
    role,
    modelId: null,
    providerId: null,
    finish: role === "assistant" ? "stop" : null,
    cost: null,
    tokensIn: null,
    tokensOut: null,
    timeCreated: Date.now(),
    timeCompleted: Date.now(),
  }
}

function textPart(messageId: string, text: string): PartRow {
  return {
    id: id(),
    messageId,
    sessionId: "s1",
    type: "text",
    data: JSON.stringify({ text }),
  }
}

function toolPart(messageId: string): PartRow {
  return {
    id: id(),
    messageId,
    sessionId: "s1",
    type: "tool",
    data: JSON.stringify({ tool: "read", callId: id(), status: "completed", input: {}, output: "ok" }),
  }
}

function stepFinishPart(messageId: string): PartRow {
  return {
    id: id(),
    messageId,
    sessionId: "s1",
    type: "step-finish",
    data: JSON.stringify({ reason: "stop", tokens: { input: 100, output: 50 } }),
  }
}

function imagePart(messageId: string): PartRow {
  return {
    id: id(),
    messageId,
    sessionId: "s1",
    type: "image",
    data: JSON.stringify({ mime: "image/png", data: "base64" }),
  }
}

function makeMessages(pairs: number): { messages: MessageRow[]; parts: PartRow[] } {
  const messages: MessageRow[] = []
  const parts: PartRow[] = []
  for (let i = 0; i < pairs; i++) {
    const uid = `u${i}`
    const aid = `a${i}`
    messages.push(msg(uid, "user"))
    messages.push(msg(aid, "assistant"))
    parts.push(textPart(uid, `user message ${i}`))
    parts.push(textPart(aid, `assistant response ${i}`))
  }
  return { messages, parts }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("splitMessages", () => {
  it("splits at the last 3 messages", () => {
    const { messages, parts } = makeMessages(5)

    const result = splitMessages(messages, parts, 3)

    expect(result.oldMessages.length).toBe(7)
    expect(result.oldMessages[0]!.id).toBe("u0")
    expect(result.oldMessages[6]!.id).toBe("u3")
    expect(result.oldParts.length).toBe(7)

    expect(result.recentMessages.length).toBe(3)
    expect(result.recentMessages.map((m) => m.id)).toEqual(["a3", "u4", "a4"])
    expect(result.recentParts.length).toBe(3)
  })

  it("keeps all messages when fewer than keepMessages", () => {
    const { messages, parts } = makeMessages(1)

    const result = splitMessages(messages, parts, 3)

    expect(result.oldMessages.length).toBe(0)
    expect(result.oldParts.length).toBe(0)
    expect(result.recentMessages.length).toBe(2)
    expect(result.recentParts.length).toBe(2)
  })

  it("splits nothing when exactly keepMessages", () => {
    const messages = [msg("u0", "user"), msg("a0", "assistant"), msg("u1", "user")]
    const parts = [
      textPart("u0", "first"),
      textPart("a0", "resp1"),
      textPart("u1", "second"),
    ]

    const result = splitMessages(messages, parts, 3)

    expect(result.oldMessages.length).toBe(0)
    expect(result.oldParts.length).toBe(0)
    expect(result.recentMessages.map((m) => m.id)).toEqual(["u0", "a0", "u1"])
    expect(result.recentParts.length).toBe(3)
  })

  it("handles trailing user message with no assistant response", () => {
    const messages: MessageRow[] = [
      msg("u0", "user"),
      msg("a0", "assistant"),
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
      msg("u3", "user"), // no assistant response yet
    ]
    const parts: PartRow[] = [
      textPart("u0", "first"),
      textPart("a0", "resp1"),
      textPart("u1", "second"),
      textPart("a1", "resp2"),
      textPart("u2", "third"),
      textPart("a2", "resp3"),
      textPart("u3", "fourth"),
    ]

    const result = splitMessages(messages, parts, 3)

    expect(result.oldMessages.length).toBe(4)
    expect(result.oldMessages[0]!.id).toBe("u0")
    expect(result.oldMessages[3]!.id).toBe("a1")

    expect(result.recentMessages.map((m) => m.id)).toEqual(["u2", "a2", "u3"])
  })

  it("correctly assigns parts to old vs recent", () => {
    const { messages, parts } = makeMessages(4)

    const result = splitMessages(messages, parts, 2)

    expect(result.oldParts.map((p) => p.messageId).sort()).toEqual(
      ["u0", "a0", "u1", "a1", "u2", "a2"].sort(),
    )
    expect(result.recentParts.map((p) => p.messageId).sort()).toEqual(
      ["u3", "a3"].sort(),
    )
  })

  it("keeps aborted assistant messages; downstream formatters skip them", () => {
    const messages: MessageRow[] = [
      msg("u0", "user"),
      { ...msg("a0", "assistant"), finish: "aborted" as const },
      msg("u1", "user"),
      msg("a1", "assistant"),
    ]
    const parts: PartRow[] = [
      textPart("u0", "first"),
      textPart("a0", "aborted response"),
      textPart("u1", "second"),
      textPart("a1", "valid response"),
    ]

    const result = splitMessages(messages, parts, 4)

    expect(result.recentMessages.map((m) => m.id)).toEqual(["u0", "a0", "u1", "a1"])
    expect(result.recentParts.map((p) => p.messageId)).toEqual(["u0", "a0", "u1", "a1"])
    expect(result.oldMessages.length).toBe(0)
  })

  it("counts aborted messages in the split", () => {
    const messages: MessageRow[] = [
      msg("u0", "user"),
      { ...msg("a0", "assistant"), finish: "aborted" as const },
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
    ]
    const parts: PartRow[] = [
      textPart("u0", "q0"),
      textPart("a0", "aborted"),
      textPart("u1", "q1"),
      textPart("a1", "r1"),
      textPart("u2", "q2"),
      textPart("a2", "r2"),
    ]

    const result = splitMessages(messages, parts, 3)

    expect(result.oldMessages.map((m) => m.id)).toEqual(["u0", "a0", "u1"])
    expect(result.recentMessages.map((m) => m.id)).toEqual(["a1", "u2", "a2"])
  })

  it("keeps tool and runtime parts for recent context", () => {
    const messages = [
      msg("u0", "user"),
      msg("a0", "assistant"),
      msg("a-tool-only", "assistant"),
      msg("u1", "user"),
    ]
    const parts = [
      textPart("u0", "first"),
      textPart("a0", "answer"),
      toolPart("a0"),
      imagePart("a0"),
      stepFinishPart("a0"),
      toolPart("a-tool-only"),
      textPart("u1", "second"),
    ]

    const result = splitMessages(messages, parts, 3)

    expect(result.recentMessages.map((m) => m.id)).toEqual(["a0", "a-tool-only", "u1"])
    expect(result.recentParts.map((p) => p.type)).toEqual([
      "text",
      "tool",
      "image",
      "step-finish",
      "tool",
      "text",
    ])
  })
})
