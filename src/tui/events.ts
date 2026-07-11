// wireEvents — subscribes to the event bus and mutates the SolidJS store
//
// Replaces useEventBus (React hook) with a plain function that uses
// createComputed + onCleanup for lifecycle management.
//
// We use createComputed (not createEffect or createRenderEffect) because it
// re-runs synchronously inline when its dependency (sessionId) changes.
// This ensures new bus subscriptions are active immediately after a
// session-reset or session-switch, before any subsequent events fire.

import { createComputed, onCleanup } from "solid-js"
import { bus, type BusEventName, type BusEvents } from "../session/events"
import { dispatch, type AppState } from "./state"
import { error as notifyError, warn as notifyWarn } from "../notification/notification"

// Per-session last-known input token count — survives session switches so
// returning to a session restores the correct context-window %.
const sessionTokens = new Map<string, number>()

/**
 * Categorize a provider error into a human-readable title and message
 * for display in the notification system.
 * Returns null for abort errors (user-initiated cancellation — not an error).
 */
function categorizeError(err: unknown): { title: string; message: string } | null {
  // Abort errors are user-initiated — don't show notification
  if (err instanceof DOMException && err.name === "AbortError") return null
  if (err instanceof Error && err.name === "AbortError") return null
  
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  
  // Also catch abort-like messages
  if (lower.includes("aborted") || lower.includes("cancelled") || lower.includes("canceled")) {
    return null
  }
  
  const e = err as any
  const status: number | undefined =
    typeof e?.status === "number" ? e.status
    : typeof e?.statusCode === "number" ? e.statusCode
    : typeof e?.response?.status === "number" ? e.response.status
    : undefined

  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { title: "Rate Limited", message }
  }
  if (lower.includes("quota") || lower.includes("exceeded your") || lower.includes("billing")) {
    return { title: "Quota Exceeded", message }
  }
  if (
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("reduce the length")
  ) {
    return { title: "Context Too Large", message }
  }
  if (status === 401 || lower.includes("unauthorized") || lower.includes("api key") || lower.includes("authentication")) {
    return { title: "Authentication Failed", message }
  }
  if (status === 403 || lower.includes("forbidden") || lower.includes("access denied")) {
    return { title: "Access Denied", message }
  }
  if (status === 404 || lower.includes("model not found") || lower.includes("no such model")) {
    return { title: "Model Not Found", message }
  }
  return { title: "Provider Error", message }
}

export function wireEvents(state: AppState) {
  // Last input tokens for the current session — this is the real context
  // window usage reported by the API, NOT a cumulative sum.
  let lastInputTokens = 0

  // Track user message timestamp so we can compute "Worked for X.Xs" duration
  let userMsgTime = 0

  // session-created: registered outside createComputed so it fires even when
  // sessionId is null (before the first message creates a session).
  const handleCreated = (data: BusEvents["session-created"]) => {
    dispatch(state, { type: "set-session", sessionId: data.sessionId })
  }
  bus.on("session-created", handleCreated)

  // session-reset: registered outside createComputed so it fires even when
  // sessionId is null (e.g. /new or /clear before first message).
  const handleReset = (data: BusEvents["session-reset"]) => {
    const sid = state.store.sessionId
    if (sid && lastInputTokens > 0) {
      sessionTokens.set(sid, lastInputTokens)
    }
    lastInputTokens = 0
    dispatch(state, { type: "reset-session", sessionId: data.sessionId })
  }
  bus.on("session-reset", handleReset)

  // session-switch: registered outside createComputed so it fires even when
  // sessionId is null (e.g. /sessions picker before first message).
  const handleSwitch = (data: BusEvents["session-switch"]) => {
    const sid = state.store.sessionId
    if (sid && lastInputTokens > 0) {
      sessionTokens.set(sid, lastInputTokens)
    }
    const restored = sessionTokens.get(data.sessionId)
    const incoming = restored ?? data.estimatedTokens ?? 0
    // CRITICAL: seed the map BEFORE dispatching load-session.
    // load-session mutates sessionId, which causes createComputed to re-run
    // synchronously and reset lastInputTokens from sessionTokens.
    // Seeding first ensures createComputed picks up the correct value.
    if (incoming > 0) {
      sessionTokens.set(data.sessionId, incoming)
    }
    dispatch(state, { type: "load-session", sessionId: data.sessionId, messages: data.messages })
    // After createComputed re-ran, lastInputTokens is now correctly seeded
    dispatch(state, { type: "update-status", partial: { tokensUsed: lastInputTokens } })
  }
  bus.on("session-switch", handleSwitch)

  // error: registered FIRST and outside createComputed so it catches
  // errors emitted anywhere — during startup, model switching, or inside
  // the loop — regardless of session state.
  const handleError = (data: BusEvents["error"]) => {
    const result = categorizeError(data.error)
    if (result) {
      const msg = result.message.length > 120
        ? result.message.slice(0, 117) + "..."
        : result.message
      notifyError(result.title, msg, 8000)
    }
  }
  bus.on("error", handleError)

  // model-switched: registered outside createComputed because it has no
  // sessionId in its payload and the createComputed on() wrapper would
  // filter it out (undefined !== sid).
  const handleModelSwitched = (data: BusEvents["model-switched"]) => {
    dispatch(state, {
      type: "model-switched",
      modelSpec: data.modelSpec,
      thinkingEffort: data.thinkingEffort,
      thinkingMode: data.thinkingMode,
    })
  }
  bus.on("model-switched", handleModelSwitched)

  const handleWorktreeSwitched = (data: BusEvents["worktree-switched"]) => {
    dispatch(state, {
      type: "worktree-switched",
      cwd: data.cwd,
      activeWorktree: data.activeWorktree,
      activeBranch: data.activeBranch,
      modelSpec: data.modelSpec,
      skillCount: data.skillCount,
    })
  }
  bus.on("worktree-switched", handleWorktreeSwitched)

  // ---------------------------------------------------------------------------
  // Async panel side-session event routing (persistent, outside createComputed)
  // ---------------------------------------------------------------------------
  const handleAsyncUserMessage = (data: BusEvents["user-message"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-add-user-message", id: data.messageId, text: data.text })
    }
  }
  bus.on("user-message", handleAsyncUserMessage)

  const handleAsyncAssistantStart = (data: BusEvents["assistant-message-start"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-add-assistant-message", id: data.messageId })
    }
  }
  bus.on("assistant-message-start", handleAsyncAssistantStart)

  const handleAsyncTextStart = (data: BusEvents["text-start"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-text-start", messageId: data.messageId })
    }
  }
  bus.on("text-start", handleAsyncTextStart)

  const handleAsyncTextDelta = (data: BusEvents["text-delta"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-text-delta", messageId: data.messageId, delta: data.delta, text: data.text })
    }
  }
  bus.on("text-delta", handleAsyncTextDelta)

  const handleAsyncTextEnd = (data: BusEvents["text-end"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-text-end", messageId: data.messageId, text: data.text })
    }
  }
  bus.on("text-end", handleAsyncTextEnd)

  const handleAsyncToolStart = (data: BusEvents["tool-start"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-tool-start", messageId: data.messageId, tool: data.tool, callId: data.callId })
    }
  }
  bus.on("tool-start", handleAsyncToolStart)

  const handleAsyncAssistantEnd = (data: BusEvents["assistant-message-end"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-assistant-done", messageId: data.messageId })
    }
  }
  bus.on("assistant-message-end", handleAsyncAssistantEnd)

  const handleAsyncLoopStart = (data: BusEvents["loop-start"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-set-running", running: true })
    }
  }
  bus.on("loop-start", handleAsyncLoopStart)

  const handleAsyncLoopEnd = (data: BusEvents["loop-end"]) => {
    if (data.sessionId === state.store.asyncPanel?.sessionId) {
      dispatch(state, { type: "async-set-running", running: false })
    }
  }
  bus.on("loop-end", handleAsyncLoopEnd)

  // async-panel-open: backend created an ephemeral side session, TUI should show panel
  const handleAsyncPanelOpen = (data: BusEvents["async-panel-open"]) => {
    dispatch(state, { type: "open-async-panel", sessionId: data.sessionId ?? null, title: data.title })
  }
  bus.on("async-panel-open", handleAsyncPanelOpen)

  createComputed(() => {
    const sid = state.store.sessionId
    if (!sid) return

    // Restore from the per-session cache, or start at 0
    lastInputTokens = sessionTokens.get(sid) ?? 0

    function on<K extends BusEventName>(event: K, handler: (data: BusEvents[K]) => void) {
      const wrapped = (data: BusEvents[K]) => {
        if ((data as any).sessionId === sid) handler(data)
      }
      bus.on(event, wrapped)
      return () => bus.off(event, wrapped)
    }

    const unsubs: (() => void)[] = []

    unsubs.push(on("user-message", (data) => {
      userMsgTime = Date.now()
      dispatch(state, { type: "add-user-message", id: data.messageId, text: data.text })
      // Clear previous duration — new turn starts fresh
      dispatch(state, { type: "set-last-duration", duration: 0 })
    }))

    unsubs.push(on("assistant-message-start", (data) => {
      dispatch(state, { type: "add-assistant-message", id: data.messageId })
    }))

    unsubs.push(on("text-start", (data) => {
      dispatch(state, { type: "text-start", messageId: data.messageId })
    }))

    unsubs.push(on("text-delta", (data) => {
      dispatch(state, { type: "text-delta", messageId: data.messageId, delta: data.delta, text: data.text })
    }))

    unsubs.push(on("text-end", (data) => {
      dispatch(state, { type: "text-end", messageId: data.messageId, text: data.text })
    }))

    unsubs.push(on("tool-start", (data) => {
      dispatch(state, { type: "tool-start", messageId: data.messageId, tool: data.tool, callId: data.callId })
    }))

    // Track active write-stream timers and deferred tool-end payloads.
    // The write tool completes almost instantly (fs.writeFileSync), so tool-end
    // arrives before the first setInterval tick fires.  We defer the tool-end
    // dispatch until the streaming animation finishes so the user actually sees
    // the progressive green-line effect.
    const writeStreamTimers = new Map<string, ReturnType<typeof setInterval>>()
    const deferredToolEnd = new Map<string, BusEvents["tool-end"]>()

    unsubs.push(on("tool-input", (data) => {
      dispatch(state, { type: "tool-input", messageId: data.messageId, callId: data.callId, input: data.input, diff: data.diff })

      // Start progressive streaming for write tool content
      if (data.tool === "write") {
        const content = data.input.content
        if (typeof content === "string" && content.length > 0) {
          const lines = content.split("\n")
          // Stream ~3 lines per tick at 30ms intervals → visible at 60 FPS
          const linesPerTick = Math.max(1, Math.ceil(lines.length / 40))
          let lineIdx = 0
          const timer = setInterval(() => {
            lineIdx = Math.min(lineIdx + linesPerTick, lines.length)
            const partial = lines.slice(0, lineIdx).join("\n")
            dispatch(state, { type: "tool-stream-delta", messageId: data.messageId, callId: data.callId, content: partial })
            if (lineIdx >= lines.length) {
              clearInterval(timer)
              writeStreamTimers.delete(data.callId)
              // Now flush the deferred tool-end if the tool already finished
              const deferred = deferredToolEnd.get(data.callId)
              if (deferred) {
                deferredToolEnd.delete(data.callId)
                dispatch(state, { type: "tool-end", messageId: deferred.messageId, callId: deferred.callId, status: deferred.status, output: deferred.output, error: deferred.error, diff: deferred.diff })
              }
            }
          }, 30)
          writeStreamTimers.set(data.callId, timer)
        }
      }
    }))

    unsubs.push(on("tool-end", (data) => {
      // If a write-stream timer is still running, defer the tool-end dispatch
      // until the animation completes — otherwise the timer gets cancelled and
      // the user sees zero progressive frames.
      if (writeStreamTimers.has(data.callId)) {
        deferredToolEnd.set(data.callId, data)
        return
      }
      dispatch(state, { type: "tool-end", messageId: data.messageId, callId: data.callId, status: data.status, output: data.output, error: data.error, diff: data.diff })
    }))

    unsubs.push(on("assistant-message-end", (data) => {
      dispatch(state, { type: "assistant-done", messageId: data.messageId })
      // Unlock input as soon as the final message ends (don't wait for loop-end
      // which may be delayed by compaction / DB writes)
      if (data.finish === "stop" || data.finish === "length") {
        dispatch(state, { type: "set-running", running: false })
        // Record duration from user message to assistant completion
        if (userMsgTime > 0) {
          dispatch(state, { type: "set-last-duration", duration: Date.now() - userMsgTime })
        }
        userMsgTime = 0
      }
    }))

    unsubs.push(on("loop-start", () => {
      dispatch(state, { type: "set-running", running: true })
    }))

    unsubs.push(on("loop-end", () => {
      dispatch(state, { type: "set-running", running: false })
    }))

    unsubs.push(on("steer-start", () => {
      dispatch(state, { type: "set-steering", steering: true })
    }))

    unsubs.push(on("steer-end", () => {
      dispatch(state, { type: "set-steering", steering: false })
    }))

    unsubs.push(on("retry", (data) => {
      const delaySec = Math.round(data.delayMs / 1000)
      const delayStr = delaySec >= 60
        ? `${Math.round(delaySec / 60)}m ${delaySec % 60}s`
        : `${delaySec}s`
      const result = categorizeError(data.error)
      const title = result?.title ?? "Provider Error"
      notifyWarn(`${title} — Retry ${data.attempt}`, `Retrying in ${delayStr}…`, data.delayMs + 1000)
    }))

    unsubs.push(on("permission-request", (data) => {
      dispatch(state, {
        type: "set-permission",
        request: { requestId: data.requestId, tool: data.tool, input: data.input },
      })
    }))

    unsubs.push(on("tool-running", (data) => {
      // No tool filter needed — tool-start already filtered, so this is a no-op
      // for read-only tools (the part was never created).
      dispatch(state, { type: "tool-running", messageId: data.messageId, callId: data.callId })
    }))

    unsubs.push(on("question-request", (data) => {
      dispatch(state, {
        type: "set-question",
        request: {
          requestId: data.requestId,
          sessionId: data.sessionId,
          questions: data.questions,
        },
      })
    }))

    unsubs.push(on("context-too-long", () => {
      notifyWarn("Context Too Long", "Provider rejected request — branching to a new session…", 5000)
    }))

    unsubs.push(on("step-finish", (data) => {
      const tokens = data.data.tokens
      if (tokens) {
        // Context window usage = inputTokens only.
        // cacheRead and cacheWrite are breakdowns *within* inputTokens, not
        // additive — summing them causes 2-3x inflation (seen as >100%).
        // outputTokens are generated tokens, not context window consumption.
        const total = tokens.input ?? 0
        if (total > 0) {
          lastInputTokens = total
          sessionTokens.set(sid, lastInputTokens)
          dispatch(state, { type: "update-status", partial: { tokensUsed: lastInputTokens } })
        }
      }
    }))

    // ----- Sub-agent observability events -----

    unsubs.push(on("subagent-tool-start", (data) => {
      dispatch(state, {
        type: "subagent-tool-start",
        messageId: data.messageId,
        parentCallId: data.parentCallId,
        profile: data.profile,
        tool: data.tool,
        callId: data.callId,
      })
    }))

    unsubs.push(on("subagent-tool-input", (data) => {
      dispatch(state, {
        type: "subagent-tool-input",
        messageId: data.messageId,
        parentCallId: data.parentCallId,
        profile: data.profile,
        tool: data.tool,
        callId: data.callId,
        input: data.input,
      })
    }))

    unsubs.push(on("subagent-tool-end", (data) => {
      dispatch(state, {
        type: "subagent-tool-end",
        messageId: data.messageId,
        parentCallId: data.parentCallId,
        profile: data.profile,
        tool: data.tool,
        callId: data.callId,
        status: data.status,
        error: data.error,
      })
    }))

    unsubs.push(on("subagent-step-finish", (data) => {
      dispatch(state, {
        type: "subagent-step-finish",
        messageId: data.messageId,
        parentCallId: data.parentCallId,
        profile: data.profile,
        tokens: data.tokens,
        tokenLimit: data.tokenLimit,
        modelName: data.modelName,
      })
    }))

    unsubs.push(on("subagent-text-delta", (data) => {
      dispatch(state, {
        type: "subagent-text-delta",
        messageId: data.messageId,
        parentCallId: data.parentCallId,
        profile: data.profile,
        text: data.text,
      })
    }))

    unsubs.push(on("subagent-done", (data) => {
      dispatch(state, {
        type: "subagent-done",
        messageId: data.messageId,
        parentCallId: data.parentCallId,
        profile: data.profile,
      })
    }))

    // ----- Reasoning / thinking events -----

    unsubs.push(on("reasoning-start", (data) => {
      dispatch(state, { type: "reasoning-start", messageId: data.messageId })
    }))

    unsubs.push(on("reasoning-delta", (data) => {
      dispatch(state, { type: "reasoning-delta", messageId: data.messageId, partId: data.partId, delta: data.delta, text: data.text })
    }))

    unsubs.push(on("reasoning-end", (data) => {
      dispatch(state, { type: "reasoning-end", messageId: data.messageId })
    }))

    // ----- Undo -----

    unsubs.push(on("undo-applied", (data) => {
      dispatch(state, { type: "truncate-messages", upToMessageId: data.keepMessagesUpTo })
    }))

    onCleanup(() => {
      for (const unsub of unsubs) unsub()
      for (const timer of writeStreamTimers.values()) clearInterval(timer)
      writeStreamTimers.clear()
      deferredToolEnd.clear()
    })
  })
}
