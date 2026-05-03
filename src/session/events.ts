// Event bus — typed events emitted by the processor for real-time TUI updates
//
// Uses Node-compatible EventEmitter (works in Bun).
// The TUI subscribes to these events to render streaming content,
// tool call progress, token usage, etc.

import { EventEmitter } from "events"
import type { TextPartData, ToolPartData, StepFinishData, MessageRow } from "./message"
import type { TuiMessage } from "../tui/state"

// ---- Event types ----

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
  "tool-input-delta": { sessionId: string; messageId: string; partId: string; callId: string; delta: string }
  "tool-input": { sessionId: string; messageId: string; partId: string; tool: string; callId: string; input: Record<string, unknown> }
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
  "assistant-message-end": { sessionId: string; messageId: string; finish: "stop" | "tool-calls" | "length" }

  // Agent loop lifecycle
  "loop-start": { sessionId: string }
  "loop-end": { sessionId: string }

  // Permission request (TUI needs to prompt user)
  "permission-request": { sessionId: string; requestId: string; tool: string; input: Record<string, unknown> }

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

  // Compaction lifecycle
  "compaction-start": { sessionId: string }
  "compaction-end": { sessionId: string; result: import("./compact-resolver").CompactResult | null }

  // Retry — emitted when a retryable error triggers a retry with backoff
  "retry": { sessionId: string; attempt: number; delayMs: number; error: unknown }

  // Error
  "error": { sessionId: string; error: unknown }

  // Context-too-long — provider rejected the request because prompt exceeds context window
  "context-too-long": { sessionId: string; error: unknown }

  // Session was lazily created (first message in a new conversation)
  "session-created": { sessionId: string }

  // Model was switched (e.g. Tab/Shift+Tab cycling, /model command) — TUI should update token limit
  "model-switched": { modelSpec: string } // e.g. "copilot/claude-sonnet-4.6" or "openai/gpt-4o"

  // Session was reset (e.g. /clear command — TUI should switch to new session)
  "session-reset": { sessionId: string | null }

  // Session was switched (e.g. /sessions <id> — TUI loads existing session)
  // estimatedTokens: if provided (e.g. post-compaction), the status bar is
  // updated immediately instead of showing 0 until the next step-finish.
  "session-switch": { sessionId: string; messages: TuiMessage[]; estimatedTokens?: number }

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
}

/** Union of all bus event names */
export type BusEventName = keyof BusEvents

// ---- Singleton bus ----

class TypedBus {
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
