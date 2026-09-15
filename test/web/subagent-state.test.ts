import { describe, expect, test } from "bun:test"
import { applySubAgentEvent, finishSubAgent, initializeSubAgent } from "../../web/src/subagent"
import type { MessagePart } from "../../web/src/types"

type ToolPart = Extract<MessagePart, { type: "tool" }>

function part(): ToolPart {
  return {
    type: "tool",
    tool: "subagent",
    callId: "parent-1",
    status: "running",
    input: { profile: "finder", prompt: "Inspect authentication" },
  }
}

describe("web subagent state", () => {
  test("initializes from the parent tool input", () => {
    const tool = part()
    const state = initializeSubAgent(tool, 1_000)

    expect(state).toMatchObject({
      profile: "finder",
      prompt: "Inspect authentication",
      tokensUsed: 0,
      tokenLimit: 0,
      done: false,
      startedAt: 1_000,
    })
  })

  test("tracks child tools, usage, completion, and elapsed time", () => {
    const tool = part()
    applySubAgentEvent(tool, { type: "tool-start", profile: "finder", tool: "read", callId: "child-1" }, 1_000)
    applySubAgentEvent(tool, { type: "tool-input", profile: "finder", callId: "child-1", input: { path: "src/auth.ts" } })
    applySubAgentEvent(tool, { type: "tool-running", profile: "finder", callId: "child-1" })
    applySubAgentEvent(tool, { type: "tool-end", profile: "finder", callId: "child-1", status: "completed" })
    applySubAgentEvent(tool, {
      type: "step-finish",
      profile: "finder",
      tokens: { input: 3_900 },
      tokenLimit: 1_000_000,
      modelName: "opencode/deepseek-v4-pro",
    })
    applySubAgentEvent(tool, { type: "done", profile: "finder" }, 5_000)

    expect(tool.status).toBe("completed")
    expect(tool.subAgent).toMatchObject({
      modelName: "opencode/deepseek-v4-pro",
      tokensUsed: 3_900,
      tokenLimit: 1_000_000,
      done: true,
      durationMs: 4_000,
      tools: [{ tool: "read", status: "completed", input: { path: "src/auth.ts" } }],
    })
  })

  test("turns unfinished child calls into errors when the parent fails", () => {
    const tool = part()
    applySubAgentEvent(tool, { type: "tool-start", profile: "finder", tool: "read", callId: "child-1" }, 1_000)
    tool.status = "error"
    tool.error = "Cancelled"
    finishSubAgent(tool, 2_500)

    expect(tool.subAgent?.done).toBe(true)
    expect(tool.subAgent?.durationMs).toBe(1_500)
    expect(tool.subAgent?.error).toEqual({ kind: "process", message: "Cancelled" })
    expect(tool.subAgent?.tools[0]?.status).toBe("error")
  })
})
