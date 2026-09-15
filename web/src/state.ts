import { createStore, produce } from "solid-js/store"
import { Api } from "./api"
import { applySubAgentEvent, finishSubAgent, initializeSubAgent, type SubAgentEvent } from "./subagent"
import type { AppStatus, CatalogModel, Message, MessagePart, QuestionRequest, SessionSummary } from "./types"

interface WebState {
  sessions: SessionSummary[]
  session: SessionSummary | null
  messages: Message[]
  status: AppStatus
  tokensUsed: number
  running: boolean
  question: QuestionRequest | null
  notice: string | null
  noticeKind: "info" | "error"
  models: CatalogModel[]
  profiles: string[]
  skills: string[]
  activeSkills: string[]
}

const EMPTY_STATUS: AppStatus = {
  modelName: "Loading…",
  modelLabel: "Loading…",
  thinkingEffort: "none",
  thinkingLevels: ["none"],
  tokenLimit: 0,
  cwd: "Loading…",
  branch: null,
  profile: "default",
}

export function createWebApp(api = new Api()) {
  const [state, setState] = createStore<WebState>({
    sessions: [],
    session: null,
    messages: [],
    status: EMPTY_STATUS,
    tokensUsed: 0,
    running: false,
    question: null,
    notice: null,
    noticeKind: "info",
    models: [],
    profiles: [],
    skills: [],
    activeSkills: [],
  })

  let events: EventSource | null = null
  let noticeTimer: number | undefined
  let activationVersion = 0

  const showNotice = (message: string, kind: "info" | "error" = "info") => {
    setState({ notice: message, noticeKind: kind })
    window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => setState("notice", null), 7_000)
  }

  const activate = (session: SessionSummary, messages: Message[], tokensUsed = 0) => {
    activationVersion++
    setState({ session, messages, tokensUsed, running: session.running, question: null })
    connectEvents(session.id)
  }

  const applySnapshot = (sessionId: string, data: { session: SessionSummary; messages: Message[]; tokensUsed: number }) => {
    if (state.session?.id !== sessionId || data.session.id !== sessionId) return
    setState({ session: data.session, messages: data.messages, tokensUsed: data.tokensUsed, running: data.session.running })
    setState("sessions", (sessions) => sessions.map((session) => session.id === sessionId ? data.session : session))
  }

  const mutateMessage = (messageId: string, change: (message: Message) => void) => {
    setState("messages", produce((messages) => {
      const message = messages.find((item) => item.id === messageId)
      if (message) change(message)
    }))
  }

  const updatePart = <T extends MessagePart>(messageId: string, partId: string, fallback: T, change?: (part: T) => void) => {
    mutateMessage(messageId, (message) => {
      let part = message.parts.find((item) => item._id === partId) as T | undefined
      if (!part) {
        part = { ...fallback, _id: partId }
        message.parts.push(part)
      }
      change?.(part)
    })
  }

  const updateTool = (messageId: string, callId: string, change: (part: Extract<MessagePart, { type: "tool" }>) => void) => {
    mutateMessage(messageId, (message) => {
      const part = message.parts.find((item): item is Extract<MessagePart, { type: "tool" }> => item.type === "tool" && item.callId === callId)
      if (part) change(part)
    })
  }

  const handleEvent = (type: string, data: any) => {
    if (type === "user-message" && !state.messages.some((message) => message.id === data.messageId)) {
      setState("messages", (messages) => [...messages, {
        id: data.messageId,
        role: "user",
        timeCreated: Date.now(),
        parts: [{ type: "text", text: data.text }],
      }])
    }
    if (type === "assistant-message-start" && !state.messages.some((message) => message.id === data.messageId)) {
      setState("messages", (messages) => [...messages, {
        id: data.messageId,
        role: "assistant",
        timeCreated: Date.now(),
        streaming: true,
        parts: [],
      }])
    }
    if (type === "text-start") updatePart(data.messageId, data.partId, { type: "text", text: "", streaming: true })
    if (type === "text-delta" || type === "text-end") {
      updatePart<Extract<MessagePart, { type: "text" }>>(data.messageId, data.partId, { type: "text", text: "", streaming: false }, (part) => {
        part.text = data.text
        part.streaming = type === "text-delta"
      })
    }
    if (type === "tool-start") {
      updatePart(data.messageId, data.partId, {
        type: "tool",
        tool: data.tool,
        callId: data.callId,
        status: "pending",
        input: {},
      })
    }
    if (type === "tool-input") updateTool(data.messageId, data.callId, (part) => {
      part.input = data.input
      part.diff = data.diff
      if (part.tool === "subagent") initializeSubAgent(part)
    })
    if (type === "tool-running") updateTool(data.messageId, data.callId, (part) => { part.status = "running" })
    if (type === "tool-end") updateTool(data.messageId, data.callId, (part) => {
      part.status = data.status
      part.output = data.output
      part.error = data.error
      part.diff = data.diff
      finishSubAgent(part)
    })
    if (type.startsWith("subagent-")) {
      const eventType = type.slice("subagent-".length)
      const event = eventType === "tool-start"
        ? { type: "tool-start", profile: data.profile, tool: data.tool, callId: data.callId }
        : eventType === "tool-input"
          ? { type: "tool-input", profile: data.profile, callId: data.callId, input: data.input }
          : eventType === "tool-running"
            ? { type: "tool-running", profile: data.profile, callId: data.callId }
            : eventType === "tool-end"
              ? { type: "tool-end", profile: data.profile, callId: data.callId, status: data.status, error: data.error }
              : eventType === "step-finish"
                ? { type: "step-finish", profile: data.profile, tokens: data.tokens, tokenLimit: data.tokenLimit, modelName: data.modelName }
                : eventType === "text-delta"
                  ? { type: "text-delta", profile: data.profile, text: data.text }
                  : eventType === "error"
                    ? { type: "error", profile: data.profile, kind: data.kind, message: data.message }
                    : eventType === "done"
                      ? { type: "done", profile: data.profile }
                      : null
      if (event) updateTool(data.messageId, data.parentCallId, (part) => applySubAgentEvent(part, event as SubAgentEvent))
    }
    if (type === "reasoning-start") updatePart(data.messageId, data.partId, { type: "thinking", text: "", done: false })
    if (type === "reasoning-delta") {
      updatePart(data.messageId, data.partId, { type: "thinking", text: "", done: false }, (part) => { part.text = data.text })
    }
    if (type === "reasoning-end") {
      updatePart(data.messageId, data.partId, { type: "thinking", text: "", done: true }, (part) => { part.done = true })
    }
    if (type === "assistant-message-end") mutateMessage(data.messageId, (message) => { message.streaming = false })
    if (type === "user-message-status") mutateMessage(data.messageId, (message) => { message.status = data.status })
    if (type === "step-finish") setState("tokensUsed", data.data?.tokens?.input ?? 0)
    if (type === "loop-start") setState("running", true)
    if (type === "loop-end") {
      setState("running", false)
      void refreshSession()
    }
    if (type === "question-request") setState("question", data)
    if (type === "session-title-changed") {
      if (state.session?.id === data.sessionId) setState("session", "title", data.title ?? "New session")
      setState("sessions", (sessions) => sessions.map((session) => session.id === data.sessionId
        ? { ...session, title: data.title ?? "New session" }
        : session))
    }
    if (type === "session-switch") void selectSession(data.sessionId)
    if (type === "retry") showNotice(`Retrying in ${Math.round(data.delayMs / 1000)}s: ${data.error}`, "error")
    if (type === "context-too-long") showNotice("Context is full. Preparing a continuation session…")
    if (type === "error") showNotice(data.error, "error")
  }

  function connectEvents(sessionId: string) {
    events?.close()
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
    events = source
    source.onmessage = (event) => {
      if (source !== events || state.session?.id !== sessionId) return
      try {
        const message = JSON.parse(event.data)
        if (message.type === "snapshot") applySnapshot(sessionId, message.data)
        else if (message.type === "connected") setState("notice", null)
        else if (message.type !== "heartbeat") handleEvent(message.type, message.data)
      } catch {
        showNotice("Received an invalid live update.", "error")
      }
    }
    source.onerror = () => {
      if (source === events) showNotice("Live connection lost. Reconnecting…", "error")
    }
  }

  async function loadCatalog() {
    try {
      const data = await api.catalog()
      setState({
        profiles: data.profiles,
        skills: data.skills,
        activeSkills: data.activeSkills,
        status: { ...state.status, profile: data.profile },
      })
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function init() {
    try {
      const data = await api.state()
      setState({ sessions: data.sessions, status: data.status })
      // Root is always a fresh composer. A session is activated only by the
      // picker/sidebar or after the user sends their first message.
      void loadCatalog()
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function newSession(): Promise<SessionSummary> {
    const data = await api.createSession()
    setState("sessions", (sessions) => [data.session, ...sessions])
    activate(data.session, [])
    return data.session
  }

  async function selectSession(sessionId: string) {
    const requestVersion = ++activationVersion
    try {
      const data = await api.loadSession(sessionId)
      if (requestVersion !== activationVersion) return
      activate(data.session, data.messages, data.tokensUsed)
    } catch (error) {
      if (requestVersion === activationVersion) showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function refreshSession() {
    const sessionId = state.session?.id
    if (!sessionId) return
    const requestVersion = activationVersion
    const data = await api.loadSession(sessionId)
    if (requestVersion !== activationVersion || state.session?.id !== sessionId) return
    applySnapshot(sessionId, data)
  }

  async function send(text: string) {
    try {
      const session = state.session ?? await newSession()
      setState("running", true)
      await api.send(session.id, text)
    } catch (error) {
      setState("running", false)
      showNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function cancel() {
    if (state.session) await api.cancel(state.session.id)
  }

  async function answer(requestId: string, answers: string[][], rejected = false) {
    await api.answer(requestId, answers, rejected)
    setState("question", null)
  }

  async function undo() {
    if (!state.session) return showNotice("No session to undo.")
    try {
      const result = await api.undo(state.session.id)
      if (!result.undone) return showNotice("Nothing to undo — no tracked file changes.")
      const changes = [
        result.restored.length ? `${result.restored.length} file(s) restored` : "",
        result.deleted.length ? `${result.deleted.length} file(s) deleted` : "",
      ].filter(Boolean).join(", ")
      showNotice(`Undo: ${changes || "no changes"}.`)
      await refreshSession()
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function exportSession() {
    if (!state.session) return showNotice("No session to export.")
    try {
      const result = await api.exportMarkdown(state.session.id)
      showNotice(`Exported ${result.messageCount} message(s) to ${result.filePath}`)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function loadModels() {
    if (state.models.length) return
    try {
      const data = await api.models()
      setState("models", data.models)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function setModel(spec: string) {
    try {
      const result = await api.setModel(spec)
      setState("status", result.status)
      showNotice(`Model: ${result.status.modelLabel}`)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function setThinking(effort: string | null) {
    try {
      setState("status", (await api.setThinking(effort)).status)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function setProfile(name: string) {
    try {
      const result = await api.setProfile(name)
      setState("status", result.status)
      showNotice(`Profile: ${result.status.profile}`)
      await loadCatalog()
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function activateSkill(name: string) {
    try {
      const result = await api.activateSkill(name)
      setState("activeSkills", result.active)
      showNotice(result.activated ? `Added skill: ${name}` : result.reason ?? `Skill: ${name}`)
      await loadCatalog()
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function reloadConfig() {
    try {
      const result = await api.reloadConfig()
      setState("status", result.status)
      showNotice("Config reloaded")
      await loadCatalog()
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function branch(kind: "steer" | "compact", goal: string) {
    if (!state.session) return showNotice(`No session to ${kind}.`)
    try {
      const result = await api.branch(kind, state.session.id, goal)
      setState("status", result.status)
      await selectSession(result.sessionId)
      // The branch is a brand new session, so the sidebar list needs a refresh.
      setState("sessions", (await api.state()).sessions)
      showNotice(kind === "steer"
        ? "Branched to a new session with the full history."
        : "Branched to a new session with compacted history.")
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  const dispose = () => {
    events?.close()
    window.clearTimeout(noticeTimer)
  }

  return { state, init, newSession, selectSession, send, cancel, answer, undo, exportSession, setModel, setProfile, activateSkill, reloadConfig, branch, loadCatalog, loadModels, setThinking, showNotice, dispose }
}

export type WebApp = ReturnType<typeof createWebApp>
