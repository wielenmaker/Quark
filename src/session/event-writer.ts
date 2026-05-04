// Event writer — streams structured events to stderr for parent process consumption
//
// When a sub-agent runs, the parent has no visibility into its internal tool
// execution. This module subscribes to the in-process event bus and writes
// NDJSON lines to stderr with a `QUARK_EVENT:` prefix so the parent's Bash
// tool can parse them out and render sub-agent activity in the TUI.
//
// Activated when QUARK_EMIT_EVENTS=1 (set automatically for --sub-agent).

import { bus } from "./events"
import { getModelLimit } from "../provider/models"
import { loadConfig } from "../config/config"
import { appendFileSync } from "fs"

function debugLog(msg: string) {
  try { appendFileSync("/tmp/quark-event-writer.log", `${new Date().toISOString()} ${msg}\n`) } catch {}
}

// Compact event shapes — keep wire size small
export type SubAgentEvent =
  | { e: "tool-start"; t: string; id: string }
  | { e: "tool-input"; t: string; id: string; in: Record<string, unknown> }
  | { e: "tool-end"; t: string; id: string; s: "completed" | "error"; err?: string }
  | { e: "step-finish"; tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; tokenLimit?: number }
  | { e: "text-delta"; d: string }
  | { e: "loop-end" }

const PREFIX = "QUARK_EVENT:"

function emit(event: SubAgentEvent): void {
  try {
    process.stderr.write(`${PREFIX}${JSON.stringify(event)}\n`)
  } catch {
    // stderr closed — parent may have exited; silently ignore
  }
}

/**
 * Start writing events to stderr.
 * Call once at startup when running as a sub-agent.
 * Returns a cleanup function to unsubscribe.
 */
export function startEventWriter(): () => void {
  debugLog(`[event-writer] starting — subscribing to bus events`)
  const unsubs: (() => void)[] = []

  function on<K extends keyof import("./events").BusEvents>(
    event: K,
    handler: (data: import("./events").BusEvents[K]) => void,
  ) {
    bus.on(event, handler)
    unsubs.push(() => bus.off(event, handler))
  }

  on("tool-start", (data) => {
    debugLog(`[event-writer] tool-start: ${data.tool} id=${data.callId}`)
    emit({ e: "tool-start", t: data.tool, id: data.callId })
  })

  on("tool-input", (data) => {
    debugLog(`[event-writer] tool-input: ${data.tool} id=${data.callId}`)
    emit({ e: "tool-input", t: data.tool, id: data.callId, in: data.input })
  })

  on("tool-end", (data) => {
    debugLog(`[event-writer] tool-end: ${data.tool} id=${data.callId} status=${data.status} hasOutput=${!!data.output}`)
    emit({
      e: "tool-end",
      t: data.tool,
      id: data.callId,
      s: data.status,
      ...(data.error ? { err: data.error } : {}),
    })
  })

  on("step-finish", (data) => {
    debugLog(`[event-writer] step-finish reason=${data.data.reason}`)
    // Include the model's token limit so the parent can show context window %
    const modelSpec = loadConfig().main_model
    const limit = getModelLimit(modelSpec)
    const tokenLimit = limit?.context ?? limit?.input ?? 0
    emit({ e: "step-finish", tokens: data.data.tokens, tokenLimit })
  })

  // Batch text deltas — emit at most every 200ms to avoid flooding
  let pendingText = ""
  let textTimer: ReturnType<typeof setTimeout> | null = null

  function flushText() {
    if (pendingText) {
      emit({ e: "text-delta", d: pendingText })
      pendingText = ""
    }
    textTimer = null
  }

  on("text-delta", (data) => {
    debugLog(`[event-writer] text-delta len=${data.text.length}`)
    pendingText = data.text // send full accumulated text, not just delta
    if (!textTimer) {
      textTimer = setTimeout(flushText, 200)
    }
  })

  on("text-end", () => {
    debugLog(`[event-writer] text-end (flushing)`)
    // Flush any pending text immediately on end
    if (textTimer) {
      clearTimeout(textTimer)
      textTimer = null
    }
    flushText()
  })

  on("loop-end", () => {
    debugLog(`[event-writer] loop-end`)
    // Final flush
    flushText()
    emit({ e: "loop-end" })
  })

  return () => {
    if (textTimer) {
      clearTimeout(textTimer)
      textTimer = null
    }
    flushText()
    for (const unsub of unsubs) unsub()
  }
}
