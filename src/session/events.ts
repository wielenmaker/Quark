// Event bus — typed events emitted by the processor for real-time TUI updates
//
// Uses Node-compatible EventEmitter (works in Bun).
// The TUI subscribes to these events to render streaming content,
// tool call progress, token usage, etc.

import { EventEmitter } from "events"
import type { StepFinishData } from "./message"
import type { ConversationMessage } from "../shared/conversation-view"
import type { SubagentErrorKind } from "../subagent/protocol"

// ---- Event types ----

export type ShipPhaseId = "preflight" | "plan" | "implement" | "verify" | "publish"
export type ShipPhaseStatus = "pending" | "running" | "pass" | "fail"

export interface ShipPhaseSnapshot {
  id: ShipPhaseId
  status: ShipPhaseStatus
  startedAt?: number
  durationMs?: number
  agent?: string
  sessionId?: string
}

export interface ShipUpdate {
  sessionId: string
  runId: string
  request: string
  status: "running" | "passed" | "failed"
  attempt: number
  maxAttempts: number
  branch?: string
  worktreePath?: string
  reason?: string
  prUrl?: string
  phases: ShipPhaseSnapshot[]
}

/**
 * All events emitted on the {@link bus}.
 *
 * Subscribe with `bus.on(eventName, handler)`.
 * Each key is an event name; the value is the event payload type.
 */
export interface BusEvents {
  // A user message was saved
  "user-message": { sessionId: string; messageId: string; text: string }

  // An assistant message was created (start of response)
  "assistant-message-start": { sessionId: string; messageId: string }

  // Streaming text deltas
  "text-start": { sessionId: string; messageId: string; partId: string }
  "text-delta": { sessionId: string; messageId: string; partId: string; delta: string; text: string }
  "text-end": { sessionId: string; messageId: string; partId: string; text: string }

  // Tool lifecycle
  "tool-start": { sessionId: string; messageId: string; partId: string; tool: string; callId: string }
  "tool-input": { sessionId: string; messageId: string; partId: string; tool: string; callId: string; input: Record<string, unknown>; diff?: string }
  "tool-running": { sessionId: string; messageId: string; callId: string }
  "tool-end": { sessionId: string; messageId: string; partId: string; tool: string; callId: string; status: "completed" | "error"; output?: string; error?: string; diff?: string }

  // Streaming reasoning/thinking deltas (extended thinking)
  "reasoning-start": { sessionId: string; messageId: string; partId: string }
  "reasoning-delta": { sessionId: string; messageId: string; partId: string; delta: string; text: string }
  "reasoning-end": { sessionId: string; messageId: string; partId: string }

  // Step boundaries
  "step-start": { sessionId: string; messageId: string }
  "step-finish": { sessionId: string; messageId: string; data: StepFinishData }

  // Assistant message completed
  "assistant-message-end": { sessionId: string; messageId: string; userMessageId: string; finish: "stop" | "tool-calls" | "length" | "aborted" }

  // A user message lifecycle changed before an assistant message was created.
  "user-message-status": { sessionId: string; messageId: string; status: "aborted" }

  // Agent loop lifecycle
  "loop-start": { sessionId: string }
  "loop-end": { sessionId: string }

  // Permission request (TUI needs to prompt user)
  "permission-request": {
    sessionId: string
    requestId: string
    tool: string
    input: Record<string, unknown>
    origin?: {
      kind: "subagent"
      parentCallId: string
      profile: string
      childSessionId: string
    }
  }

  // Remove child-process permission prompts that can no longer be answered.
  "permission-dismiss": { sessionId: string; requestIds: string[] }

  // Permission was rejected by the user — abort the agent loop
  "permission-rejected": { sessionId: string }

  // Question request — agent asks user interactive questions, TUI displays picker
  "question-request": {
    sessionId: string
    requestId: string
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiple?: boolean
      custom?: boolean
    }>
  }

  // Retry — emitted when a retryable error triggers a retry with backoff
  "retry": { sessionId: string; attempt: number; delayMs: number; error: unknown }

  // Error
  "error": { sessionId: string; error: unknown; userMessageId?: string }

  // Context-too-long — provider rejected the request because prompt exceeds context window
  "context-too-long": { sessionId: string; error: unknown }

  // Session was lazily created (first message in a new conversation)
  "session-created": { sessionId: string }

  // Session title or metadata was updated (e.g. auto-generated after first exchange)
  "session-title-changed": { sessionId: string; title: string | null; updatedAt?: number }

  // Model was switched (e.g. Tab/Shift+Tab cycling, /model command) — TUI should update token limit
  "model-switched": {
    modelSpec: string // e.g. "copilot/claude-sonnet-4.6" or "openai/gpt-4o"
    thinkingEffort?: string
    thinkingMode?: string
  }

  // Session was reset (e.g. /clear command — TUI should switch to new session)
  "session-reset": { sessionId: string | null }

  // Session was switched — discriminated by kind:
  //   "replace" — /sessions <id> replaces the entire transcript
  //   "branch"  — compaction/steer appends a divider + child messages
  // estimatedTokens: if provided (e.g. after branching), the status bar is
  // updated immediately instead of showing 0 until the next step-finish.
  "session-switch":
    | { kind: "replace"; sessionId: string; messages: ConversationMessage[]; estimatedTokens?: number }
    | { kind: "branch"; sessionId: string; messages: ConversationMessage[]; estimatedTokens?: number; divider: { id: string; goal: string } }

  // Undo — emitted when /undo is applied, TUI should truncate messages
  "undo-applied": { sessionId: string; keepMessagesUpTo: string; restored: number; deleted: number }

  // Steer (branching) lifecycle — TUI shows a "Steering…" indicator while the
  // parent session is being summarized for the new branch.
  "steer-start": { sessionId: string }
  "steer-end": { sessionId: string }

  // Async panel opened — TUI should show the side panel
  "async-panel-open": { sessionId?: string; title: string }

  // /ship pipeline snapshot — replaces the previous snapshot for this run
  "ship-update": ShipUpdate

  // ---------------------------------------------------------------------------
  // Sub-agent observability — events forwarded from child `quark --sub-agent`
  // processes via stderr NDJSON. The parent Bash tool parses these and re-emits
  // them on the parent bus so the TUI can render nested tool activity.
  // ---------------------------------------------------------------------------

  // A tool started in the sub-agent
  "subagent-tool-start": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string; tool: string; callId: string
  }

  // Tool input resolved in the sub-agent
  "subagent-tool-input": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string; tool: string; callId: string; input: Record<string, unknown>
  }

  // A child tool passed its permission gate and began executing
  "subagent-tool-running": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string; callId: string
  }

  // Tool completed/errored in the sub-agent
  "subagent-tool-end": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string; tool: string; callId: string
    status: "completed" | "error"; error?: string
  }

  // Sub-agent step finished — carries token usage
  "subagent-step-finish": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string; tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    tokenLimit?: number
    modelName?: string
  }

  // Streaming text from the sub-agent
  "subagent-text-delta": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string; text: string
  }

  // Sub-agent loop finished
  "subagent-done": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string
  }

  // Structured child provider/process/protocol failure
  "subagent-error": {
    sessionId: string; messageId: string; parentCallId: string
    profile: string; kind: SubagentErrorKind; message: string
  }

  // Worktree switch — TUI resets session state and updates cwd/branch
  "worktree-switched": {
    cwd: string
    activeWorktree: { id: string; path: string; branch: string | null; shortHash: string; isRoot: boolean } | null
    activeBranch: string | null
    modelSpec: string
    skillCount: number
  }
}

/** Union of all bus event names */
export type BusEventName = keyof BusEvents

// ---- Singleton bus ----

export class TypedBus {
  private emitter = new EventEmitter()

  constructor() {
    // Allow many listeners (one per active TUI component)
    this.emitter.setMaxListeners(100)
  }

  on<K extends BusEventName>(event: K, handler: (data: BusEvents[K]) => void): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void)
  }

  off<K extends BusEventName>(event: K, handler: (data: BusEvents[K]) => void): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void)
  }

  once<K extends BusEventName>(event: K, handler: (data: BusEvents[K]) => void): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void)
  }

  emit<K extends BusEventName>(event: K, data: BusEvents[K]): void {
    this.emitter.emit(event, data)
  }

  removeAllListeners(event?: BusEventName): void {
    if (event) {
      this.emitter.removeAllListeners(event)
    } else {
      this.emitter.removeAllListeners()
    }
  }
}

/**
 * Typed event bus singleton.
 *
 * Used by the agent core, TUI, CLI, and plugins to communicate asynchronously.
 * Backed by a Node.js `EventEmitter` with a 100-listener cap.
 *
 * @example
 * ```ts
 * import { bus } from '@quark/sdk'
 *
 * bus.on('text-delta', ({ delta }) => process.stdout.write(delta))
 * bus.on('tool-start', ({ tool }) => console.log(`→ ${tool}`))
 * bus.on('loop-end', ({ sessionId }) => console.log('Done', sessionId))
 * ```
 */
// Singleton instance
export const bus = new TypedBus()
