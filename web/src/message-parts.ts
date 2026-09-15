import type { MessagePart } from "./types"

type ToolPart = Extract<MessagePart, { type: "tool" }>

export type DisplayItem =
  | { type: "part"; part: MessagePart }
  | { type: "tools"; parts: ToolPart[] }

export function groupMessageParts(parts: MessagePart[]): DisplayItem[] {
  const items: DisplayItem[] = []
  let tools: ToolPart[] = []
  const flushTools = () => {
    if (tools.length) items.push({ type: "tools", parts: tools })
    tools = []
  }

  for (const part of parts) {
    if (part.type === "tool" && part.tool !== "subagent" && !part.subAgent) {
      tools.push(part)
      continue
    }
    flushTools()
    items.push({ type: "part", part })
  }
  flushTools()
  return items
}
