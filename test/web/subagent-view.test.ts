import { describe, expect, test } from "bun:test"
import { groupMessageParts } from "../../web/src/message-parts"
import { formatTokens, tokenPercentage } from "../../web/src/subagent-view"
import type { MessagePart } from "../../web/src/types"

const subAgent: Extract<MessagePart, { type: "tool" }> = {
  type: "tool",
  tool: "subagent",
  callId: "parent-1",
  status: "running",
  input: { profile: "finder", prompt: "Inspect authentication" },
  subAgent: {
    profile: "finder",
    modelName: "opencode/deepseek-v4-pro",
    prompt: "Inspect authentication",
    tools: [],
    tokensUsed: 3_900,
    tokenLimit: 1_000_000,
    done: false,
  },
}

describe("web subagent view", () => {
  test("keeps subagents outside generic tool groups", () => {
    const read: MessagePart = { type: "tool", tool: "read", callId: "read-1", status: "completed", input: {} }
    const grep: MessagePart = { type: "tool", tool: "grep", callId: "grep-1", status: "completed", input: {} }

    expect(groupMessageParts([read, subAgent, grep]).map((item) => item.type)).toEqual(["tools", "part", "tools"])
  })

  test("formats token meter values", () => {
    expect(formatTokens(3_900)).toBe("3.9k")
    expect(formatTokens(1_000_000)).toBe("1000k")
    expect(tokenPercentage(3_900, 1_000_000)).toBeCloseTo(0.39)
    expect(tokenPercentage(10, 0)).toBe(0)
  })
})
