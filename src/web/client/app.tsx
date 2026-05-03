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
  const sessionIdRef = useRef<string | null>(null)
  const handleEventRef = useRef<(event: string, d: any) => void>(() => {})
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const set = useCallback((p: Partial<AppState>) => dispatch({ type: 'SET', payload: p }), [])

  // --- rAF-throttled delta buffer ---
  // iOS Safari coalesces/skips paints when rapid WebSocket onmessage events
  // each trigger a React state update. We accumulate high-frequency deltas
  // (text-delta, reasoning-delta, subagent-text-delta) and flush once per
  // animation frame so the browser gets time to paint between updates.
  const deltaBuffer = useRef<Map<string, Action>>(new Map())
  const rafHandle = useRef<number>(0)

  const flushDeltas = useCallback(() => {
    rafHandle.current = 0
    const buf = deltaBuffer.current
    if (buf.size === 0) return
    // Dispatch all buffered actions in one batch
    for (const action of buf.values()) dispatch(action)
    buf.clear()
  }, [])

  const scheduleFlush = useCallback(() => {
    if (!rafHandle.current) {
      rafHandle.current = requestAnimationFrame(flushDeltas)
    }
  }, [flushDeltas])

  // Cleanup rAF on unmount
  useEffect(() => () => { if (rafHandle.current) cancelAnimationFrame(rafHandle.current) }, [])

  const toast = useCallback((title: string, body: string, kind?: 'error' | 'warn', opts?: { id?: number; persistent?: boolean }) => {
    const id = opts?.id ?? Date.now()
    dispatch({ type: 'ADD_TOAST', id, title, body, kind })
    if (!opts?.persistent) setTimeout(() => dispatch({ type: 'REMOVE_TOAST', id }), 5000)
    return id
  }, [])

  // Keep sessionId ref in sync for WS reconnect closure
  sessionIdRef.current = s.sessionId

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
    // Load persisted messages and check if the session is still running
    Promise.all([
      api('GET', `/api/sessions/${saved}/messages`),
      api<{ running: boolean }>('GET', `/api/sessions/${saved}/status`),
    ])
      .then(([msgs, status]: [any, { running: boolean }]) => {
        dispatch({ type: 'LOAD_MESSAGES', messages: msgs })
        if (status.running) set({ running: true })
      })
      .catch(() => localStorage.removeItem(SESSION_KEY))
  }, [])

  // Restore thinking toggle from localStorage on mount, then sync with server
  useEffect(() => {
    const saved = localStorage.getItem('quark-thinking')
    if (saved === 'true') set({ showThinking: true })
    api<{ enabled: boolean }>('GET', '/api/thinking')
      .then(r => {
        set({ showThinking: r.enabled })
        localStorage.setItem('quark-thinking', JSON.stringify(r.enabled))
      })
      .catch(() => {})
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
      // CRITICAL (WebKit bug 228296): Never close a CONNECTING socket on iOS Safari.
      // NSURLSession WebSocket corrupts its internal state when a CONNECTING socket is
      // closed, making ALL future WS connections fail until Safari is restarted.
      if (ws && ws.readyState === WebSocket.CONNECTING) return
      if (ws) {
        ws.onopen = null
        ws.onclose = null
        ws.onerror = null
        ws.onmessage = null
        if (ws.readyState === WebSocket.OPEN) ws.close()
      }

      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws

      // Capture per-socket references to prevent cross-socket races.
      // If connect() is called again before this socket opens, the shared `ws`
      // variable will be reassigned, so all closures below compare against thisWs.
      const thisWs = ws
      let thisPing: ReturnType<typeof setInterval> | null = null

      // Give the connection 10s to open before giving up and retrying.
      // Do NOT call ws.close() on timeout — that triggers the NSURLSession bug.
      // Orphan the stale socket and create a new one instead.
      const connectTimeout = setTimeout(() => {
        if (thisWs.readyState === WebSocket.CONNECTING) {
          thisWs.onopen = null
          thisWs.onclose = null
          thisWs.onerror = null
          thisWs.onmessage = null
          if (thisPing) clearInterval(thisPing)
          // Only clear shared ref if it still points to this socket
          if (ws === thisWs) { ws = null; wsRef.current = null }
          if (!cancelled) {
            reconnectTimer = setTimeout(connect, reconnectDelay.current)
            reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000)
          }
        }
      }, 10000)

      thisWs.onopen = () => {
        clearTimeout(connectTimeout)
        if (cancelled) return
        reconnectDelay.current = 1000
        set({ connected: true })
        const sid = sessionIdRef.current
        if (sid) {
          Promise.all([
            api('GET', `/api/sessions/${sid}/messages`),
            api<{ running: boolean }>('GET', `/api/sessions/${sid}/status`),
          ]).then(([msgs, status]: [any, { running: boolean }]) => {
            dispatch({ type: 'LOAD_MESSAGES', messages: msgs })
            set({ running: status.running })
          }).catch(() => {})
        }
      }
      thisWs.onclose = () => {
        clearTimeout(connectTimeout)
        if (cancelled) return
        set({ connected: false })
        const delay = reconnectDelay.current
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(connect, delay)
        reconnectDelay.current = Math.min(delay * 2, 30000)
      }
      thisWs.onerror = () => {}
      thisWs.onmessage = (e) => {
        try {
          const { event, data } = JSON.parse(e.data)
          handleEventRef.current(event, data)
        } catch {}
      }

      thisPing = setInterval(() => { if (thisWs.readyState === WebSocket.OPEN) thisWs.send(JSON.stringify({ type: 'ping' })) }, 15000)
      thisWs.addEventListener('close', () => { if (thisPing) clearInterval(thisPing) })
    }
    connect()

    // Apple Safari on iOS only — exclude Chrome/Firefox/Edge on iOS (CriOS/FxiOS/EdgiOS)
    const isIosSafari = /iP(hone|ad|od)/.test(navigator.userAgent)
      && /WebKit/.test(navigator.userAgent)
      && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent)
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        if (isIosSafari && ws) {
          ws.onopen = null
          ws.onclose = null
          ws.onerror = null
          ws.onmessage = null
          if (ws.readyState === WebSocket.OPEN) ws.close()
          ws = null
          wsRef.current = null
        }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
        reconnectDelay.current = 1000
      } else if (document.visibilityState === 'visible') {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          reconnectDelay.current = 1000
          connect()
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // iOS bfcache restore: page was served from cache, WS is dead
    function onPageShow(ev: PageTransitionEvent) {
      if (ev.persisted && (!ws || ws.readyState !== WebSocket.OPEN)) {
        reconnectDelay.current = 1000
        connect()
      }
    }
    window.addEventListener('pageshow', onPageShow)

    return () => {
      cancelled = true
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      if (ws) {
        ws.onopen = null
        ws.onclose = null
        ws.onerror = null
        ws.onmessage = null
        ws.close()
      }
    }
  }, [])

  // Event handler — keep ref up-to-date so the WS onmessage closure (set up
  // once on mount) always calls the latest version with fresh state/callbacks.
  function handleEvent(event: string, d: any) {
    switch (event) {
      case 'session-created':
        set({ sessionId: d.sessionId })
        refreshSessions()
        break
      case 'user-message':
        // Reconcile with the optimistic message added in sendMessage().
        // The WS event can arrive before React commits the ADD_USER_MSG
        // dispatch, so UPDATE_MSG may silently no-op.  To fix this we:
        //   1. Record the mapping from optimistic ID → real server ID
        //   2. Let the reducer handle both cases (rename if found, add if not)
        if (pendingOptMsgRef.current) {
          const optId = pendingOptMsgRef.current
          pendingOptMsgRef.current = null
          dispatch({ type: 'RECONCILE_USER_MSG', optimisticId: optId, realId: d.messageId, text: d.text })
        } else {
          dispatch({ type: 'ADD_USER_MSG', id: d.messageId, text: d.text })
        }
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
      case 'text-delta': {
        // Buffer text-delta updates and flush once per animation frame
        // to prevent iOS Safari from coalescing/skipping paints
        const key = `td:${d.messageId}:${d.partId}`
        deltaBuffer.current.set(key, { type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'text' && (p as any).partId === d.partId ? { ...p, text: d.text, streaming: true } : p) }) })
        scheduleFlush()
        break
      }
      case 'text-end':
        // Flush any pending buffered delta for this part before applying final text
        deltaBuffer.current.delete(`td:${d.messageId}:${d.partId}`)
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'text' && (p as any).partId === d.partId ? { ...p, text: d.text, streaming: false } : p) }) })
        break
      case 'tool-start':
        dispatch({ type: 'ENSURE_ASSISTANT', id: d.messageId })
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: [...m.parts, { type: 'tool' as const, tool: d.tool, callId: d.callId, status: 'running' as const, input: null, output: null, error: null }] }) })
        break
      case 'tool-input-delta':
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'tool' && p.callId === d.callId ? { ...p, inputPreview: d.delta } : p) }) })
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
      case 'reasoning-delta': {
        const key = `rd:${d.messageId}:${d.partId}`
        deltaBuffer.current.set(key, { type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'thinking' && (p as any).partId === d.partId ? { ...p, text: d.text } : p) }) })
        scheduleFlush()
        break
      }
      case 'reasoning-end':
        deltaBuffer.current.delete(`rd:${d.messageId}:${d.partId}`)
        dispatch({ type: 'UPDATE_MSG', id: d.messageId, updater: m => ({ ...m, parts: m.parts.map(p => p.type === 'thinking' && (p as any).partId === d.partId ? { ...p, done: true } : p) }) })
        break
      case 'step-finish':
        if (d.data?.tokens?.input) {
          set({ tokensUsed: d.data.tokens.input })
          // Auto-compact when usage hits the limit
          if (s.tokenLimit > 0 && d.data.tokens.input >= s.tokenLimit && !s.compacting) {
            toast('Context Full', 'Context window full — compacting automatically…', 'warn')
            compactContext()
          }
        }
        break
      case 'loop-start': set({ running: true }); break
      case 'loop-end': {
        set({ running: false })
        // Reconcile: fetch full message history to recover any events lost
        // during WebSocket disconnect/reconnect gaps (e.g. new session creation)
        const sid = d.sessionId || s.sessionId
        if (sid) {
          api('GET', `/api/sessions/${sid}/messages`)
            .then((msgs: any) => dispatch({ type: 'LOAD_MESSAGES', messages: msgs }))
            .catch(() => {})
        }
        break
      }
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
        break
      case 'compaction-end': {
        set({ compacting: false })
        dispatch({ type: 'REMOVE_TOAST', id: COMPACTION_TOAST_ID })
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
      case 'subagent-text-delta': {
        const key = `satd:${d.messageId}:${d.parentCallId}`
        deltaBuffer.current.set(key, { type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          const text = d.text
          sa.textPreview = text.length > 120 ? '…' + text.slice(-119) : text
        }, profile: d.profile })
        scheduleFlush()
        break
      }
      case 'subagent-done':
        deltaBuffer.current.delete(`satd:${d.messageId}:${d.parentCallId}`)
        dispatch({ type: 'SUBAGENT_EVENT', messageId: d.messageId, parentCallId: d.parentCallId, updater: (sa) => {
          sa.done = true
          sa.textPreview = undefined
        }, profile: d.profile })
        break
    }
  }
  handleEventRef.current = handleEvent

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
    try { const c = await api('GET', '/api/config'); set({ tokenLimit: c.contextWindow || 0 }) } catch {}
  }

  // Initial health check — set connected immediately if server responds
  // (avoids red flash while WS handshake is in flight)
  useEffect(() => {
    api('GET', '/api/health').then(() => set({ connected: true })).catch(() => {})
  }, [])

  useEffect(() => { refreshSessions(); loadModels(); loadAppConfig() }, [])

  // Actions
  const pendingOptMsgRef = useRef<string | null>(null)

  async function sendMessage(text: string, images: { mime: string; data: string }[] = []) {
    if (!text.trim() && images.length === 0 || s.running) return

    const body: any = { text: text.trim() }
    if (s.sessionId) body.sessionId = s.sessionId
    if (images.length > 0) body.images = images.map(({ mime, data }) => ({ mime, data }))

    // Optimistic: show user message immediately (before server round-trip)
    const optimisticId = '_opt_' + Date.now()
    pendingOptMsgRef.current = optimisticId
    dispatch({ type: 'ADD_USER_MSG', id: optimisticId, text: text.trim(), images: images.length > 0 ? images : undefined })
    set({ running: true })

    let sid = s.sessionId
    try {
      const r = await api('POST', '/api/prompt', body)
      if (r.sessionId) { sid = r.sessionId; set({ sessionId: r.sessionId }) }
    } catch (e: any) {
      toast('Error', 'Failed to send', 'error'); set({ running: false }); return
    }

    // iOS Safari fallback: if WS is not connected, poll for completion.
    // The WS may take 20-30s to stabilize on iOS, so events are lost.
    // Poll every 2s until the agent finishes, then reconcile messages.
    if (sid && (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)) {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      let polling = false
      pollTimerRef.current = setInterval(async () => {
        if (polling) return
        polling = true
        try {
          const [status, msgs] = await Promise.all([
            api<{ running: boolean }>('GET', `/api/sessions/${sid}/status`),
            api('GET', `/api/sessions/${sid}/messages`),
          ])
          dispatch({ type: 'LOAD_MESSAGES', messages: msgs })
          if (!status.running) {
            clearInterval(pollTimerRef.current!)
            pollTimerRef.current = null
            set({ running: false })
          }
        } catch {} finally {
          polling = false
        }
      }, 2000)
    }
  }

  async function cancelAgent() {
    if (!s.sessionId) return
    try {
      await api('POST', '/api/cancel', { sessionId: s.sessionId })
      set({ running: false })
    } catch {}
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

  async function toggleThinking() {
    const next = !s.showThinking
    set({ showThinking: next })
    localStorage.setItem('quark-thinking', JSON.stringify(next))
    try {
      await api('POST', '/api/thinking', { enabled: next })
    } catch { toast('Error', 'Failed to toggle thinking', 'error') }
  }

  async function compactContext() {
    if (!s.sessionId) {
      toast('Nothing to compact', 'No active session', 'warn')
      return
    }
    try {
      set({ compacting: true })
      toast('Compacting', 'Compacting context…', 'warn', { id: COMPACTION_TOAST_ID, persistent: true })
      const r = await api<{
        ok?: boolean
        error?: string
        result?: { type: string; evictedCount?: number; newSessionId?: string; estimatedTokens?: number }
      }>('POST', '/api/compact', { sessionId: s.sessionId })
      set({ compacting: false })
      dispatch({ type: 'REMOVE_TOAST', id: COMPACTION_TOAST_ID })
      if (!r.ok || r.error) {
        toast('Compaction failed', r.error || 'An error occurred during compaction', 'error')
      } else if (!r.result || r.result.evictedCount === 0) {
        toast('Nothing to compact', 'Not enough turns to compact — keep chatting', 'warn')
      } else {
        toast('Compacted', `Evicted ${r.result.evictedCount} messages`, 'warn')
        if (r.result.newSessionId && r.result.newSessionId !== s.sessionId) {
          set({ sessionId: r.result.newSessionId })
          if (r.result.estimatedTokens) set({ tokensUsed: r.result.estimatedTokens })
          // Reload messages for the new session
          try {
            const msgs = await api('GET', `/api/sessions/${r.result.newSessionId}/messages`)
            if (Array.isArray(msgs)) dispatch({ type: 'LOAD_MESSAGES', messages: msgs })
          } catch {}
          refreshSessions()
        }
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
        <Header state={s} dispatch={dispatch} onCancel={cancelAgent} onSwitchModel={switchModel} onToggleThinking={toggleThinking} />
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
                <MessageItem key={msg.id || mi} msg={msg} showHeader={msg.role !== 'assistant' || mi === 0 || s.messages[mi - 1]?.role !== 'assistant'} showThinking={s.showThinking} />
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
