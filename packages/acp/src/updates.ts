// QUA-244 — runner bus → ACP `session/update` bridge.
//
// Each turn gets one isolated runner (see sessions.ts). This module subscribes
// to that runner's bus and translates Quark's streaming events into official
// ACP v1 `session/update` notifications via `client.notify`.
//
// Ordering: bus events fire synchronously while `runner.prompt()` runs, but
// `client.notify()` is async. Every translation goes through one serialized
// promise chain so notifications hit the wire in event order, and the chain is
// flushed before `session/prompt` responds. The parent (sessions.ts) awaits
// `SessionBridgeOptions.onTurnEnd` in `prompt()`'s `finally` — wired here to
// `onTurnEnd` — which also covers the error path (a rejected prompt must still
// flush queued updates before its JSON-RPC error is written).
//
// Deliberately NOT translated:
//   * `error` — stable ACP v1 has no turn-error update; the rejected
//     `session/prompt` response is the error channel. Logged for diagnostics.
//   * `diff` — ACP `Diff` wants old/new text; Quark emits a unified diff
//     string, which cannot be losslessly converted.
//
// `step-finish` becomes `usage_update` (used = the step's input tokens, size =
// the model's context window). It is only sent when both are known: `size: 0`
// would lie to the client. Cost is deliberately not sent — clients show the
// window, not the bill.
//
// Stop reasons stay sessions.ts's job (it maps the runner outcome to
// end_turn/cancelled); this bridge preserves the runner result unchanged. ACP
// `max_tokens`/`refusal` are not surfaced yet because sessions.ts does not
// consume the runner's `assistant-message-end` finish reason.

import { methods } from "@agentclientprotocol/sdk"
import type {
  AgentContext,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk"
import type { BusEvents, SessionStore } from "@quark/runner"
import type { SessionTurn } from "./sessions"
import { createToolCallIds, type ToolCallIds, type ToolCallIdScope } from "./tool-call-ids"

// Persisted row shapes, derived from the store contract rather than importing
// the runner's `session/message` subpath: the declaration build resolves
// @quark/runner from dist under classic node resolution, which cannot follow
// package `exports` subpaths.
type StoredMessage = ReturnType<SessionStore["replay"]>["messages"][number]
type StoredPart = ReturnType<SessionStore["replay"]>["parts"][number]

/** Structural views of the JSON `PartRow.data` blobs the replay reads. */
interface StoredTextPart {
  text?: string
  /** "model-only" parts are hidden context, not conversation: never replayed. */
  visibility?: string
}
interface StoredToolPart {
  tool: string
  callId: string
  status: "pending" | "running" | "completed" | "error"
  input: Record<string, unknown>
  output?: string
  error?: string
}

/** Bus events this bridge consumes. All carry a `sessionId`. */
type BridgedEvent =
  | "session-created"
  | "text-delta"
  | "reasoning-delta"
  | "tool-start"
  | "tool-input"
  | "tool-input-draft"
  | "tool-output-delta"
  | "tool-running"
  | "tool-end"
  | "step-finish"
  | "error"

/** Per-turn bridge state. */
interface TurnState {
  /** Drop every bus listener registered for the turn. */
  unsubscribe(): void
  /** Resolves when every queued notification has been written. */
  flush(): Promise<void>
}

export interface UpdateBridgeOptions {
  /** Diagnostics sink for delivery failures and runner errors. Defaults to no-op. */
  log?: (message: string) => void
}

/**
 * QUA-244 seam. `onTurnStart` is the `SessionBridgeOptions.onTurnStart`
 * callback; `onTurnEnd` is the explicit turn-cleanup hook for a parent to call
 * from the sessions bridge's `finally` (idempotent with the internal wrapper).
 */
export interface UpdateBridge {
  /**
   * `callIds` (QUA-265) remaps raw provider tool-call ids to unique ACP ids for
   * this turn. Omitted (direct callers/tests), the bridge mints its own scope.
   */
  onTurnStart(turn: SessionTurn, callIds?: ToolCallIdScope): void
  onTurnEnd(turn: SessionTurn): Promise<void>
}

// Tool id → ACP kind. ACP kind only drives client icon/treatment, so unknown
// tools fall back to "other" rather than guessing. Heuristic by design; extend
// per deployment as tools are added.
const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  look: "read",
  write: "edit",
  edit: "edit",
  grep: "search",
  glob: "search",
  websearch: "search",
  webfetch: "fetch",
  bash: "execute",
  todo: "think",
}

const TOOL_NAMES: Record<string, string> = {
  read: "Read",
  look: "Look",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  websearch: "WebSearch",
  webfetch: "WebFetch",
  todo: "Todo",
  skill: "Skill",
  question: "Question",
}

function humanizeTool(tool: string): string {
  return TOOL_NAMES[tool] ?? tool.charAt(0).toUpperCase() + tool.slice(1)
}

function toolKind(tool: string): ToolKind {
  return TOOL_KINDS[tool] ?? "other"
}

/**
 * Best-effort arg label, mirroring the TUI tool card. ACP has no separate args
 * field, so the label folds into the tool call title.
 */
function toolLabel(input: Record<string, unknown>): string | undefined {
  const path = input.filePath ?? input.file_path ?? input.path
  if (typeof path === "string" && path) return path
  const command = input.command ?? input.cmd
  if (typeof command === "string" && command) return command
  for (const key of ["pattern", "query", "url", "name", "skill"] as const) {
    const value = input[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

function toolTitle(tool: string, input?: Record<string, unknown>): string {
  const base = humanizeTool(tool)
  const label = input ? toolLabel(input) : undefined
  return label ? `${base} ${label}` : base
}

function toolTextContent(text: string): ToolCallContent {
  return { type: "content", content: { type: "text", text } }
}

/**
 * Subscribe to one turn's runner bus and build its serialized notification
 * queue. Cleanup (unsubscribe + flush) is driven by the parent's `onTurnEnd`.
 */
function startTurn(
  turn: SessionTurn,
  options: UpdateBridgeOptions,
  callIds: ToolCallIdScope,
): TurnState {
  // Event filter: learn the runner session id from `session-created` on the
  // first turn, then only forward matching events. Instance runners already use
  // an isolated bus, but this keeps a shared bus from leaking sibling sessions
  // into this ACP session.
  let expectedSessionId = turn.runnerSessionId
  let chain: Promise<void> = Promise.resolve()
  const client: AgentContext = turn.client
  // Accumulated streamed output per tool call. ACP replaces `rawOutput`, so
  // every delta is re-sent as the full text so far — clients render a live
  // tail instead of having to append.
  const streamedOutput = new Map<string, string>()

  function enqueue(update: SessionUpdate): void {
    chain = chain
      .then(() =>
        client.notify(methods.client.session.update, {
          sessionId: turn.acpSessionId,
          update,
        }),
      )
      .catch((error: unknown) => {
        options.log?.(
          `session/update delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  function accepts(sessionId: string): boolean {
    if (expectedSessionId === null) {
      expectedSessionId = sessionId
      return true
    }
    return sessionId === expectedSessionId
  }

  function on<K extends BridgedEvent>(
    event: K,
    handler: (data: BusEvents[K]) => void,
  ): () => void {
    const wrapped = (data: BusEvents[K]) => {
      if (accepts(data.sessionId)) handler(data)
    }
    turn.runner.bus.on(event, wrapped)
    return () => turn.runner.bus.off(event, wrapped)
  }

  const offs: Array<() => void> = [
    // Latches the runner session id via `accepts`; no notification of its own.
    on("session-created", () => {}),

    on("text-delta", (data) => {
      enqueue({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: data.delta },
        messageId: data.messageId,
      })
    }),

    on("reasoning-delta", (data) => {
      enqueue({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: data.delta },
        messageId: data.messageId,
      })
    }),

    on("tool-start", (data) => {
      const update: ToolCall & { sessionUpdate: "tool_call" } = {
        sessionUpdate: "tool_call",
        toolCallId: callIds.forRaw(data.callId),
        title: toolTitle(data.tool),
        name: data.tool,
        kind: toolKind(data.tool),
        status: "pending",
      }
      enqueue(update)
    }),

    on("tool-input", (data) => {
      enqueue({
        sessionUpdate: "tool_call_update",
        toolCallId: callIds.forRaw(data.callId),
        title: toolTitle(data.tool, data.input),
        rawInput: data.input,
      })
    }),

    on("tool-input-draft", (data) => {
      // ACP has no separate argument field, so the draft rides `rawInput` as a
      // STRING: valid JSON, and unambiguous — Quark always sends final args as
      // an object, so clients can render a string as "still writing" and let
      // the next update replace it.
      enqueue({
        sessionUpdate: "tool_call_update",
        toolCallId: callIds.forRaw(data.callId),
        rawInput: data.text,
      })
    }),

    on("tool-output-delta", (data) => {
      const accumulated = (streamedOutput.get(data.callId) ?? "") + data.delta
      streamedOutput.set(data.callId, accumulated)
      enqueue({
        sessionUpdate: "tool_call_update",
        toolCallId: callIds.forRaw(data.callId),
        rawOutput: accumulated,
      })
    }),

    on("tool-running", (data) => {
      enqueue({
        sessionUpdate: "tool_call_update",
        toolCallId: callIds.forRaw(data.callId),
        status: "in_progress",
      })
    }),

    on("tool-end", (data) => {
      const update: ToolCallUpdate & { sessionUpdate: "tool_call_update" } = {
        sessionUpdate: "tool_call_update",
        toolCallId: callIds.forRaw(data.callId),
        status: data.status === "completed" ? "completed" : "failed",
      }
      const text = data.status === "completed" ? data.output : data.error
      if (text) {
        update.content = [toolTextContent(text)]
        update.rawOutput = text
      }
      enqueue(update)
      streamedOutput.delete(data.callId)
    }),

    on("step-finish", (data) => {
      // Context-window usage = input tokens only. Cache read/write are
      // breakdowns *within* input; summing them would show >100%.
      const used = data.data.tokens?.input ?? 0
      const size = data.contextWindow ?? 0
      if (used > 0 && size > 0) {
        enqueue({ sessionUpdate: "usage_update", used, size })
      }
    }),

    on("error", (data) => {
      options.log?.(
        `runner error: ${data.error instanceof Error ? data.error.message : String(data.error)}`,
      )
    }),
  ]

  // NOTE: this bridge no longer wraps the runner's `prompt`. The parent
  // (sessions.ts) awaits `onTurnEnd` in `prompt()`'s `finally`, which flushes
  // the queue before the session/prompt response is written.

  return {
    unsubscribe: () => {
      for (const off of offs) off()
    },
    flush: () => chain,
  }
}

/**
 * Build a connection-scoped update bridge. One bridge serves every session on
 * the connection; per-turn state is keyed by ACP session id and torn down at
 * turn end, so no listener or queued update leaks across sessions.
 */
export function createUpdateBridge(options: UpdateBridgeOptions = {}): UpdateBridge {
  const turns = new Map<string, TurnState>()
  // Fallback for direct callers/tests that don't pass a connection-scoped
  // scope. Still a fresh raw-id map per turn.
  const fallbackCallIds = createToolCallIds()

  const bridge: UpdateBridge = {
    onTurnStart(turn, callIds) {
      // One active turn per session (enforced upstream); ignore a double call.
      if (turns.has(turn.acpSessionId)) return
      turns.set(turn.acpSessionId, startTurn(turn, options, callIds ?? fallbackCallIds.startTurn()))
    },

    async onTurnEnd(turn) {
      const state = turns.get(turn.acpSessionId)
      if (!state) return
      turns.delete(turn.acpSessionId)
      state.unsubscribe()
      await state.flush()
    },
  }

  return bridge
}

// ---------------------------------------------------------------------------
// session/load replay — persisted rows -> ordered session/update notifications
// ---------------------------------------------------------------------------

/**
 * Reconstruct the ACP-visible history for `session/load` from persisted rows.
 *
 * `session/load` is the one place a client expects the whole conversation
 * replayed as `session/update` notifications (text/reasoning chunks + tool
 * calls); live turns never do this. Order follows the store's chronological
 * rows, and each message's parts keep their insertion order.
 *
 * Deliberately skipped — the data stays on disk, only the replayed view omits
 * it (a `ponytail:` ceiling, not data loss):
 *   * `step-start` / `step-finish` — per-step metadata, not conversation.
 *   * `image` — clients only render images when the agent advertises
 *     `promptCapabilities.image`, which Quark does not.
 *   * `providerId === "compaction"` messages — synthesized context anchors
 *     (`toModelMessages` injects them), not something the user said.
 *
 * Tool-call ids (QUA-265): each stored tool row gets a FRESH ACP id — two rows
 * that both persisted `call_0` are two distinct cards. They are not mapped by
 * raw id here; the connection passes its registry so replay ids cannot collide
 * with a later live-turn id. The persisted `callId` is never rewritten.
 */
/** The persisted shape of a step-finish part, as much as replay needs. */
type StepFinishUsage = { tokens?: { input?: number }; contextWindow?: number }

/**
 * The trailing `usage_update` for a replayed session, read from its most
 * recent step-finish part — the same numbers the live bridge reported for that
 * step. `null` when the session never finished a step, or when the window size
 * wasn't recorded (sessions written before it was persisted): the meter stays
 * hidden rather than showing a fabricated window.
 */
export function lastUsageUpdate(parts: StoredPart[]): SessionUpdate | null {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (!part || part.type !== "step-finish") continue
    const data = parsePart<StepFinishUsage>(part)
    const used = data?.tokens?.input ?? 0
    const size = data?.contextWindow ?? 0
    // The most recent step is authoritative: an older step's numbers would be
    // stale, and a step without a window has none to offer.
    if (used > 0 && size > 0) {
      return { sessionUpdate: "usage_update", used, size }
    }
    return null
  }
  return null
}

export function historyToUpdates(
  input: { messages: StoredMessage[]; parts: StoredPart[] },
  callIds: ToolCallIds = createToolCallIds(),
): SessionUpdate[] {
  const partsByMessage = new Map<string, StoredPart[]>()
  for (const part of input.parts) {
    const list = partsByMessage.get(part.messageId)
    if (list) list.push(part)
    else partsByMessage.set(part.messageId, [part])
  }

  const updates: SessionUpdate[] = []
  for (const message of input.messages) {
    if (message.providerId === "compaction") continue
    const chunk = message.role === "user" ? "user_message_chunk" : "agent_message_chunk"
    for (const part of partsByMessage.get(message.id) ?? []) {
      const update = partToUpdate(part, chunk, message.id, callIds)
      if (update) updates.push(update)
    }
  }
  return updates
}

function parsePart<T>(part: StoredPart): T | null {
  try {
    return JSON.parse(part.data) as T
  } catch {
    return null
  }
}

function partToUpdate(
  part: StoredPart,
  chunk: "user_message_chunk" | "agent_message_chunk",
  messageId: string,
  callIds: ToolCallIds,
): SessionUpdate | null {
  switch (part.type) {
    case "text": {
      const data = parsePart<StoredTextPart>(part)
      if (!data?.text || data.visibility === "model-only") return null
      return { sessionUpdate: chunk, content: { type: "text", text: data.text }, messageId }
    }
    case "reasoning": {
      const data = parsePart<StoredTextPart>(part)
      if (!data?.text) return null
      return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: data.text }, messageId }
    }
    case "tool":
      return toolCallFromHistory(parsePart<StoredToolPart>(part), callIds)
    default:
      return null
  }
}

function toolCallFromHistory(data: StoredToolPart | null, callIds: ToolCallIds): SessionUpdate | null {
  if (!data?.callId || !data.tool) return null
  const update: ToolCall & { sessionUpdate: "tool_call" } = {
    sessionUpdate: "tool_call",
    // Fresh per stored row: replay is not a turn, so raw ids may repeat.
    toolCallId: callIds.fresh(),
    title: toolTitle(data.tool, data.input),
    name: data.tool,
    kind: toolKind(data.tool),
    status: toolStatus(data.status),
    rawInput: data.input,
  }
  const text = data.error ?? data.output
  if (text) {
    update.content = [toolTextContent(text)]
    update.rawOutput = text
  }
  return update
}

function toolStatus(status: StoredToolPart["status"]): "pending" | "in_progress" | "completed" | "failed" {
  switch (status) {
    case "running":
      return "in_progress"
    case "completed":
      return "completed"
    case "error":
      return "failed"
    default:
      return "pending"
  }
}
