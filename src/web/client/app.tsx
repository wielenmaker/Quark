import { useReducer, useRef, useEffect, useCallback } from 'react'
import { api } from './api'
import { useViewportHeight, getGreeting } from './hooks'
import { reducer, initialState } from './state'
import type { AppState, Action, SubAgentState } from './state'
import { QuarkLogo } from './icons'
import { T } from './tokens'
import { Header, RunningBar } from './components/header'
import { Sidebar } from './components/sidebar'
import { MessageItem } from './components/message-item'
import { TypingIndicator } from './components/typing-indicator'
import { InputArea } from './components/input-area'
import { PermissionDialog } from './components/permission-dialog'
import { Toasts } from './components/toasts'

const COMPACTION_TOAST_ID = -1

export function App() {
  const vh = useViewportHeight()
  const [s, dispatch] = useReducer(reducer, initialState)
  const wsRef = useRef<WebSocket | null>(null)
  const msgEndRef = useRef<HTMLDivElement>(null)
  const reconnectDelay = useRef(1000)

  const set = useCallback((p: Partial<AppState>) => dispatch({ type: 'SET', payload: p }), [])
  const toast = useCallback((title: string, body: string, kind?: 'error' | 'warn', opts?: { id?: number; persistent?: boolean }) => {
    const id = opts?.id ?? Date.now()
    dispatch({ type: 'ADD_TOAST', id, title, body, kind })
    if (!opts?.persistent) setTimeout(() => dispatch({ type: 'REMOVE_TOAST', id }), 5000)
    return id
  }, [])

  // Persist sessionId to localStorage
  const SESSION_KEY = 'quark-session-id'
  useEffect(() => {
    if (s.sessionId) localStorage.setItem(SESSION_KEY, s.sessionId)
  }, [s.sessionId])

  // Restore session on mount
  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY)
    if (!saved) return
    set({ sessionId: saved })
    api('GET', `/api/sessions/${saved}/messages`)
      .then((msgs: any) => dispatch({ type: 'LOAD_MESSAGES', messages: msgs }))
      .catch(() => localStorage.removeItem(SESSION_KEY))
  }, [])

  // Auto-scroll
  useEffect(() => {
    if (msgEndRef.current) msgEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [s.messages, s.running])

  // WebSocket connection
  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      if (cancelled) return
      // Ensure previous connection is fully closed before opening a new one
      if (ws) {
        ws.onopen = null
        ws.onclose = null
        ws.onerror = null
        ws.onmessage = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close()
        }
      }

      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws

      ws.onopen = () => {
        if (cancelled) return
        set({ connected: true })
        reconnectDelay.current = 1000
      }
      ws.onclose = () => {
        if (cancelled) return
        set({ connected: false })
        reconnectTimer = setTimeout(connect, reconnectDelay.current)
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000)
      }
      ws.onerror = () => {}
      ws.onmessage = (e) => {
        try {
          const { event, data } = JSON.parse(e.data)
          handleEvent(event, data)
        } catch {}
      }

      const ping = setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })) }, 30000)
      ws.addEventListener('close', () => clearInterval(ping))
    }
    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        ws.onopen = null
        ws.onclose = null
        ws.onerror = null
        ws.onmessage = null
        ws.close()
      }
    }
  }, [])

  // Event handler
  function handleEvent(event: string, d: any) {
    switch (event) {
      case 'session-created':
        set({ sessionId: d.sessionId })
        refreshSessions()
        break
      case 'user-message':
        dispatch({ type: 'ADD_USER_MSG', id: d.messageId, text: d.text })
        break
      case 'assistant-message-start':
        dispatch({ type: 'ENSURE_ASSISTANT', id: d.messageId })
        break
      case 'text-start':
        dispatch({ type: 'ENSURE_ASSISTANT', id: d.messageId })
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => {
          const hasTxt = m.parts.find(p => p.type === 'text' && (p as any).partId === d.partId)
          if (hasTxt) return m
          return { ...m, parts: [...m.parts, { type: 'text' as const, text: '', partId: d.partId, streaming: true }] }
        }})
        break
      case 'text-delta':
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'text' && (p as any).partId === d.partId ? { ...p, text: d.text, streaming: true } : p) }) })
        break
      case 'text-end':
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'text' && (p as any).partId === d.partId ? { ...p, text: d.text, streaming: false } : p) }) })
        break
      case 'tool-start':
        dispatch({ type: 'ENSURE_ASSISTANT', id: d.messageId })
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: [...m.parts, { type: 'tool' as const, tool: d.tool, callId: d.callId, status: 'running' as const, input: null, output: null, error: null }] }) })
        break
      case 'tool-input':
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'tool' && p.callId === d.callId ? { ...p, input: d.input } : p) }) })
        // Eagerly initialize subAgent when bash command is a sub-agent invocation
        if (d.tool === 'bash') {
          const cmd = d.input?.command ?? d.input?.cmd
          if (typeof cmd === 'string' && /\bquark\b.*--sub-agent\b/.test(cmd)) {
            const profile = cmd.match(/--profile\s+(\S+)/)?.[1] ?? 'sub-agent'
            dispatch({ type: 'INIT_SUBAGENT', messageId: d.messageId, callId: d.callId, profile })
          }
        }
        break
      case 'tool-end':
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'tool' && p.callId === d.callId ? { ...p, status: d.status === 'completed' ? 'completed' as const : 'error' as const, output: d.output || null, error: d.error || null } : p) }) })
        break
      case 'reasoning-start':
        dispatch({ type: 'ENSURE_ASSISTANT', id: d.messageId })
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: [...m.parts, { type: 'thinking' as const, text: '', partId: d.partId, done: false }] }) })
        break
      case 'reasoning-delta':
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'thinking' && (p as any).partId === d.partId ? { ...p, text: d.text } : p) }) })
        break
      case 'reasoning-end':
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'thinking' && (p as any).partId === d.partId ? { ...p, done: true } : p) }) })
        break
      case 'step-finish':
        if (d.data?.tokens?.input) set({ tokensUsed: d.data.tokens.input })
        break
      case 'loop-start': set({ running: true }); break
      case 'loop-end': set({ running: false }); break
      case 'assistant-message-end':
        if (d.finish === 'stop' || d.finish === 'length') set({ running: false })
        break
      case 'permission-request':
        set({ permission: d })
        break
      case 'error': {
        const t = typeof d.error === 'string' ? d.error : (d.error?.message || JSON.stringify(d.error))
        if (!/abort/i.test(t)) toast('Error', t, 'error')
        break
      }
      case 'retry':
        toast('Retrying', `Attempt ${d.attempt} — ${Math.round((d.delayMs || 1000) / 1000)}s…`, 'warn')
        break
      case 'compaction-start':
        set({ compacting: true })
        toast('Compacting', 'Compacting context…', 'warn', { id: COMPACTION_TOAST_ID, persistent: true })
        break
      case 'compaction-end': {
        set({ compacting: false })
        dispatch({ type: 'REMOVE_TOAST', id: COMPACTION_TOAST_ID })
        const result = d.result
        if (!result) {
          toast('Compaction failed', 'An error occurred during compaction', 'error')
        } else if (result.evictedCount === 0) {
          toast('Nothing to compact', 'Not enough turns to compact — keep chatting', 'warn')
        } else {
          toast('Compacted', `Evicted ${result.evictedCount} messages`, 'warn')
        }
        break
      }
      case 'session-switch':
        set({ sessionId: d.sessionId })
        if (d.messages) dispatch({ type: 'LOAD_MESSAGES', messages: d.messages })
        if (d.estimatedTokens) set({ tokensUsed: d.estimatedTokens })
        refreshSessions()
        break
      case 'session-reset':
        set({ sessionId: d.sessionId })
        dispatch({ type: 'CLEAR_MESSAGES' })
        set({ tokensUsed: 0 })
        break
      case 'subagent-tool-start':
        dispatch({ type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          sa.tools.push({ tool: d.tool, callId: d.callId, status: 'pending', input: {} })
        }, profile: d.profile })
        break
      case 'subagent-tool-input':
        dispatch({ type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          const t = sa.tools.find((t: any) => t.callId === d.callId)
          if (t) { t.status = 'running'; t.input = d.input }
        }, profile: d.profile })
        break
      case 'subagent-tool-end':
        dispatch({ type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          const t = sa.tools.find((t: any) => t.callId === d.callId)
          if (t) { t.status = d.status === 'completed' ? 'completed' : 'error'; t.error = d.error }
        }, profile: d.profile })
        break
      case 'subagent-step-finish':
        dispatch({ type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          if (d.tokens?.input) sa.tokensUsed = d.tokens.input
          if (d.tokenLimit && d.tokenLimit > 0) sa.tokenLimit = d.tokenLimit
        }, profile: d.profile })
        break
      case 'subagent-text-delta':
        dispatch({ type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          const text = d.text
          sa.textPreview = text.length > 120 ? '…' + text.slice(-119) : text
        }, profile: d.profile })
        break
      case 'subagent-done':
        dispatch({ type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          sa.done = true
          sa.textPreview = undefined
        }, profile: d.profile })
        break
    }
  }

  // REST calls
  async function refreshSessions() {
    try { const ss = await api('GET', '/api/sessions'); set({ sessions: ss }) } catch {}
  }
  async function loadModels() {
    try {
      const [mr, cr] = await Promise.all([api('GET', '/api/models'), api('GET', '/api/model')])
      set({ models: mr.models || [], modelName: cr.model || '—' })
    } catch {}
  }
  async function loadAppConfig() {
    try { const c = await api('GET', '/api/config'); set({ tokenLimit: c.contextWindow || 200000 }) } catch {}
  }

  // Initial health check — set connected immediately if server responds
  // (avoids red flash while WS handshake is in flight)
  useEffect(() => {
    api('GET', '/api/health').then(() => set({ connected: true })).catch(() => {})
  }, [])

  useEffect(() => { refreshSessions(); loadModels(); loadAppConfig() }, [])

  // Actions
  async function sendMessage(text: string, images: { mime: string; data: string }[] = []) {
    if (!text.trim() && images.length === 0 || s.running) return
    const body: any = { text: text.trim() }
    if (s.sessionId) body.sessionId = s.sessionId
    if (images.length > 0) body.images = images.map(({ mime, data }) => ({ mime, data }))
    try {
      const r = await api('POST', '/api/prompt', body)
      if (r.sessionId) set({ sessionId: r.sessionId })
    } catch { toast('Error', 'Failed to send', 'error') }
  }

  async function cancelAgent() {
    if (!s.sessionId) return
    try { await api('POST', '/api/cancel', { sessionId: s.sessionId }) } catch {}
  }

  async function switchSession(id: string) {
    set({ sessionId: id, tokensUsed: 0, sidebarOpen: false })
    try {
      const msgs = await api('GET', `/api/sessions/${id}/messages`)
      dispatch({ type: 'LOAD_MESSAGES', messages: msgs })
    } catch { toast('Error', 'Failed to load session', 'error') }
  }

  async function newSession() {
    try {
      const r = await api('POST', '/api/sessions')
      set({ sessionId: r.sessionId })
      dispatch({ type: 'CLEAR_MESSAGES' })
      set({ tokensUsed: 0 })
      await refreshSessions()
    } catch {}
  }

  async function switchModel(model: string) {
    try {
      const r = await api('POST', '/api/model', { model })
      set({ modelName: r.model || model, modelPickerOpen: false })
    } catch { toast('Error', 'Failed to switch model', 'error') }
  }

  async function compactContext() {
    if (!s.sessionId) {
      toast('Nothing to compact', 'No active session', 'warn')
      return
    }
    try {
      set({ compacting: true })
      const r = await api<{ ok?: boolean; error?: string }>('POST', '/api/compact', { sessionId: s.sessionId })
      if (r.error) {
        set({ compacting: false })
        dispatch({ type: 'REMOVE_TOAST', id: COMPACTION_TOAST_ID })
        toast('Compaction failed', r.error, 'error')
      }
    } catch {
      set({ compacting: false })
      dispatch({ type: 'REMOVE_TOAST', id: COMPACTION_TOAST_ID })
      toast('Error', 'Failed to compact', 'error')
    }
  }

  async function respondPerm(action: 'once' | 'always' | 'reject') {
    if (!s.permission) return
    set({ permission: null })
    try { await api('POST', '/api/permission', { sessionId: s.sessionId, requestId: s.permission.requestId, action }) } catch {}
  }

  const hasMessages = s.messages.length > 0

  return (
    <div className="app-shell" style={{ height: vh }}>
      <Sidebar
        open={s.sidebarOpen}
        sessions={s.sessions}
        activeId={s.sessionId}
        onClose={() => set({ sidebarOpen: false })}
        onNewSession={newSession}
        onSwitchSession={switchSession}
      />

      <div className="main-area">
        <Header state={s} dispatch={dispatch} onCancel={cancelAgent} onSwitchModel={switchModel} />
        <div className="header-spacer" />

        {s.running && <RunningBar onCancel={cancelAgent} />}

        <div className="message-scroll">
          {!hasMessages ? (
            <div className="empty-state">
              <QuarkLogo size={36} />
              <h1 style={{ fontFamily: T.fontSerif, fontSize: 26, fontWeight: 300, color: T.text, textAlign: 'center', lineHeight: 1.35, marginTop: 16 }}>
                How can I help you<br />{getGreeting()}?
              </h1>
            </div>
          ) : (
            <div className="message-list">
              {s.messages.map((msg, mi) => (
                <MessageItem key={msg.id || mi} msg={msg} showHeader={msg.role !== 'assistant' || mi === 0 || s.messages[mi - 1]?.role !== 'assistant'} />
              ))}
              {s.running && <TypingIndicator />}
              <div ref={msgEndRef} />
            </div>
          )}
        </div>

        <InputArea onSend={sendMessage} running={s.running} onCancel={cancelAgent} onCompact={compactContext} compacting={s.compacting} onToast={toast} />
      </div>

      {s.permission && <PermissionDialog perm={s.permission} onRespond={respondPerm} />}
      <Toasts toasts={s.toasts} />
    </div>
  )
}
