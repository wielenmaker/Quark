import type { MessagePart, SubAgentState } from "./types"

type ToolPart = Extract<MessagePart, { type: "tool" }>

export type SubAgentEvent =
  | { type: "tool-start"; profile: string; tool: string; callId: string }
  | { type: "tool-input"; profile: string; callId: string; input: Record<string, unknown> }
  | { type: "tool-running"; profile: string; callId: string }
  | { type: "tool-end"; profile: string; callId: string; status: "completed" | "error"; error?: string }
  | { type: "step-finish"; profile: string; tokens?: { input?: number }; tokenLimit?: number; modelName?: string }
  | { type: "text-delta"; profile: string; text: string }
  | { type: "error"; profile: string; kind: "provider" | "process" | "protocol"; message: string }
  | { type: "done"; profile: string }

function inputString(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] : undefined
}

export function initializeSubAgent(part: ToolPart, now = Date.now()): SubAgentState {
  const profile = inputString(part.input, "profile") ?? "sub-agent"
  const prompt = inputString(part.input, "prompt")
  if (part.subAgent) {
    if (profile !== "sub-agent") part.subAgent.profile = profile
    if (prompt) part.subAgent.prompt = prompt
    return part.subAgent
  }
  part.subAgent = {
    profile,
    prompt,
    tools: [],
    tokensUsed: 0,
    tokenLimit: 0,
    done: part.status === "completed" || part.status === "error",
    ...(part.status === "pending" || part.status === "running" ? { startedAt: now } : {}),
  }
  return part.subAgent
}

export function finishSubAgent(part: ToolPart, now = Date.now()): void {
  const subAgent = part.subAgent
  if (!subAgent) return
  subAgent.done = true
  subAgent.textPreview = undefined
  if (subAgent.startedAt != null) subAgent.durationMs = now - subAgent.startedAt
  if (part.status === "error") {
    subAgent.error ??= { kind: "process", message: part.error ?? "Subagent stopped" }
    for (const tool of subAgent.tools) {
      if (tool.status === "pending" || tool.status === "running") tool.status = "error"
    }
  }
}

export function applySubAgentEvent(part: ToolPart, event: SubAgentEvent, now = Date.now()): void {
  if ((part.status === "completed" || part.status === "error") && event.type !== "error") return
  const subAgent = initializeSubAgent(part, now)
  subAgent.profile = event.profile

  if (event.type === "tool-start") {
    if (!subAgent.tools.some((tool) => tool.callId === event.callId)) {
      subAgent.tools.push({ tool: event.tool, callId: event.callId, status: "pending", input: {} })
    }
    subAgent.textPreview = undefined
  }
  if (event.type === "tool-input") {
    const tool = subAgent.tools.find((item) => item.callId === event.callId)
    if (tool) {
      tool.status = "pending"
      tool.input = event.input
    }
  }
  if (event.type === "tool-running") {
    const tool = subAgent.tools.find((item) => item.callId === event.callId)
    if (tool?.status === "pending") tool.status = "running"
  }
  if (event.type === "tool-end") {
    const tool = subAgent.tools.find((item) => item.callId === event.callId)
    if (tool) {
      tool.status = event.status
      tool.error = event.error
    }
  }
  if (event.type === "step-finish") {
    if (event.tokens?.input != null) subAgent.tokensUsed = event.tokens.input
    if (event.tokenLimit != null && event.tokenLimit > 0) subAgent.tokenLimit = event.tokenLimit
    if (event.modelName) subAgent.modelName = event.modelName
  }
  if (event.type === "text-delta") {
    subAgent.textPreview = event.text.length > 120 ? `…${event.text.slice(-119)}` : event.text
  }
  if (event.type === "error") {
    subAgent.error = { kind: event.kind, message: event.message }
    subAgent.textPreview = undefined
  }
  if (event.type === "done") {
    subAgent.done = true
    subAgent.textPreview = undefined
    if (subAgent.startedAt != null) subAgent.durationMs = now - subAgent.startedAt
    part.status = "completed"
  }
}
