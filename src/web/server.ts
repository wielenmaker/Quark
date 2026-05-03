import { bootstrap } from "../bootstrap"
import { prompt, cancel, isActive } from "../session/prompt"
import { bus, type BusEventName } from "../session/events"
import { createSession, listSessions, getSession } from "../session/session"
import { loadMessages, createAssistantMessage, addPart, finishMessage, saveUserMessage, toModelMessages } from "../session/message"
import { dbToTuiMessages } from "../tui/state"
import { resolveProfile, readPromptFile, listProfiles } from "../profile/profile"
import { agentFromProfile } from "../agent"
import type { AgentConfig } from "../agent"
import { buildSystem } from "../session/system"
import { loadConfig, parseModelSpec } from "../config/config"
import { respond as respondPermission } from "../permission/permission"
import type { Reply } from "../permission/permission"
import { getFiles, fuzzyFilter } from "../tui/filelist"
import { resolve as resolveCompaction } from "../session/compact-resolver"
import { resolveModel } from "../session/prompt"
import { getModelLimit } from "../provider/models"
import { getThinkingNormalizer } from "../provider/thinking"
import type { ServerWebSocket } from "bun"

const ALL_EVENTS: BusEventName[] = [
  "text-start", "text-delta", "text-end",
  "tool-start", "tool-input-delta", "tool-input", "tool-end",
  "step-start", "step-finish",
  "assistant-message-start", "assistant-message-end",
  "loop-start", "loop-end",
  "error", "session-created", "session-reset", "session-switch",
  "permission-request",
  "compaction-start", "compaction-end",
  "retry",
  "reasoning-start", "reasoning-delta", "reasoning-end",
  "user-message",
  "subagent-tool-start", "subagent-tool-input", "subagent-tool-end",
  "subagent-step-finish", "subagent-text-delta", "subagent-done",
]

type WSData = { handlers: Map<BusEventName, (data: unknown) => void> }

function cors(headers?: Record<string, string>): Headers {
  const h = new Headers(headers)
  h.set("Access-Control-Allow-Origin", "*")
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  h.set("Access-Control-Allow-Headers", "Content-Type")
  return h
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors({ "Content-Type": "application/json" }),
  })
}

function notFound(): Response {
  return json({ error: "Not found" }, 404)
}

function createRequestHandler(agent: AgentConfig) {
  // Runtime model override — not persisted, same as TUI /model command
  let modelOverride: string | null = null

  function getModelOpt() {
    if (!modelOverride) return undefined
    return modelOverride
  }

  return async function handleRequest(
    req: Request,
    server: { upgrade(req: Request, opts?: unknown): boolean },
  ): Promise<Response> {
    const url = new URL(req.url)
    const { pathname } = url

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() })
    }

    // --- REST API ---

    if (req.method === "GET" && pathname === "/api/health") {
      return json({ ok: true })
    }

    if (req.method === "GET" && pathname === "/api/sessions") {
      return json(listSessions())
    }

    if (req.method === "GET" && pathname.startsWith("/api/sessions/") && pathname.endsWith("/messages")) {
      const id = pathname.slice("/api/sessions/".length, -"/messages".length)
      try {
        getSession(id)
      } catch {
        return json({ error: "Session not found" }, 404)
      }
      const { messages, parts } = loadMessages(id)
      return json(dbToTuiMessages(messages, parts))
    }

    if (req.method === "GET" && pathname.startsWith("/api/sessions/") && pathname.endsWith("/status")) {
      const id = pathname.slice("/api/sessions/".length, -"/status".length)
      return json({ running: isActive(id) })
    }

    if (req.method === "POST" && pathname === "/api/sessions") {
      const session = createSession()
      return json({ sessionId: session.id })
    }

    if (req.method === "POST" && pathname === "/api/prompt") {
      const body = (await req.json()) as {
        sessionId?: string
        text: string
        images?: { mime: string; data: string }[]
      }

      if (body.sessionId) {
        prompt({
          sessionId: body.sessionId,
          parts: [{ type: "text", text: body.text }],
          images: body.images,
          model: getModelOpt(),
          agent,
        }).catch(() => {})
        return json({ sessionId: body.sessionId })
      }

      const sessionId = await new Promise<string>((resolve) => {
        bus.once("session-created", ({ sessionId }) => resolve(sessionId))
        prompt({
          parts: [{ type: "text", text: body.text }],
          images: body.images,
          model: getModelOpt(),
          agent,
        }).catch(() => {})
      })
      return json({ sessionId })
    }

    if (req.method === "POST" && pathname === "/api/cancel") {
      const body = (await req.json()) as { sessionId: string }
      cancel(body.sessionId)
      return json({ ok: true })
    }

    if (req.method === "POST" && pathname === "/api/compact") {
      const body = (await req.json()) as { sessionId: string }
      const { sessionId } = body
      try {
        getSession(sessionId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[compact] getSession failed:", msg, "sessionId:", sessionId)
        return json({ error: msg }, 404)
      }

      let messages, parts, modelMessages, budget, model, system
      try {
        const loaded = loadMessages(sessionId)
        messages = loaded.messages
        parts = loaded.parts
        modelMessages = toModelMessages(messages, parts)
        const modelId = modelOverride ?? loadConfig().main_model
        budget = getModelLimit(modelId)
        model = await resolveModel(modelId)
        system = buildSystem(agent)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return json({ error: msg }, 500)
      }

      console.log("[compact] starting compaction for session:", sessionId)
      console.log("[compact] messages:", messages.length, "parts:", parts.length, "modelMessages:", modelMessages.length)
      console.log("[compact] budget:", JSON.stringify(budget))
      bus.emit("compaction-start", { sessionId })
      try {
        const result = await resolveCompaction({
          trigger: "command",
          ctx: {
            sessionId,
            messages,
            parts,
            modelMessages,
            model,
            agentPrompt: system,
            budget,
            persist: { createMessage: createAssistantMessage, addPart, finishMessage, saveUserMessage },
            session: { create: createSession },
          },
        })
        console.log("[compact] compaction resolved:", JSON.stringify(result))
        bus.emit("compaction-end", { sessionId, result })

        let newSessionId: string | undefined
        let switchMessages: ReturnType<typeof dbToTuiMessages> | undefined
        let estimatedTokens: number | undefined

        if (result.type === "new-session" && result.newSessionId !== sessionId) {
          const { messages: newMsgs, parts: newParts } = loadMessages(result.newSessionId)
          const newModelMsgs = toModelMessages(newMsgs, newParts)
          const sysStr = Array.isArray(system) ? system.join("\n") : system
          const { estimateTokens } = await import("../session/compaction")
          newSessionId = result.newSessionId
          switchMessages = dbToTuiMessages(newMsgs, newParts)
          estimatedTokens = estimateTokens(sysStr, newModelMsgs)
          bus.emit("session-switch", {
            sessionId: result.newSessionId,
            messages: switchMessages,
            estimatedTokens,
          })
        }

        return json({
          ok: true,
          result: {
            type: result.type,
            evictedCount: "evictedCount" in result ? result.evictedCount : 0,
            summary: "summary" in result ? result.summary : undefined,
            newSessionId,
            estimatedTokens,
          },
        })
      } catch (err) {
        console.error("[compact] compaction FAILED:", err instanceof Error ? err.stack : String(err))
        bus.emit("compaction-end", { sessionId, result: null })
        bus.emit("error", { sessionId, error: err instanceof Error ? err.message : String(err) })
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
      }
    }

    if (req.method === "POST" && pathname === "/api/model") {
      const body = (await req.json()) as { model: string | null }
      const mainModel = loadConfig().main_model
      // Clear the override when the user picks the main model so config default is used
      modelOverride = (body.model && body.model !== mainModel) ? body.model : null
      return json({ model: modelOverride ?? mainModel })
    }

    if (req.method === "GET" && pathname === "/api/model") {
      return json({ model: modelOverride ?? loadConfig().main_model })
    }

    if (req.method === "POST" && pathname === "/api/thinking") {
      const body = (await req.json()) as { enabled: boolean }
      const effort = body.enabled ? "high" : "none"
      const activeModel = parseModelSpec(modelOverride ?? loadConfig().main_model).model
      getThinkingNormalizer(activeModel).configure({ enabled: body.enabled, effort })
      return json({ enabled: body.enabled })
    }

    if (req.method === "GET" && pathname === "/api/thinking") {
      return json({ enabled: getThinkingNormalizer().getConfig().enabled })
    }

    if (req.method === "POST" && pathname === "/api/permission") {
      const body = (await req.json()) as {
        sessionId: string
        requestId: string
        action: Reply
        correction?: string
      }
      respondPermission({
        requestId: body.requestId,
        reply: body.action,
        message: body.correction,
      })
      return json({ ok: true })
    }

    if (req.method === "GET" && pathname === "/api/profiles") {
      const ids = listProfiles()
      const profiles = ids.map((id) => {
        const def = resolveProfile(id)
        const { name, description } = readPromptFile(def)
        return { id, name: name ?? def.name, description, tools: def.tools, skills: def.skills }
      })
      return json(profiles)
    }

    if (req.method === "GET" && pathname === "/api/models") {
      const config = loadConfig()
      return json({ models: config.models, mainModel: config.main_model })
    }

    if (req.method === "GET" && pathname === "/api/config") {
      const config = loadConfig()
      const lim = getModelLimit(config.main_model)
      return json({
        mainModel: config.main_model,
        contextWindow: lim?.context ?? lim?.input ?? 0,
        maxSteps: config.max_steps,
      })
    }

    if (req.method === "GET" && pathname === "/api/files") {
      const q = url.searchParams.get("q") ?? ""
      const files = await getFiles()
      const filtered = fuzzyFilter(files, q, 20)
      return json(filtered)
    }

    // --- Static files ---

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const file = Bun.file(new URL("public/index.html", import.meta.url).pathname)
      if (await file.exists()) {
        const headers = cors({ "Content-Type": "text/html" })
        // Prevent bfcache on iOS Safari — bfcache kills WebSocket connections
        // with code 1001 ("Going Away") and does not restore them on pageshow
        headers.set("Cache-Control", "no-store")
        return new Response(file, { headers })
      }
      return new Response("Frontend not found", { status: 404, headers: cors() })
    }

    if (req.method === "GET" && pathname.startsWith("/public/")) {
      const file = Bun.file(new URL(pathname.slice(1), import.meta.url).pathname)
      if (await file.exists()) {
        const ext = pathname.split(".").pop()
        const contentType: Record<string, string> = {
          js: "application/javascript",
          css: "text/css",
          map: "application/json",
        }
        const ct = ext ? contentType[ext] : undefined
        const headers = cors(ct ? { "Content-Type": ct } : undefined)
        return new Response(file, { headers })
      }
    }

    return notFound()
  }
}

export async function startWebServer() {
  const profile = resolveProfile()
  const { content } = readPromptFile(profile)
  const agent = agentFromProfile(profile, content)

  await bootstrap({ profileTools: profile.tools, boundSkills: profile.skills })

  const port = Number(process.env.QUARK_WEB_PORT) || 3000
  const handleRequest = createRequestHandler(agent)

  // Register a default error handler so bus.emit("error") never crashes the
  // process when no WebSocket client is connected.
  bus.on("error", ({ sessionId, error }) => {
    console.error(`[web] bus error (session ${sessionId}):`, error)
  })

  const server = Bun.serve<WSData>({
    port,
    hostname: "0.0.0.0",
    fetch(req, server) {
      // WebSocket upgrade MUST be synchronous — cannot be behind async
      const url = new URL(req.url)
      if (url.pathname === "/ws") {
        console.log("[ws] upgrade request received")
        const upgraded = server.upgrade(req, { data: { handlers: new Map() } as WSData })
        console.log("[ws] upgrade result:", upgraded)
        if (upgraded) return undefined as unknown as Response
        return json({ error: "WebSocket upgrade failed" }, 400)
      }
      return handleRequest(req, server)
    },
    websocket: {
      // Disable per-message compression — Safari has known issues with it
      perMessageDeflate: false,
      // Keep connection alive — iOS Safari aggressively kills idle WS connections
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        console.log("[ws] client connected")
        const handlers = (ws.data as WSData).handlers
        for (const event of ALL_EVENTS) {
          const handler = (data: unknown) => {
            try {
              ws.send(JSON.stringify({ event, data }))
            } catch {}
          }
          handlers.set(event, handler)
          bus.on(event, handler as any)
        }
      },
      message(ws, raw) {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ event: "pong" }))
          }
        } catch {}
      },
      close(ws, code, reason) {
        console.log(`[ws] client disconnected (code=${code}, reason=${reason})`)
        const handlers = (ws.data as WSData).handlers
        for (const [event, handler] of handlers) {
          bus.off(event, handler as any)
        }
        handlers.clear()
      },
    },
  })

  console.log(`Quark web server listening on http://0.0.0.0:${server.port}`)
  return server
}
