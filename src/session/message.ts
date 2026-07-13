// Message persistence — save, load, convert to AI SDK ModelMessage format
//
// Backed by per-session JSONL files instead of SQLite.
// All writes are append-only events. Reads replay the JSONL file.
//
// Key change: updatePart() is replaced by appendPartSnapshot() which appends
// a new PartEvent for the same partId (later events overwrite earlier ones
// during replay).

import { generateId } from "ai"
import type { ModelMessage, AssistantModelMessage, ToolModelMessage } from "ai"
import { appendEvents, replaySessionFile } from "../storage/session-jsonl"
import type { ToolResultContentPart } from "../tool/tool"
import type {
  MessageEvent,
  PartEvent,
  MessageEndEvent,
} from "../storage/session-format"

// ---- Types for Part data blobs ----

export interface TextPartData {
  text: string
  variant?: "steer"
}

export interface ToolPartData {
  tool: string
  callId: string
  status: "pending" | "awaiting_approval" | "running" | "completed" | "error"
  input: Record<string, unknown>
  output?: string
  error?: string
  /** Multi-modal content parts (text + images) for LLM replay.
   *  When present, toModelMessages uses { type: "content", value: [...] }
   *  instead of { type: "text", value: string }. */
  contentParts?: ToolResultContentPart[]
  // Optional streaming content for long-running tool outputs (e.g. write).
  // Stored so the TUI can restore in-progress streaming views after reload.
  streamingContent?: string
}

export interface StepFinishData {
  reason: string
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  cost?: number
}

export interface SummaryData {
  text: string
}

export interface ImagePartData {
  mime: string
  data: string // base64
}

export interface ReasoningPartData {
  text: string
}

// ---- DB row types (kept for API stability) ----

export interface MessageRow {
  id: string
  sessionId: string
  role: "user" | "assistant"
  modelId: string | null
  providerId: string | null
  finish: "stop" | "tool-calls" | "length" | "aborted" | null
  cost: number | null
  tokensIn: number | null
  tokensOut: number | null
  timeCreated: number
  timeCompleted: number | null
}

export interface PartRow {
  id: string
  messageId: string
  sessionId: string
  type: "text" | "tool" | "step-start" | "step-finish" | "summary" | "image" | "reasoning"
  data: string // JSON
}

// ---- Save operations ----

export function saveUserMessage(input: {
  sessionId: string
  text: string
  images?: { mime: string; data: string }[]
  variant?: "steer"
}): MessageRow {
  const now = Date.now()
  const msgId = generateId()
  const partId = generateId()

  const msgEvent: MessageEvent = {
    v: 1,
    ts: now,
    sessionId: input.sessionId,
    type: "message",
    messageId: msgId,
    role: "user",
    modelId: null,
    providerId: null,
    timeCreated: now,
  }

  const partEvent: PartEvent = {
    v: 1,
    ts: now,
    sessionId: input.sessionId,
    type: "part",
    messageId: msgId,
    partId,
    partType: "text",
    data: { text: input.text, variant: input.variant } satisfies TextPartData,
  }

  const events: (MessageEvent | PartEvent | MessageEndEvent)[] = [msgEvent, partEvent]

  // Image parts
  for (const img of input.images ?? []) {
    events.push({
      v: 1,
      ts: now,
      sessionId: input.sessionId,
      type: "part",
      messageId: msgId,
      partId: generateId(),
      partType: "image",
      data: { mime: img.mime, data: img.data } satisfies ImagePartData,
    })
  }

  // User messages are immediately complete
  const endEvent: MessageEndEvent = {
    v: 1,
    ts: now,
    sessionId: input.sessionId,
    type: "message-end",
    messageId: msgId,
    finish: "stop",
    cost: null,
    tokensIn: null,
    tokensOut: null,
    timeCompleted: now,
  }
  events.push(endEvent)

  appendEvents(input.sessionId, events)

  return {
    id: msgId,
    sessionId: input.sessionId,
    role: "user",
    modelId: null,
    providerId: null,
    finish: null,
    cost: null,
    tokensIn: null,
    tokensOut: null,
    timeCreated: now,
    timeCompleted: now,
  }
}

export function createAssistantMessage(input: {
  sessionId: string
  modelId?: string
  providerId?: string
}): MessageRow {
  const now = Date.now()
  const msgId = generateId()

  const event: MessageEvent = {
    v: 1,
    ts: now,
    sessionId: input.sessionId,
    type: "message",
    messageId: msgId,
    role: "assistant",
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    timeCreated: now,
  }

  appendEvents(input.sessionId, [event])

  return {
    id: msgId,
    sessionId: input.sessionId,
    role: "assistant",
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    finish: null,
    cost: null,
    tokensIn: null,
    tokensOut: null,
    timeCreated: now,
    timeCompleted: null,
  }
}

export function addPart(input: {
  messageId: string
  sessionId: string
  type: "text" | "tool" | "step-start" | "step-finish" | "summary" | "reasoning"
  data: TextPartData | ToolPartData | StepFinishData | SummaryData | ReasoningPartData | Record<string, never>
}): string {
  const id = generateId()

  const event: PartEvent = {
    v: 1,
    ts: Date.now(),
    sessionId: input.sessionId,
    type: "part",
    messageId: input.messageId,
    partId: id,
    partType: input.type,
    data: input.data,
  }

  appendEvents(input.sessionId, [event])
  return id
}

/**
 * Append a new snapshot for an existing part (replaces mutable updatePart).
 *
 * During JSONL replay, later PartEvents with the same partId overwrite
 * earlier ones — so this effectively "updates" the part.
 */
export function updatePart(
  id: string,
  data: TextPartData | ToolPartData | StepFinishData | SummaryData | Record<string, never>,
  /** Session ID — required for JSONL append. Callers must provide this. */
  sessionId?: string,
  /** Message ID — required for JSONL append. Callers must provide this. */
  messageId?: string,
  /** Part type — required for JSONL append. Callers must provide this. */
  partType?: string,
): void {
  // If session/message/type context is missing, we cannot write the event.
  // This maintains backward compatibility — processor.ts will be updated
  // to always pass these.
  if (!sessionId || !messageId || !partType) return

  const event: PartEvent = {
    v: 1,
    ts: Date.now(),
    sessionId,
    type: "part",
    messageId,
    partId: id,
    partType: partType as PartEvent["partType"],
    data,
  }

  appendEvents(sessionId, [event])
}

export function finishMessage(
  id: string,
  finish: "stop" | "tool-calls" | "length" | "aborted",
  usage?: { tokensIn?: number; tokensOut?: number; cost?: number },
  /** Session ID — required for JSONL append. */
  sessionId?: string,
): void {
  // Session ID is required for JSONL. Callers will be updated.
  if (!sessionId) return

  const event: MessageEndEvent = {
    v: 1,
    ts: Date.now(),
    sessionId,
    type: "message-end",
    messageId: id,
    finish,
    cost: usage?.cost ?? null,
    tokensIn: usage?.tokensIn ?? null,
    tokensOut: usage?.tokensOut ?? null,
    timeCompleted: Date.now(),
  }

  appendEvents(sessionId, [event])
}

export function isAbortedMessage(msg: MessageRow): boolean {
  return msg.finish === "aborted"
}

// ---- Format conversation as text ----

export interface FormatConversationOptions {
  includeToolCalls?: boolean
  includeReasoning?: boolean
  userPrefix?: string
  assistantPrefix?: string
  separator?: string
  prefixSeparator?: string
}

export function formatConversation(
  messages: MessageRow[],
  parts: PartRow[],
  opts: FormatConversationOptions = {},
): string {
  const {
    includeToolCalls = false,
    includeReasoning = false,
    userPrefix = "User",
    assistantPrefix = "Assistant",
    separator = "\n\n",
    prefixSeparator = ": ",
  } = opts

  const abortedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.finish === "aborted") abortedIds.add(msg.id)
  }

  const partsByMsg = new Map<string, PartRow[]>()
  for (const part of parts) {
    const list = partsByMsg.get(part.messageId) ?? []
    list.push(part)
    partsByMsg.set(part.messageId, list)
  }

  const chunks: string[] = []
  for (const msg of messages) {
    if (abortedIds.has(msg.id)) continue

    const msgParts = partsByMsg.get(msg.id) ?? []
    const lines: string[] = []

    for (const part of msgParts) {
      if (part.type === "text") {
        const d = JSON.parse(part.data) as TextPartData
        if (d.text) lines.push(d.text)
      } else if (part.type === "summary") {
        const d = JSON.parse(part.data) as SummaryData
        if (d.text) lines.push(d.text)
      } else if (part.type === "reasoning" && includeReasoning) {
        const d = JSON.parse(part.data) as ReasoningPartData
        if (d.text) lines.push(d.text)
      } else if (part.type === "tool" && includeToolCalls) {
        const d = JSON.parse(part.data) as ToolPartData
        lines.push(`→ ${d.tool}${formatToolInput(d.input)}`)
      }
    }

    if (lines.length === 0) continue
    const prefix = msg.role === "user" ? userPrefix : assistantPrefix
    chunks.push(`${prefix}${prefixSeparator}${lines.join("\n")}`)
  }

  return chunks.join(separator)
}

function formatToolInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return ""
  const parts = keys.map((k) => `${k}=${JSON.stringify(input[k])}`)
  return `(${parts.join(", ")})`
}

// ---- Load operations ----

export function loadMessages(sessionId: string): {
  messages: MessageRow[]
  parts: PartRow[]
} {
  const { messages, parts } = replaySessionFile(sessionId)
  return { messages, parts }
}

// ---- Convert to AI SDK ModelMessage[] ----
//
// We construct ModelMessage[] directly rather than going through UIMessage +
// convertToModelMessages. This is simpler for our minimal agent — we know
// exactly what our Part shapes look like.

export function toModelMessages(
  messages: MessageRow[],
  parts: PartRow[],
): ModelMessage[] {
  // Filter out aborted assistant messages and their parts so partial
  // content does not pollute the model context on subsequent turns.
  const abortedIds = new Set<string>()
  for (const m of messages) {
    if (m.finish === "aborted") abortedIds.add(m.id)
  }
  const filteredMessages = abortedIds.size > 0
    ? messages.filter((m) => !abortedIds.has(m.id))
    : messages
  const filteredParts = abortedIds.size > 0
    ? parts.filter((p) => !abortedIds.has(p.messageId))
    : parts

  // Group parts by message ID
  const partsByMsg = new Map<string, PartRow[]>()
  for (const p of filteredParts) {
    const list = partsByMsg.get(p.messageId) ?? []
    list.push(p)
    partsByMsg.set(p.messageId, list)
  }

  // Find the latest anchor (compaction summary with compactedUntilMessageId).
  // Messages up to and including compactedUntilMessageId are replaced by the
  // anchor summary. The anchor message itself is also skipped.
  let anchorSummaryText: string | undefined
  let cutoffMessageId: string | undefined
  let anchorMessageId: string | undefined

  for (let i = filteredMessages.length - 1; i >= 0; i--) {
    const msg = filteredMessages[i]!
    if (msg.providerId !== "compaction") continue
    const msgParts = partsByMsg.get(msg.id) ?? []
    const summaryPart = msgParts.find((p) => p.type === "summary")
    if (!summaryPart) continue
    const d = JSON.parse(summaryPart.data) as { text: string; compactedUntilMessageId?: string }
    if (d.text) {
      anchorSummaryText = d.text
      cutoffMessageId = d.compactedUntilMessageId
      anchorMessageId = msg.id
      break
    }
  }

  const result: ModelMessage[] = []

  // If there's an anchor, inject its summary as the first user message
  if (anchorSummaryText) {
    result.push({ role: "user", content: anchorSummaryText })
  }

  // Determine start index: skip all messages up to and including the cutoff,
  // and also skip the anchor message itself
  let startIdx = 0
  if (cutoffMessageId) {
    // Find the cutoff message and start after it
    for (let i = 0; i < filteredMessages.length; i++) {
      if (filteredMessages[i]!.id === cutoffMessageId) {
        startIdx = i + 1
        break
      }
    }
  } else if (anchorMessageId) {
    // Legacy: no compactedUntilMessageId, skip up to anchor message
    for (let i = 0; i < filteredMessages.length; i++) {
      if (filteredMessages[i]!.id === anchorMessageId) {
        startIdx = i + 1
        break
      }
    }
  }

  for (let i = startIdx; i < filteredMessages.length; i++) {
    const msg = filteredMessages[i]!
    // Skip anchor messages — their content is already injected above
    if (msg.providerId === "compaction") continue
    const msgParts = partsByMsg.get(msg.id) ?? []

    if (msg.role === "user") {
      // Collect text and image parts
      const content: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType: string }> = []
      for (const p of msgParts) {
        if (p.type === "text") {
          const d = JSON.parse(p.data) as TextPartData
          if (d.text) content.push({ type: "text", text: d.text })
        } else if (p.type === "summary") {
          const d = JSON.parse(p.data) as SummaryData
          if (d.text) content.push({ type: "text", text: d.text })
        } else if (p.type === "image") {
          const d = JSON.parse(p.data) as ImagePartData
          content.push({ type: "image", image: d.data, mimeType: d.mime })
        }
      }
      if (content.length === 1 && content[0]?.type === "text") {
        result.push({ role: "user", content: content[0].text })
      } else if (content.length > 0) {
        result.push({ role: "user", content })
      }
      continue
    }

    // Assistant message — may contain text + tool calls
    // We need to emit:
    // 1. AssistantModelMessage with text + tool-call parts
    // 2. ToolModelMessage with tool results (one per completed tool)

    const assistantContent: Array<
      | { type: "text"; text: string }
      | { type: "reasoning"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    > = []

    const toolResults: Array<{
      type: "tool-result"
      toolCallId: string
      toolName: string
      output:
        | { type: "text"; value: string }
        | { type: "content"; value: ToolResultContentPart[] }
    }> = []

    for (const p of msgParts) {
      if (p.type === "text") {
        const d = JSON.parse(p.data) as TextPartData
        if (d.text) {
          assistantContent.push({ type: "text", text: d.text })
        }
      } else if (p.type === "summary") {
        const d = JSON.parse(p.data) as SummaryData
        assistantContent.push({ type: "text", text: d.text })
      } else if (p.type === "reasoning") {
        const d = JSON.parse(p.data) as ReasoningPartData
        if (d.text) {
          assistantContent.push({ type: "reasoning", text: d.text })
        }
      } else if (p.type === "tool") {
        const d = JSON.parse(p.data) as ToolPartData
        // Always add the tool call to assistant content
        assistantContent.push({
          type: "tool-call",
          toolCallId: d.callId,
          toolName: d.tool,
          input: d.input,
        })
        // Add result if completed or error
        if (d.status === "completed" || d.status === "error") {
          // Errors always use plain text output
          if (d.error) {
            toolResults.push({
              type: "tool-result",
              toolCallId: d.callId,
              toolName: d.tool,
              output: { type: "text", value: `Error: ${d.error}` },
            })
          } else if (d.contentParts && d.contentParts.length > 0) {
            // Multi-modal content parts (text + images) → use content-type output
            toolResults.push({
              type: "tool-result",
              toolCallId: d.callId,
              toolName: d.tool,
              output: { type: "content", value: d.contentParts },
            })
          } else {
            // Plain text output
            toolResults.push({
              type: "tool-result",
              toolCallId: d.callId,
              toolName: d.tool,
              output: { type: "text", value: d.output ?? "" },
            })
          }
        }
      }
      // step-start, step-finish are metadata — skip for LLM context
    }

    if (assistantContent.length > 0) {
      const msg: AssistantModelMessage = {
        role: "assistant",
        content: assistantContent,
      }
      result.push(msg)
    }

    if (toolResults.length > 0) {
      const msg: ToolModelMessage = {
        role: "tool",
        content: toolResults,
      }
      result.push(msg)
    }
  }

  return result
}
