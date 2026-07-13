// Session branching — task-first replacement for automatic compaction

import { generateId, generateText, type LanguageModel, type ModelMessage } from "ai"
import { getTask } from "../task/task"
import { getContextWindow, getLastInputTokens, estimateTokens, isOverContextThreshold } from "./context"
import { createSession, getSession, listAllSessions, updateSession, type Session } from "./session"
import { saveUserMessage, type MessageRow, type PartRow } from "./message"
import { appendEvents } from "../storage/session-jsonl"
import type { MessageEvent, PartEvent, MessageEndEvent } from "../storage/session-format"
import { warn } from "../notification/notification"

const SUMMARY_PROMPT = `Analyze this conversation and produce a continuation context for a child branch session.

1. Identify all relevant files that should be loaded into the next session's context. Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work. List them under a "## Files" heading as bullet points with absolute paths when known, or relative paths from the project root.

2. Draft the context and goal description under a "## Context" heading. Describe what we're working on and provide whatever context helps continue the work. Preserve: decisions, constraints, user preferences, technical patterns. Exclude: conversation back-and-forth, dead ends, meta-commentary. Structure it based on what fits—could be tasks, findings, a simple paragraph, or detailed steps.

The user controls what context matters. If they mentioned something to preserve, include it—trust their judgment about their workflow.

Be factual and concise. The output will be frozen and reused for every subsequent sibling branch, so make it self-contained and durable.`

export interface BranchResult {
  sessionId: string
  created: boolean
  summary: string
}

export interface SummarizeForBranchInput {
  messages: MessageRow[]
  parts: PartRow[]
  model: LanguageModel
  abort?: AbortSignal
}

export interface AutoBranchInput extends SummarizeForBranchInput {
  sessionId: string
  profile: string
}

export interface CreateBranchInput {
  sessionId: string
  summary: string
  prompt?: string
  profile: string
  filesModified?: string[] | null
  recentMessages?: MessageRow[]
  recentParts?: PartRow[]
}

export type SplitResult = {
  oldMessages: MessageRow[]
  oldParts: PartRow[]
  recentMessages: MessageRow[]
  recentParts: PartRow[]
}

/**
 * Strip tool/runtime parts, then split into old history and recent context.
 * Old history is summarized. Recent messages are replayed into the child
 * session as text conversation context.
 */
export function splitMessages(
  messages: MessageRow[],
  parts: PartRow[],
  keepMessages = 3,
): SplitResult {
  const stripped = stripForBranch(messages, parts)
  const cutoff = Math.max(0, stripped.messages.length - keepMessages)

  const oldIds = new Set<string>()
  const recentIds = new Set<string>()
  for (let i = 0; i < stripped.messages.length; i++) {
    const id = stripped.messages[i]!.id
    if (i < cutoff) oldIds.add(id)
    else recentIds.add(id)
  }

  return {
    oldMessages: stripped.messages.slice(0, cutoff),
    oldParts: stripped.parts.filter((p) => oldIds.has(p.messageId)),
    recentMessages: stripped.messages.slice(cutoff),
    recentParts: stripped.parts.filter((p) => recentIds.has(p.messageId)),
  }
}

export function shouldBranchWithRealTokens(
  system: string | string[],
  modelMessages: ModelMessage[],
  modelLimit: { context: number; input?: number; output: number } | null,
  threshold: number,
  parts: PartRow[],
): boolean {
  const limit = getContextWindow(modelLimit)
  if (limit === 0) return false

  const realTokens = getLastInputTokens(parts)
  if (realTokens > 0) return isOverContextThreshold(realTokens, limit, threshold)

  const systemStr = Array.isArray(system) ? system.join("\n") : system
  return isOverContextThreshold(estimateTokens(systemStr, modelMessages), limit, threshold)
}

export function findSessionByPrefix(prefix: string): Session | null {
  const matches = listAllSessions().filter((session) => session.id.startsWith(prefix))
  if (matches.length > 1) {
    throw new Error(`Session prefix "${prefix}" is ambiguous`)
  }
  return matches[0] ?? null
}

export function getSessionLineage(sessionId: string): Session[] {
  const lineage: Session[] = []
  const seen = new Set<string>()
  let current: Session | null = getSession(sessionId)

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    lineage.unshift(current)
    current = current.parentSessionId ? getSession(current.parentSessionId) : null
  }

  return lineage
}

export function buildLineageContext(sessionId: string): string {
  const session = getSession(sessionId)
  const task = session.taskId ? getTask(session.taskId) : null
  const lineage = getSessionLineage(sessionId)
  const lines: string[] = []

  if (task) {
    lines.push(`Task: ${task.description}`)
  }

  for (let i = 0; i < lineage.length; i++) {
    const node = lineage[i]!
    const child = lineage[i + 1]
    const summary = child?.parentSummary ?? node.summary
    if (summary) lines.push(`Session ${node.id.slice(0, 8)}: ${summary}`)
  }

  return lines.join("\n")
}

export function extractLastUserText(messages: MessageRow[], parts: PartRow[]): string {
  const byMessage = groupParts(parts)

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== "user") continue
    const text = textForMessage(msg.id, byMessage)
    if (text) return text
  }

  return ""
}

export function buildTextTranscript(
  messages: MessageRow[],
  parts: PartRow[],
): string {
  const roleMap = new Map<string, string>()
  const abortedIds = new Set<string>()
  for (const msg of messages) {
    roleMap.set(msg.id, msg.role)
    if (msg.finish === "aborted") abortedIds.add(msg.id)
  }

  const chunks: string[] = []

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (abortedIds.has(part.messageId)) continue
    if (part.type !== "text" && part.type !== "summary") continue

    const role = roleMap.get(part.messageId)
    if (!role) continue

    let text: string
    try {
      const data = JSON.parse(part.data) as { text?: string }
      text = data.text ?? ""
    } catch {
      continue
    }
    if (!text) continue

    const chunk = `${role}: ${text}`
    chunks.unshift(chunk)
  }

  return chunks.join("\n\n")
}

/**
 * Signature: `summarizeForBranch(input: SummarizeForBranchInput): Promise<string>`
 *
 * @example
 * ```ts
 * const summary = await summarizeForBranch({ messages, parts, model })
 * ```
 */
export async function summarizeForBranch(input: SummarizeForBranchInput): Promise<string> {
  const { oldMessages, oldParts } = splitMessages(input.messages, input.parts)

  if (oldMessages.length === 0) return ""

  const transcript = buildTextTranscript(oldMessages, oldParts)
  if (!transcript) return fallbackSummary()

  try {
    const result = await generateText({
      model: input.model,
      messages: [{ role: "user", content: `${SUMMARY_PROMPT}\n\n${transcript}` }],
      abortSignal: input.abort,
      maxRetries: 1,
    })
    const text = result.text.trim()
    if (!text) {
      warn("Branch Summary", "Could not summarize older session history. The branch will use recent conversation context instead.")
      return fallbackSummary()
    }
    return text
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    warn("Branch Summary", `Could not summarize older session history. The branch will use recent conversation context instead. (${cause.slice(0, 80)})`)
    return fallbackSummary()
  }
}

/**
 * Signature: `autoBranch(input: AutoBranchInput): Promise<BranchResult>`
 *
 * @example
 * ```ts
 * const branch = await autoBranch({ sessionId, messages, parts, model, profile: "coder" })
 * ```
 */
export async function autoBranch(input: AutoBranchInput): Promise<BranchResult> {
  const parent = getSession(input.sessionId)
  const existing = parent.summary?.trim()
  const summary = existing && existing.length > 0 ? existing : await summarizeForBranch(input)
  const { recentMessages, recentParts } = splitMessages(input.messages, input.parts)
  return createBranch({
    sessionId: input.sessionId,
    summary,
    profile: input.profile,
    recentMessages,
    recentParts,
  })
}

/**
 * Signature: `createBranch(input: CreateBranchInput): BranchResult`
 *
 * @example
 * ```ts
 * const branch = createBranch({
 *   sessionId,
 *   summary: "Implemented task metadata",
 *   prompt: "Continue with branch routing",
 *   profile: "coder",
 * })
 * ```
 */
export function createBranch(input: CreateBranchInput): BranchResult {
  const parent = getSession(input.sessionId)
  const taskId = parent.taskId
  if (!taskId) {
    throw new Error(
      `Cannot branch session ${parent.id}: parent has no taskId. ` +
        `initializeSessionFromMessage must run before branching.`,
    )
  }
  const filesModified = input.filesModified ?? parent.filesModified
  // Frozen-snapshot semantics: once the parent's summary is set, reuse it for
  // every subsequent child branch. Siblings share the same parentSummary.
  const existingParentSummary = parent.summary?.trim()
  const summary =
    existingParentSummary && existingParentSummary.length > 0
      ? existingParentSummary
      : input.summary.trim()

  const parentPatch: { summary?: string; filesModified?: string[] | null } = {
    filesModified,
  }
  // Only persist summary on the parent the first time it's frozen.
  if (!existingParentSummary && summary) parentPatch.summary = summary
  updateSession(parent.id, parentPatch)

  const child = createSession({
    directory: parent.directory ?? undefined,
    parentSessionId: parent.id,
    kind: "main",
    taskId,
    parentSummary: summary || null,
    filesModified,
  })

  const lineageContext = buildLineageContext(child.id)
  const now = Date.now()

  // 1. Save summary/lineage as the first user message.
  const seedText = lineageContext || summary
  if (seedText) {
    saveUserMessage({ sessionId: child.id, text: seedText })
  }

  // 2. Replay stripped recent messages into the child session.
  if (input.recentMessages && input.recentMessages.length > 0) {
    const strippedRecent = stripForBranch(input.recentMessages, input.recentParts ?? [])
    const recentParts = strippedRecent.parts
    const partsByMsg = new Map<string, PartRow[]>()
    for (const p of recentParts) {
      const list = partsByMsg.get(p.messageId) ?? []
      list.push(p)
      partsByMsg.set(p.messageId, list)
    }

    for (const msg of strippedRecent.messages) {
      const messageId = generateId()
      const events: (MessageEvent | PartEvent | MessageEndEvent)[] = []

      events.push({
        v: 1,
        ts: now,
        sessionId: child.id,
        type: "message",
        messageId,
        role: msg.role,
        modelId: msg.modelId,
        providerId: msg.providerId,
        timeCreated: msg.timeCreated,
      })

      for (const part of partsByMsg.get(msg.id) ?? []) {
        let data: unknown
        try {
          data = JSON.parse(part.data)
        } catch {
          continue
        }

        events.push({
          v: 1,
          ts: now,
          sessionId: child.id,
          type: "part",
          messageId,
          partId: generateId(),
          partType: part.type,
          data,
        })
      }

      if (msg.finish) {
        events.push({
          v: 1,
          ts: now,
          sessionId: child.id,
          type: "message-end",
          messageId,
          finish: msg.finish,
          cost: msg.cost,
          tokensIn: msg.tokensIn,
          tokensOut: msg.tokensOut,
          timeCompleted: msg.timeCompleted ?? now,
        })
      }

      appendEvents(child.id, events)
    }
  }

  // 3. Append the steer goal as the final user message
  const prompt = input.prompt?.trim()
  if (prompt) {
    saveUserMessage({ sessionId: child.id, text: prompt, variant: "steer" })
  }

  return { sessionId: child.id, created: true, summary }
}

/** Sentinel used when the summary API is unavailable or returns empty. */
export const BRANCH_FALLBACK_SUMMARY =
  "Fallback context: Unable to summarize older session history. Continue from the recent conversation context preserved in this branch."

function fallbackSummary(): string {
  return BRANCH_FALLBACK_SUMMARY
}

function stripForBranch(
  messages: MessageRow[],
  parts: PartRow[],
): { messages: MessageRow[]; parts: PartRow[] } {
  // Exclude aborted messages so partial content is not copied into child sessions
  const abortedIds = new Set<string>()
  for (const m of messages) {
    if (m.finish === "aborted") abortedIds.add(m.id)
  }
  const keptParts = parts.filter((p) =>
    (p.type === "text" || p.type === "summary") && !abortedIds.has(p.messageId)
  )
  const idsWithParts = new Set(keptParts.map((p) => p.messageId))
  return {
    messages: messages.filter((m) => idsWithParts.has(m.id) && !abortedIds.has(m.id)),
    parts: keptParts,
  }
}

function groupParts(parts: PartRow[]): Map<string, PartRow[]> {
  const byMessage = new Map<string, PartRow[]>()
  for (const part of parts) {
    const list = byMessage.get(part.messageId) ?? []
    list.push(part)
    byMessage.set(part.messageId, list)
  }
  return byMessage
}

function textForMessage(messageId: string, byMessage: Map<string, PartRow[]>): string {
  const texts: string[] = []
  for (const part of byMessage.get(messageId) ?? []) {
    if (part.type !== "text" && part.type !== "summary") continue
    try {
      const data = JSON.parse(part.data) as { text?: string }
      if (data.text) texts.push(data.text)
    } catch {
      continue
    }
  }
  return texts.join("\n").trim()
}
