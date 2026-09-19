// SolidJS state layer — replaces React useReducer with createStore
//
// Contains all TUI state types (formerly in tui/state/state.ts) and
// the SolidJS store + dispatch implementation.

import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import type { MessageRow, PartRow, TextPartData, ToolPartData, ImagePartData, ReasoningPartData } from "@quark/runner/session/message"
import { normalizeLegacyToolStatus, LEGACY_INTERRUPTED_ERROR } from "@quark/runner/shared/conversation-view"
import { resolveAgent } from "../agent/agent"
import type { CatalogModel } from "@quark/runner/provider/catalog-snapshot"
import { thinkingCapabilityFromCatalog } from "@quark/runner/provider/catalog-runtime"
import type { SubagentErrorKind } from "@quark/runner/subagent/protocol"

// ---------------------------------------------------------------------------
// Worktree types
// ---------------------------------------------------------------------------

/** Lightweight worktree reference stored in TUI state */
export interface TuiWorktree {
  id: string
  path: string
  branch: string | null
  shortHash: string
  isRoot: boolean
}

// ---------------------------------------------------------------------------
// TUI data model types
// ---------------------------------------------------------------------------

export type UserMessageStatus = "sent" | "replied" | "aborted" | "failed"

export interface TuiMessage {
  id: string
  role: "user" | "assistant"
  parts: TuiPart[]
  /** Lifecycle state for user messages. */
  userStatus?: UserMessageStatus
  streaming?: boolean // true while assistant is streaming
}

export type TuiPart =
  | { type: "text"; text: string; streaming?: boolean }
  | { type: "tool"; tool: string; callId: string; status: "pending" | "running" | "completed" | "error"; input: Record<string, unknown>; output?: string; error?: string; diff?: string; streamingContent?: string; subAgent?: SubAgentState }
  | { type: "thinking"; done: boolean; text: string; startedAt?: number; durationMs?: number }
  | { type: "image"; mime: string; data: string; label: string }

/** Standalone divider row inserted into the message list after a branch. */
export interface TuiSteerDivider {
  id: string
  goal: string
  label?: string
  insertionIndex: number
}

// Sub-agent observability state — attached to tool parts that spawn sub-agents
export interface SubAgentToolPart {
  tool: string
  callId: string
  status: "pending" | "running" | "completed" | "error"
  input: Record<string, unknown>
  error?: string
}

export interface SubAgentState {
  profile: string
  modelName?: string
  prompt?: string
  childSessionId?: string
  tools: SubAgentToolPart[]
  // Token tracking for the sub-agent's context window
  tokensUsed: number
  tokenLimit: number
  // Streaming text preview from the sub-agent
  textPreview?: string
  error?: { kind: SubagentErrorKind; message: string }
  done: boolean
  // Running time tracking
  startedAt?: number
  durationMs?: number
}

export interface TuiStatus {
  tokensUsed: number
  tokenLimit: number
  cost: number
  modelName: string
  skillCount: number
}

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  requestId: string
  sessionId: string
  questions: QuestionInfo[]
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type TuiAction =
  | { type: "set-session"; sessionId: string }
  | { type: "reset-session"; sessionId: string | null }
  | { type: "load-session"; sessionId: string; messages: TuiMessage[] }
  | { type: "append-branch-session"; sessionId: string; messages: TuiMessage[]; divider: { id: string; goal: string; label?: string } }
  | { type: "add-user-message"; id: string; text: string; images?: { mime: string; data: string; label: string }[] }
  | { type: "set-user-message-status"; messageId: string; status: Exclude<UserMessageStatus, "sent"> }
  | { type: "add-assistant-message"; id: string }
  | { type: "text-start"; messageId: string }
  | { type: "text-delta"; messageId: string; delta: string; text: string }
  | { type: "text-end"; messageId: string; text: string }
  | { type: "tool-start"; messageId: string; tool: string; callId: string }
  | { type: "tool-input"; messageId: string; callId: string; input: Record<string, unknown>; diff?: string }
  | { type: "tool-end"; messageId: string; callId: string; status: "completed" | "error"; output?: string; error?: string; diff?: string }
  | { type: "tool-running"; messageId: string; callId: string }
  | { type: "tool-stream-delta"; messageId: string; callId: string; content: string }
  | { type: "assistant-done"; messageId: string }
  | { type: "set-running"; running: boolean }
  | { type: "set-steering"; steering: boolean }
  | { type: "set-last-duration"; duration: number }
  | { type: "update-status"; partial: Partial<TuiStatus> }
  | { type: "set-error"; message: string }
  | { type: "clear-error" }
  // Sub-agent observability actions
  | { type: "subagent-tool-start"; messageId: string; parentCallId: string; profile: string; tool: string; callId: string }
  | { type: "subagent-tool-input"; messageId: string; parentCallId: string; profile: string; tool: string; callId: string; input: Record<string, unknown> }
  | { type: "subagent-tool-running"; messageId: string; parentCallId: string; profile: string; callId: string }
  | { type: "subagent-tool-end"; messageId: string; parentCallId: string; profile: string; tool: string; callId: string; status: "completed" | "error"; error?: string }
  | { type: "subagent-step-finish"; messageId: string; parentCallId: string; profile: string; tokens?: { input?: number; output?: number }; tokenLimit?: number; modelName?: string }
  | { type: "subagent-text-delta"; messageId: string; parentCallId: string; profile: string; text: string }
  | { type: "subagent-done"; messageId: string; parentCallId: string; profile: string }
  | { type: "subagent-error"; messageId: string; parentCallId: string; profile: string; kind: SubagentErrorKind; message: string }
  | { type: "cycle-thinking"; model: CatalogModel | null }
  | { type: "reasoning-start"; messageId: string }
  | { type: "set-question"; request: QuestionRequest }
  | { type: "clear-question" }
  | { type: "reasoning-delta"; messageId: string; partId: string; delta: string; text: string }
  | { type: "reasoning-end"; messageId: string }
  | { type: "model-switched"; modelSpec: string; catalogModel?: CatalogModel; thinkingEffort?: string; thinkingMode?: string }
  | { type: "truncate-messages"; upToMessageId: string; tokensUsed: number }
  | { type: "remove-message"; messageId: string }
  // Worktree actions
  | { type: "worktree-switch-start" }
  | { type: "worktree-switched"; cwd: string; activeWorktree: TuiWorktree | null; activeBranch: string | null; modelSpec: string; skillCount: number }
  | { type: "worktree-switch-failed"; message: string }

// ---------------------------------------------------------------------------
// Extract profile and prompt from a quark --sub-agent bash command
// ---------------------------------------------------------------------------

function parseSubAgentCommand(cmd: string): { profile: string; prompt?: string } {
  const profile = cmd.match(/--profile\s+(\S+)/)?.[1] ?? "sub-agent"
  let prompt: string | undefined

  // Quoted --prompt
  const pm = cmd.match(/--prompt\s+(['"])(.*?)\1/)
  if (pm) {
    prompt = pm[2]
  } else {
    // Unquoted --prompt (word until next flag or end)
    const m2 = cmd.match(/--prompt\s+([^\s-][^;|&><]*?)(?:\s+-|$)/)
    prompt = m2?.[1]?.trim()
  }
  // Also try -m short form
  if (!prompt) {
    const m3 = cmd.match(/-m\s+(['"])(.*?)\1/)
    prompt = m3?.[2] ?? cmd.match(/-m\s+([^\s-][^;|&><]*?)(?:\s+-|$)/)?.[1]?.trim()
  }

  return { profile, prompt: prompt?.slice(0, 200) }
}

// Resolve the model name and token limit for a sub-agent profile so the
// card can show them immediately, before the first step-finish arrives.
function resolveSubAgentModelMeta(
  agentId: string,
  getCatalogModel?: (spec: string) => CatalogModel | null,
): { modelName: string; tokenLimit: number } {
  try {
    const agent = resolveAgent(agentId)
    const model = agent.model
    const catalogModel = model ? getCatalogModel?.(model) : null
    const limit = catalogModel?.limit
    return { modelName: model ?? "unknown", tokenLimit: limit?.context ?? limit?.input ?? 0 }
  } catch {
    return { modelName: "unknown", tokenLimit: 0 }
  }
}

// ---------------------------------------------------------------------------
// Convert persisted DB rows to TuiMessage[] for display
// ---------------------------------------------------------------------------

export function dbToTuiMessages(messages: MessageRow[], parts: PartRow[]): TuiMessage[] {
  // Group parts by message ID
  const partsByMsg = new Map<string, PartRow[]>()
  for (const p of parts) {
    const list = partsByMsg.get(p.messageId) ?? []
    list.push(p)
    partsByMsg.set(p.messageId, list)
  }

  const result: TuiMessage[] = []

  for (const msg of messages) {
    // Skip aborted assistant messages — partial content should not appear in the TUI
    if (msg.role === "assistant" && msg.finish === "aborted") continue
    const msgParts = partsByMsg.get(msg.id) ?? []
    const tuiParts: TuiPart[] = []

    for (const p of msgParts) {
      if (p.type === "text" || p.type === "summary") {
        const d = JSON.parse(p.data) as TextPartData
        // Skip model-only parts — lineage context and transferred messages
        if (d.visibility === "model-only") continue
        if (d.text) {
          tuiParts.push({ type: "text", text: d.text })
        }
      } else if (p.type === "tool") {
        const raw = JSON.parse(p.data) as Omit<ToolPartData, "status"> & { status?: string }
        const status = normalizeLegacyToolStatus(raw.status ?? "pending")
        let error = raw.error
        if (status === "error" && raw.status === "awaiting_approval" && !error) {
          error = LEGACY_INTERRUPTED_ERROR
        }
        const d: ToolPartData = { ...raw, status, ...(error !== undefined ? { error } : {}) }
        let subAgent: SubAgentState | undefined
        if (d.tool === "subagent") {
          const profile = d.subAgent?.profile ?? (typeof d.input.profile === "string" ? d.input.profile : "sub-agent")
          const prompt = d.subAgent?.prompt ?? (typeof d.input.prompt === "string" ? d.input.prompt : undefined)
          const resolved = resolveSubAgentModelMeta(profile)
          subAgent = {
            profile,
            prompt,
            childSessionId: d.subAgent?.childSessionId,
            modelName: d.subAgent?.modelName ?? resolved.modelName,
            tools: [],
            tokensUsed: 0,
            tokenLimit: d.subAgent?.tokenLimit ?? resolved.tokenLimit,
            ...(d.status === "error" && d.error ? { error: { kind: "process" as const, message: d.error } } : {}),
            done: d.status === "completed" || d.status === "error",
          }
        } else if (d.tool === "bash") {
          // Read-only replay compatibility for historical Bash-based delegation.
          const cmd = (d.input as any)?.command ?? (d.input as any)?.cmd
          if (typeof cmd === "string" && /\bquark\b.*--sub-agent\b/.test(cmd)) {
            const { profile, prompt } = parseSubAgentCommand(cmd)
            const { modelName, tokenLimit } = resolveSubAgentModelMeta(profile)
            subAgent = { profile, prompt, modelName, tools: [], tokensUsed: 0, tokenLimit, done: d.status === "completed" || d.status === "error" }
          }
        }
        tuiParts.push({
          type: "tool",
          tool: d.tool,
          callId: d.callId,
          status: d.status,
          input: d.input,
          output: d.output,
          error: d.error,
          ...(subAgent ? { subAgent } : {}),
        })
      } else if (p.type === "image") {
        const d = JSON.parse(p.data) as ImagePartData
        // Count existing image parts to derive label number
        const idx = tuiParts.filter((x) => x.type === "image").length + 1
        tuiParts.push({ type: "image", mime: d.mime, data: d.data, label: `Image ${idx}` })
      } else if (p.type === "reasoning") {
        const d = JSON.parse(p.data) as ReasoningPartData
        if (d.text) {
          tuiParts.push({ type: "thinking", done: true, text: d.text })
        }
      }
      // skip step-start, step-finish — they're metadata
    }

    if (tuiParts.length > 0) {
      result.push({
        id: msg.id,
        role: msg.role,
        parts: tuiParts,
        ...(msg.role === "user"
          ? { userStatus: msg.finish === "aborted" ? "aborted" as const : "replied" as const }
          : {}),
        streaming: false,
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// SolidJS store
// ---------------------------------------------------------------------------

export interface AppStore {
  sessionId: string | null
  messages: TuiMessage[]
  running: boolean
  steering: boolean
  /** Duration (ms) of the last completed agent run, from user message to assistant finish */
  lastDuration: number | null
  // Worktree
  rootProjectDir: string
  cwd: string
  activeWorktree: TuiWorktree | null
  activeBranch: string | null
  worktreeSwitching: boolean
  thinkingEffort: string
  status: TuiStatus
  error?: string
  question?: QuestionRequest
  questionQueue: QuestionRequest[]
  /** Divider rows inserted after a branch — interleaved with messages in the scrollbox. */
  steerDividers: TuiSteerDivider[]
}

export interface AppState {
  store: AppStore
  setStore: SetStoreFunction<AppStore>
}

export function createAppState(initial: {
  sessionId: string | null
  messages?: TuiMessage[]
  modelName: string
  skillCount: number
  thinkingEffort?: string
  getCatalogModel?: (spec: string) => CatalogModel | null
}): AppState {
  const cwd = process.cwd()
  const [store, setStore] = createStore<AppStore>({
    sessionId: initial.sessionId,
    messages: initial.messages ?? [],
    running: false,
    steering: false,
    lastDuration: null,
    // Worktree
    rootProjectDir: cwd,
    cwd,
    activeWorktree: null,
    activeBranch: null,
    worktreeSwitching: false,
    thinkingEffort: initial.thinkingEffort ?? "none",
    status: {
      tokensUsed: 0,
      tokenLimit: (() => { const lim = initial.getCatalogModel?.(initial.modelName)?.limit; return lim?.context ?? lim?.input ?? 0 })(),
      cost: 0,
      modelName: initial.modelName,
      skillCount: initial.skillCount,
    },
    error: undefined,
    question: undefined,
    questionQueue: [],
    steerDividers: [],
  })
  return { store, setStore }
}

export function dispatch(state: AppState, action: TuiAction): void {
  const { setStore } = state

  switch (action.type) {
    case "set-session":
      setStore("sessionId", action.sessionId)
      break

    case "reset-session":
      setStore(
        produce((s) => {
          s.sessionId = action.sessionId
          s.messages = []
          s.running = false
          s.lastDuration = null
          s.status.tokensUsed = 0
          s.status.cost = 0
          s.error = undefined
          s.question = undefined
          s.steerDividers = []
        }),
      )
      break

    case "load-session":
      setStore(
        produce((s) => {
          s.sessionId = action.sessionId
          s.messages = action.messages
          s.running = false
          s.lastDuration = null
          s.status.tokensUsed = 0
          s.status.cost = 0
          s.error = undefined
          s.steerDividers = []
        }),
      )
      break

    case "append-branch-session":
      setStore(
        produce((s) => {
          s.sessionId = action.sessionId
          s.running = false
          s.lastDuration = null
          s.status.tokensUsed = 0
          s.status.cost = 0
          s.error = undefined
          // Insert divider if not already present (idempotent)
          if (!s.steerDividers.some((d) => d.id === action.divider.id)) {
            s.steerDividers.push({
              id: action.divider.id,
              goal: action.divider.goal,
              label: action.divider.label,
              insertionIndex: s.messages.length,
            })
          }
          // Append visible child messages after the divider
          if (action.messages.length > 0) {
            s.messages.push(...action.messages)
          }
        }),
      )
      break

    case "add-user-message":
      setStore(
        "messages",
        state.store.messages.length,
        {
          id: action.id,
          role: "user",
          userStatus: "sent",
          parts: [
            { type: "text", text: action.text },
            ...(action.images ?? []).map((img, i) => ({
              type: "image" as const,
              mime: img.mime,
              data: img.data,
              label: img.label ?? `Image ${i + 1}`,
            })),
          ],
        },
      )
      break

    case "set-user-message-status":
      setStore(
        "messages",
        (message) => message.id === action.messageId && message.role === "user",
        "userStatus",
        action.status,
      )
      break

    case "add-assistant-message":
      setStore(
        "messages",
        state.store.messages.length,
        {
          id: action.id,
          role: "assistant",
          parts: [],
          streaming: true,
        },
      )
      break

    case "text-start":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          parts.push({ type: "text", text: "", streaming: true })
        }),
      )
      break

    case "text-delta":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          const last = parts[parts.length - 1]
          if (last && last.type === "text") {
            last.text = action.text
          }
        }),
      )
      break

    case "text-end":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          const last = parts[parts.length - 1]
          if (last && last.type === "text") {
            last.text = action.text
            last.streaming = false
          }
        }),
      )
      break

    case "tool-start":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          parts.push({
            type: "tool",
            tool: action.tool,
            callId: action.callId,
            status: "pending",
            input: {},
            output: undefined,
            error: undefined,
            diff: undefined,
            subAgent: undefined,
          })
        }),
      )
      break

    case "tool-input": {
      // Find the part by index so we can use explicit setStore paths
      const tiMsgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (tiMsgIdx === -1) break
      const tiPartIdx = state.store.messages[tiMsgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.callId,
      )
      if (tiPartIdx === -1) break
      setStore("messages", tiMsgIdx, "parts", tiPartIdx, produce((part: TuiPart) => {
        if (part.type === "tool") {
          part.status = "pending"
          part.input = action.input
          part.diff = action.diff
        }
      }))
      // First-class calls initialize directly from structured tool input.
      const tiPart = state.store.messages[tiMsgIdx]!.parts[tiPartIdx] as Extract<TuiPart, { type: "tool" }>
      if (tiPart.tool === "subagent" && !tiPart.subAgent) {
        const profile = typeof action.input.profile === "string" ? action.input.profile : "sub-agent"
        const prompt = typeof action.input.prompt === "string" ? action.input.prompt.slice(0, 200) : undefined
          const { modelName, tokenLimit } = resolveSubAgentModelMeta(profile)
          setStore("messages", tiMsgIdx, "parts", tiPartIdx, "subAgent" as any, {
            profile,
            prompt,
            modelName,
            tools: [],
            tokensUsed: 0,
            tokenLimit,
            done: false,
            startedAt: Date.now(),
          })
      }
      break
    }

    case "tool-end":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          const part = parts.find((p) => p.type === "tool" && p.callId === action.callId)
          if (part && part.type === "tool") {
            part.status = action.status
            part.output = action.output
            part.error = action.error
            part.diff = action.diff
            part.streamingContent = undefined
            // Cascade status to sub-agent: when the parent tool ends (error or
            // completed), mark the sub-agent as done and transition any
            // pending/running child tools to the parent's terminal status.
            if (part.subAgent) {
              part.subAgent.done = true
              part.subAgent.textPreview = undefined
              if (action.status === "error" && action.error && !part.subAgent.error) {
                part.subAgent.error = { kind: "process", message: action.error }
              }
              if (part.subAgent.startedAt != null) part.subAgent.durationMs = Date.now() - part.subAgent.startedAt
              const childStatus = action.status === "error" ? "error" as const : "completed" as const
              for (const child of part.subAgent.tools) {
                if (child.status === "pending" || child.status === "running") {
                  child.status = childStatus
                }
              }
            }
          }
        }),
      )
      break

    case "tool-running":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          const part = parts.find((p) => p.type === "tool" && p.callId === action.callId)
          if (part && part.type === "tool") {
            part.status = "running"
          }
        }),
      )
      break

    case "tool-stream-delta":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          const part = parts.find((p) => p.type === "tool" && p.callId === action.callId)
          if (part && part.type === "tool") {
            part.streamingContent = action.content
          }
        }),
      )
      break

    case "assistant-done":
      setStore("messages", (m) => m.id === action.messageId, "streaming", false)
      break

    case "set-running":
      setStore("running", action.running)
      break

    case "set-steering":
      setStore("steering", action.steering)
      break

    case "set-last-duration":
      setStore(
        produce((s) => {
          if (action.duration > 0) {
            s.lastDuration = action.duration
            s.lastDurationSetAt = Date.now()
          } else {
            s.lastDuration = null
            s.lastDurationSetAt = 0
          }
        }),
      )
      break

    case "update-status":
      setStore("status", (prev) => ({ ...prev, ...action.partial }))
      break

    case "set-error":
      setStore(
        produce((s) => {
          s.error = action.message
          s.running = false
        }),
      )
      break

    case "clear-error":
      setStore("error", undefined)
      break

    case "set-question":
      setStore(
        produce((s) => {
          if (s.question) {
            // Another question is already visible — queue this one
            s.questionQueue.push(action.request)
          } else {
            s.question = action.request
            s.running = false
          }
        }),
      )
      break

    case "clear-question":
      setStore(
        produce((s) => {
          const next = s.questionQueue.shift()
          if (next) {
            s.question = next
          } else {
            s.question = undefined
          }
        }),
      )
      break

    case "cycle-thinking": {
      const levels = action.model ? thinkingCapabilityFromCatalog(action.model)?.levels : null
      if (!levels) {
        // Model doesn't support thinking — force to "none"
        setStore("thinkingEffort", "none")
        break
      }
      const idx = levels.indexOf(state.store.thinkingEffort)
      setStore("thinkingEffort", levels[(idx + 1) % levels.length] ?? "none")
      break
    }

    case "reasoning-start":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          parts.push({ type: "thinking", done: false, text: "", startedAt: Date.now() })
        }),
      )
      break

    case "reasoning-delta":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          const last = parts[parts.length - 1]
          if (last && last.type === "thinking") {
            last.text = action.text
          }
        }),
      )
      break

    case "reasoning-end":
      setStore(
        "messages",
        (m) => m.id === action.messageId,
        "parts",
        produce((parts: TuiPart[]) => {
          const last = parts[parts.length - 1]
          if (last && last.type === "thinking") {
            last.done = true
            if (last.startedAt != null) last.durationMs = Date.now() - last.startedAt
          }
        }),
      )
      break

    case "model-switched": {
      const lim = action.catalogModel?.limit
      const newLimit = lim?.context ?? lim?.input ?? 0
      setStore("status", "tokenLimit", newLimit)
      setStore("status", "modelName", action.modelSpec)
      if (action.thinkingEffort !== undefined) {
        setStore("thinkingEffort", action.thinkingEffort)
      }
      break
    }

    case "truncate-messages":
      setStore(
        "messages",
        produce((msgs: TuiMessage[]) => {
          const idx = msgs.findIndex((m) => m.id === action.upToMessageId)
          if (idx !== -1) {
            msgs.splice(idx) // remove from this message onwards
          }
        }),
      )
      setStore("status", "tokensUsed", action.tokensUsed)
      break

    case "remove-message":
      setStore(
        "messages",
        produce((msgs: TuiMessage[]) => {
          const idx = msgs.findIndex((m) => m.id === action.messageId)
          if (idx !== -1) msgs.splice(idx, 1)
        }),
      )
      break

    // ------------------------------------------------------------------
    // Sub-agent observability — mutate the parent tool part's subAgent state
    //
    // All handlers use explicit setStore() path notation (never produce() for
    // the subAgent property itself). SolidJS tracks property paths set via
    // setStore(); assigning parent.subAgent = {} inside produce() on a
    // previously-undefined property does NOT reliably notify Match/Show
    // conditions watching that path.
    // ------------------------------------------------------------------

    case "subagent-tool-start": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const tsPart = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      // Ignore late events if parent already reached a terminal state (abort/done)
      if (tsPart.status === "error" || tsPart.status === "completed") break
      if (!tsPart.subAgent) {
        // First sub-agent event — initialize subAgent via explicit path so SolidJS
        // registers the new property and notifies all Match/Show watchers.
        setStore("messages", msgIdx, "parts", partIdx, "subAgent" as any, {
          profile: action.profile,
          tools: [],
          tokensUsed: 0,
          tokenLimit: 0,
          done: false,
          startedAt: Date.now(),
        })
      }
      setStore(
        "messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((sa: SubAgentState) => {
          sa.tools.push({ tool: action.tool, callId: action.callId, status: "pending", input: {} })
          // The model has stopped streaming text and committed to a tool call.
          // Clear the stale textPreview so the "Thinking…" line doesn't linger
          // below the tool list, lying about the agent's current activity.
          sa.textPreview = undefined
        }),
      )
      break
    }

    case "subagent-tool-input": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const tiPart = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      // Ignore late events if parent already reached a terminal state (abort/done)
      if (tiPart.status === "error" || tiPart.status === "completed") break
      const sa = tiPart.subAgent
      if (!sa) break
      const childIdx = sa.tools.findIndex((t) => t.callId === action.callId)
      if (childIdx === -1) break
      setStore(
        "messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((s: SubAgentState) => {
          s.tools[childIdx]!.status = "pending"
          s.tools[childIdx]!.input = action.input
        }),
      )
      break
    }

    case "subagent-tool-running": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const parent = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      if (parent.status === "error" || parent.status === "completed" || !parent.subAgent) break
      const childIdx = parent.subAgent.tools.findIndex((tool) => tool.callId === action.callId)
      if (childIdx === -1) break
      setStore(
        "messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((subAgent: SubAgentState) => {
          const child = subAgent.tools[childIdx]!
          if (child.status === "pending") {
            child.status = "running"
          }
        }),
      )
      break
    }

    case "subagent-tool-end": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const tePart = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      // Ignore late events if parent already reached a terminal state (abort/done)
      if (tePart.status === "error" || tePart.status === "completed") break
      const sa = tePart.subAgent
      if (!sa) break
      const childIdx = sa.tools.findIndex((t) => t.callId === action.callId)
      if (childIdx === -1) break
      setStore(
        "messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((s: SubAgentState) => {
          s.tools[childIdx]!.status = action.status
          s.tools[childIdx]!.error = action.error
        }),
      )
      break
    }

    case "subagent-step-finish": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const sfPart = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      // Ignore late events if parent already reached a terminal state (abort/done)
      if (sfPart.status === "error" || sfPart.status === "completed") break
      if (!sfPart.subAgent) {
        setStore("messages", msgIdx, "parts", partIdx, "subAgent" as any, {
          profile: action.profile,
          tools: [],
          tokensUsed: 0,
          tokenLimit: 0,
          done: false,
          startedAt: Date.now(),
        })
      }
      setStore(
        "messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((sa: SubAgentState) => {
          if (action.tokens?.input) sa.tokensUsed = action.tokens.input
          if (action.tokenLimit && action.tokenLimit > 0) sa.tokenLimit = action.tokenLimit
          if (action.modelName) sa.modelName = action.modelName
        }),
      )
      break
    }

    case "subagent-text-delta": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const tdPart = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      // Ignore late events if parent already reached a terminal state (abort/done)
      if (tdPart.status === "error" || tdPart.status === "completed") break
      if (!tdPart.subAgent) {
        setStore("messages", msgIdx, "parts", partIdx, "subAgent" as any, {
          profile: action.profile,
          tools: [],
          tokensUsed: 0,
          tokenLimit: 0,
          done: false,
          startedAt: Date.now(),
        })
      }
      const text = action.text
      const preview = text.length > 120 ? "…" + text.slice(-119) : text
      setStore("messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((sa: SubAgentState) => { sa.textPreview = preview })
      )
      break
    }

    case "subagent-error": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const parent = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      if (!parent.subAgent) {
        setStore("messages", msgIdx, "parts", partIdx, "subAgent" as any, {
          profile: action.profile,
          tools: [],
          tokensUsed: 0,
          tokenLimit: 0,
          done: false,
          startedAt: Date.now(),
        })
      }
      setStore(
        "messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((subAgent: SubAgentState) => {
          subAgent.error = { kind: action.kind, message: action.message }
          subAgent.textPreview = undefined
        }),
      )
      break
    }

    case "subagent-done": {
      const msgIdx = state.store.messages.findIndex((m) => m.id === action.messageId)
      if (msgIdx === -1) break
      const partIdx = state.store.messages[msgIdx]!.parts.findIndex(
        (p) => p.type === "tool" && (p as Extract<TuiPart, { type: "tool" }>).callId === action.parentCallId
      )
      if (partIdx === -1) break
      const parentPart = state.store.messages[msgIdx]!.parts[partIdx] as Extract<TuiPart, { type: "tool" }>
      // If the parent tool already reached a terminal state (error/completed)
      // via tool-end (e.g. abort), ignore late subagent-done events to prevent
      // clobbering the error status back to completed.
      if (parentPart.status === "error" || parentPart.status === "completed") break
      if (!parentPart.subAgent) {
        setStore("messages", msgIdx, "parts", partIdx, "subAgent" as any, {
          profile: action.profile,
          tools: [],
          tokensUsed: 0,
          tokenLimit: 0,
          done: false,
          startedAt: Date.now(),
        })
      }
      setStore("messages", msgIdx, "parts", partIdx, "subAgent" as any,
        produce((sa: SubAgentState) => {
          sa.done = true
          sa.textPreview = undefined
          if (sa.startedAt != null) sa.durationMs = Date.now() - sa.startedAt
        })
      )
      // Mark the parent tool part as completed so the InlineSpinner stops animating.
      setStore("messages", msgIdx, "parts", partIdx, produce((part: TuiPart) => {
        if (part.type === "tool") part.status = "completed"
      }))
      break
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Worktree actions
    // ------------------------------------------------------------------

    case "worktree-switch-start":
      setStore("worktreeSwitching", true)
      break

    case "worktree-switched":
      setStore(
        produce((s) => {
          s.cwd = action.cwd
          s.activeWorktree = action.activeWorktree
          s.activeBranch = action.activeBranch
          s.worktreeSwitching = false

          s.sessionId = null
          s.messages = []
          s.running = false
          s.status.tokensUsed = 0
          s.status.cost = 0
          s.status.modelName = action.modelSpec
          s.status.skillCount = action.skillCount
          s.error = undefined
          s.question = undefined
          s.questionQueue = []
          s.steerDividers = []
        }),
      )
      break

    case "worktree-switch-failed":
      setStore(
        produce((s) => {
          s.worktreeSwitching = false
          s.error = action.message
          s.running = false
        }),
      )
      break
  }
}
