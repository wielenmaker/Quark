import type { TypedBus } from "../session/events"
import type { ToolContext } from "../tool/tool"
import type { ChildEvent } from "./protocol"

/** Forward only live activity. Child state is never attached to tool metadata. */
export function forwardChildEvent(event: ChildEvent, ctx: ToolContext, profile: string, bus: TypedBus, text: string): string {
  const base = { sessionId: ctx.sessionId, messageId: ctx.messageId, parentCallId: ctx.callId, profile }
  switch (event.e) {
    case "tool-start": bus.emit("subagent-tool-start", { ...base, tool: event.t, callId: event.id }); break
    case "tool-input": bus.emit("subagent-tool-input", { ...base, tool: event.t, callId: event.id, input: event.in }); break
    case "tool-running": bus.emit("subagent-tool-running", { ...base, callId: event.id }); break
    case "tool-end":
      bus.emit("subagent-tool-end", { ...base, tool: event.t, callId: event.id, status: event.s, ...(event.err ? { error: event.err } : {}) })
      break
    case "step-finish":
      bus.emit("subagent-step-finish", { ...base, tokens: event.tokens, tokenLimit: event.tokenLimit, modelName: event.model })
      break
    case "text-delta":
      text = (text + event.d).slice(0, 50_000)
      bus.emit("subagent-text-delta", { ...base, text, delta: event.d })
      break
    case "error": bus.emit("subagent-error", { ...base, kind: event.kind, message: event.message }); break
    case "result": bus.emit("subagent-done", base); break
  }
  return text
}
