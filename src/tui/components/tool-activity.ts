import type { TuiMessage, TuiPart } from "../state"

export type ToolPart = Extract<TuiPart, { type: "tool" }>
export type ToolActivityKind = "explore" | "modify" | "internet" | "command" | "other"

export type ToolActivityItem =
  | { type: "part"; part: TuiPart }
  | { type: "activity"; kind: ToolActivityKind; tools: ToolPart[] }

/** Keep the latest tool activity open only while tools are the current work. */
export function getContinuingToolCallId(messages: TuiMessage[], running: boolean): string | null {
  if (!running) return null

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]!
    if (message.role !== "assistant") return null

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex]!
      if (part.type !== "tool" || part.subAgent) return null
      return part.callId
    }
  }

  return null
}

const ACTIVITY_TOOLS: Record<string, ToolActivityKind> = {
  read: "explore",
  grep: "explore",
  glob: "explore",
  write: "modify",
  edit: "modify",
  websearch: "internet",
  webfetch: "internet",
  "perplexity-search": "internet",
  bash: "command",
}

export const ACTIVITY_LABELS: Record<ToolActivityKind, { active: string; done: string }> = {
  explore: { active: "Exploring the codebase", done: "Explored the codebase" },
  modify: { active: "Modifying code", done: "Modified code" },
  internet: { active: "Searching the internet", done: "Searched the internet" },
  command: { active: "Running commands", done: "Ran commands" },
  other: { active: "Using tools", done: "Used tools" },
}

export function getToolActivityKind(tool: string): ToolActivityKind {
  return ACTIVITY_TOOLS[tool.toLowerCase()] ?? "other"
}

/** Collapse adjacent, same-purpose tool calls into a single progressive activity. */
export function groupMessageParts(parts: TuiPart[]): ToolActivityItem[] {
  const items: ToolActivityItem[] = []
  let previousActivity: Extract<ToolActivityItem, { type: "activity" }> | undefined

  for (const part of parts) {
    if (part.type !== "tool" || part.subAgent) {
      items.push({ type: "part", part })
      if (part.type === "tool") previousActivity = undefined
      continue
    }

    const kind = getToolActivityKind(part.tool)
    if (previousActivity?.kind === kind) {
      previousActivity.tools.push(part)
    } else {
      previousActivity = { type: "activity", kind, tools: [part] }
      items.push(previousActivity)
    }
  }

  return items
}

/**
 * Join adjacent assistant steps so same-purpose calls can render as one
 * activity even when reasoning or text occurs between them. A different tool
 * kind starts the next activity; user turns and steer dividers remain hard
 * boundaries. The array keeps its original indexes for divider placement.
 */
export function mergeToolActivityMessages(
  messages: TuiMessage[],
  blockedInsertionIndexes: ReadonlySet<number> = new Set(),
): Array<TuiMessage | undefined> {
  const merged: Array<TuiMessage | undefined> = new Array(messages.length)

  for (let start = 0; start < messages.length;) {
    const first = messages[start]!
    if (first.role !== "assistant") {
      merged[start] = first
      start++
      continue
    }

    let end = start + 1
    while (
      end < messages.length
      && !blockedInsertionIndexes.has(end)
      && messages[end]!.role === "assistant"
    ) {
      end++
    }

    if (end === start + 1) {
      merged[start] = first
    } else {
      const run = messages.slice(start, end)
      merged[start] = {
        ...first,
        parts: run.flatMap((message) => message.parts),
        streaming: run.some((message) => message.streaming),
      }
    }
    start = end
  }

  return merged
}
