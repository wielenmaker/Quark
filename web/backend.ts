import { materializeAgent, resolveAgent, listAgents, type AgentDef } from "../packages/quark/src/agent/agent"
import { loadConfig, parseModelSpec, resetConfigCache } from "../packages/quark/src/config/config"
import { loadAmbientInstructions } from "../packages/quark/src/ambient"
import { loadPlugins } from "../packages/quark/src/plugin-loader"
import { ensureStorageRoot } from "../packages/runner/src/storage/session-jsonl"
import type { AgentDefinition } from "../packages/runner/src/agent"
import { exportSessionToMarkdown } from "../packages/runner/src/commands/export"
import { undoLatest } from "../packages/runner/src/commands/undo"
import { dbToConversationMessages } from "../packages/runner/src/shared/conversation-view"
import { getLastInputTokens } from "../packages/runner/src/session/context"
import { bus, type BusEventName } from "../packages/runner/src/session/events"
import { loadMessages } from "../packages/runner/src/session/message"
import { cancel, isActive, prompt } from "../packages/runner/src/session/prompt"
import { compactBranch, createSteerBranch } from "../packages/runner/src/session/branch"
import { resolveModel } from "../packages/runner/src/provider/resolver"
import { clearCache as clearSkillCache, discoverSkills, loadSkill } from "../packages/runner/src/skill/skill"
import { createSession, getSession, listProjectSessions, type Session } from "../packages/runner/src/session/session"
import { respondQuestion } from "../packages/runner/src/tool/question"
import { getBranchFromPath } from "../packages/runner/src/worktree/worktree"
import { CatalogModelRuntime } from "../packages/quark/src/tui/catalog-model-runtime"
import { buildModelPickerOptions } from "../packages/quark/src/tui/model-picker"
import { thinkingCapabilityFromCatalog } from "../packages/runner/src/provider/catalog-runtime"

const streamEvents: BusEventName[] = [
  "user-message",
  "assistant-message-start",
  "text-start",
  "text-delta",
  "text-end",
  "tool-start",
  "tool-input",
  "tool-running",
  "tool-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "step-finish",
  "assistant-message-end",
  "user-message-status",
  "loop-start",
  "loop-end",
  "question-request",
  "retry",
  "error",
  "context-too-long",
  "session-title-changed",
  "session-switch",
  "subagent-tool-start",
  "subagent-tool-input",
  "subagent-tool-running",
  "subagent-tool-end",
  "subagent-step-finish",
  "subagent-text-delta",
  "subagent-done",
  "subagent-error",
]

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionView(session: Session) {
  return {
    id: session.id,
    title: session.title ?? "New session",
    directory: session.directory,
    pinned: session.pinned,
    timeUpdated: session.timeUpdated,
    running: isActive(session.id),
  }
}

function sessionData(sessionId: string) {
  const loaded = loadMessages(sessionId)
  const times = new Map(loaded.messages.map((message) => [message.id, message.timeCreated]))
  return {
    messages: dbToConversationMessages(loaded.messages, loaded.parts).map((message) => ({
      ...message,
      timeCreated: times.get(message.id),
    })),
    tokensUsed: getLastInputTokens(loaded.parts),
  }
}

export class WebBackend {
  private agent: AgentDefinition
  private agentDef: AgentDef
  private modelOverride: string | null = null
  private thinkingOverride: string | null = null
  private pendingSkillContext: string[] = []
  private activatedSkills = new Set<string>()

  private constructor(
    agentDef: AgentDef,
    agent: AgentDefinition,
    private readonly catalog: CatalogModelRuntime,
  ) {
    this.agentDef = agentDef
    this.agent = agent
  }

  static async create(): Promise<WebBackend> {
    const agentDef = resolveAgent()
    const agent = await materializeAgent(agentDef)
    ensureStorageRoot()
    await loadPlugins()
    const catalog = await CatalogModelRuntime.create()
    void catalog.refresh()
    return new WebBackend(agentDef, agent, catalog)
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request)
    } catch (error) {
      console.error("[web]", error)
      return json({ error: errorMessage(error) }, 500)
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const segments = url.pathname.split("/").filter(Boolean)

    if (request.method === "GET" && url.pathname === "/api/state") {
      return json(this.state(url.searchParams.get("sessionId")))
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      return json({ session: sessionView(createSession()) }, 201)
    }

    if (url.pathname.startsWith("/api/catalog") || url.pathname === "/api/models" ||
        url.pathname === "/api/thinking" ||
        url.pathname.startsWith("/api/profile") ||
        url.pathname.startsWith("/api/skill") || url.pathname === "/api/model" ||
        url.pathname === "/api/reload-config") {
      const control = await this.control(request, url.pathname)
      if (control) return control
    }

    if (segments[0] === "api" && segments[1] === "sessions" && segments[2]) {
      const sessionId = decodeURIComponent(segments[2])
      getSession(sessionId)

      if (request.method === "GET" && segments.length === 3) {
        return json({ session: sessionView(getSession(sessionId)), ...sessionData(sessionId) })
      }

      if (request.method === "GET" && segments[3] === "events") {
        return this.events(request, sessionId)
      }

      if (request.method === "POST" && segments[3] === "messages") {
        return this.send(request, sessionId)
      }

      if (request.method === "POST" && segments[3] === "cancel") {
        cancel(sessionId)
        return json({ cancelled: true })
      }

      if (request.method === "POST" && segments[3] === "undo") {
        const result = await undoLatest(sessionId)
        return json(result
          ? { undone: true, restored: result.restored, deleted: result.deleted }
          : { undone: false, restored: [], deleted: [] })
      }

      if (request.method === "POST" && segments[3] === "export") {
        return json(exportSessionToMarkdown(sessionId))
      }

      if (request.method === "POST" && segments[3] === "steer") {
        const body = await request.json() as { goal?: string }
        return this.branch("steer", sessionId, body.goal?.trim() ?? "")
      }

      if (request.method === "POST" && segments[3] === "compact") {
        const body = await request.json() as { goal?: string }
        return this.branch("compact", sessionId, body.goal?.trim() ?? "")
      }
    }

    if (request.method === "POST" && segments[0] === "api" && segments[1] === "questions" && segments[2]) {
      const body = await request.json() as { answers?: string[][]; rejected?: boolean }
      respondQuestion({ requestId: decodeURIComponent(segments[2]), ...body })
      return json({ answered: true })
    }

    return json({ error: "Not found" }, 404)
  }

  /** Model, profile, skill, and config control routes. Returns null when the path is not one of ours. */
  private async control(request: Request, pathname: string): Promise<Response | null> {
    if (pathname === "/api/catalog" && request.method === "GET") {
      return json({
        profiles: listAgents(),
        profile: this.agentDef.id,
        skills: discoverSkills().map((skill) => skill.name),
        activeSkills: this.activeSkills(),
      })
    }

    // Kept separate from /api/catalog: the model list is large, so the client
    // only fetches it when the model picker is actually opened. Reuses the
    // TUI picker so only authenticated providers contribute models.
    if (pathname === "/api/models" && request.method === "GET") {
      await this.catalog.active.refresh()
      return json({ models: buildModelPickerOptions(this.catalog.active, this.catalog.catalog) })
    }

    if (pathname === "/api/model" && request.method === "POST") {
      const body = await request.json() as { spec?: string }
      const spec = body.spec?.trim()
      if (!spec) return json({ error: "A model spec is required, e.g. provider/model" }, 400)
      const parsed = parseModelSpec(spec)
      if (parsed.provider && !this.catalog.catalog.getModel(parsed.provider, parsed.model)) {
        return json({ error: `Unknown model: ${spec}` }, 404)
      }
      this.modelOverride = spec
      return json({ status: this.status() })
    }

    if (pathname === "/api/thinking" && request.method === "POST") {
      const body = await request.json() as { effort?: string | null }
      // A null effort clears the override and falls back to the profile default.
      if (body.effort == null) {
        this.thinkingOverride = null
        return json({ status: this.status() })
      }
      const effort = body.effort.trim()
      const levels = this.thinkingLevels()
      if (!levels.includes(effort)) {
        return json({ error: `Unsupported thinking effort "${effort ?? ""}". Available: ${levels.join(", ")}` }, 400)
      }
      this.thinkingOverride = effort
      return json({ status: this.status() })
    }

    if (pathname === "/api/profiles" && request.method === "GET") {
      return json({ profiles: listAgents(), active: this.agentDef.id })
    }

    if (pathname === "/api/profile" && request.method === "POST") {
      const body = await request.json() as { name?: string }
      const name = body.name?.trim()
      if (!name) return json({ error: "A profile name is required" }, 400)
      if (!listAgents().includes(name)) {
        return json({ error: `Profile "${name}" not found. Available: ${listAgents().join(", ")}` }, 404)
      }
      await this.switchAgent(name)
      return json({ status: this.status() })
    }

    if (pathname === "/api/skills" && request.method === "GET") {
      return json({ skills: discoverSkills().map((skill) => skill.name), active: [...this.activatedSkills] })
    }

    if (pathname === "/api/skills" && request.method === "POST") {
      const body = await request.json() as { name?: string }
      const name = body.name?.trim()
      if (!name) return json({ error: "A skill name is required" }, 400)
      if (this.agentDef.skills.includes(name) || this.activatedSkills.has(name)) {
        return json({
          activated: false,
          reason: `Skill "${name}" is already available`,
          active: this.activeSkills(),
        })
      }
      const skill = loadSkill(name)
      if (!skill) return json({ error: `Skill "${name}" not found` }, 404)
      this.activatedSkills.add(name)
      this.pendingSkillContext.push(
        `[Activated skill]\n${skill.name}: ${skill.description || "No description provided."}\nUse the skill tool to load it when needed.`,
      )
      return json({ activated: true, active: this.activeSkills() })
    }

    if (pathname === "/api/reload-config" && request.method === "POST") {
      resetConfigCache()
      await this.applyAgent(this.agentDef.id)
      this.catalog.reloadProviders()
      void this.catalog.refresh()
      this.thinkingOverride = null
      return json({ reloaded: true, status: this.status() })
    }

    return null
  }

  /** Skills available to the next turn: profile-bound skills plus ones added this session. */
  private activeSkills(): string[] {
    return [...new Set([...this.agentDef.skills, ...this.activatedSkills])]
  }

  private modelName(): string {
    return this.modelOverride ?? this.agent.model ?? loadConfig().models.small
  }

  /** Catalog record for the effective model, when the catalog knows it. */
  private catalogModel() {
    const parsed = parseModelSpec(this.modelName())
    return parsed.provider ? this.catalog.catalog.getModel(parsed.provider, parsed.model) : null
  }

  /** Thinking levels the effective model accepts; always includes "none" first. */
  private thinkingLevels(): string[] {
    const model = this.catalogModel()
    return model ? thinkingCapabilityFromCatalog(model)?.levels ?? ["none"] : ["none"]
  }

  private thinkingEffort(): string {
    const levels = this.thinkingLevels()
    const candidate = this.thinkingOverride ?? this.agent.thinkingEffort ?? "none"
    return levels.includes(candidate) ? candidate : levels[0] ?? "none"
  }

  /** Agent bound to the effective model and thinking effort for the next turn. */
  private requestAgent() {
    return { ...this.agent, thinkingEffort: this.thinkingEffort() }
  }

  private status() {
    const modelName = this.modelName()
    const model = this.catalogModel()
    return {
      modelName,
      modelLabel: model?.name ?? modelName,
      thinkingEffort: this.thinkingEffort(),
      thinkingLevels: this.thinkingLevels(),
      tokenLimit: model?.limit.context ?? model?.limit.input ?? 0,
      cwd: process.cwd(),
      branch: getBranchFromPath(process.cwd()),
      profile: this.agentDef.id,
    }
  }

  /** Rebuilds the agent from a manifest and reloads its tools and skills. */
  private async applyAgent(agentId: string): Promise<void> {
    clearSkillCache()
    this.agentDef = resolveAgent(agentId)
    this.agent = await materializeAgent(this.agentDef)
    this.pendingSkillContext = []
    this.activatedSkills.clear()
  }

  private async switchAgent(name: string): Promise<void> {
    await this.applyAgent(name)
    this.modelOverride = null
    this.thinkingOverride = null
  }

  private async branch(kind: "steer" | "compact", sessionId: string, goal: string): Promise<Response> {
    const { messages, parts } = loadMessages(sessionId)
    const result = kind === "steer"
      ? createSteerBranch({
          sessionId,
          prompt: goal || undefined,
          profile: this.agentDef.id,
          messages,
          parts,
        })
      : await compactBranch({
          sessionId,
          messages,
          parts,
          model: await resolveModel(loadConfig().models.small, "small", { catalog: this.catalog.catalog }),
          profile: this.agentDef.id,
          prompt: goal || undefined,
        })

    if (goal) {
      void prompt({
        sessionId: result.sessionId,
        parentSessionId: sessionId,
        parts: [{ type: "text", text: goal }],
        model: this.modelOverride ?? undefined,
        agent: this.requestAgent(),
        ambientInstructions: loadAmbientInstructions,
        catalog: this.catalog.catalog,
      }).catch((error) => bus.emit("error", { sessionId: result.sessionId, error }))
    }

    return json({ sessionId: result.sessionId, kind, status: this.status() })
  }

  private state(requestedId: string | null) {
    const sessions = listProjectSessions()
    let session: Session | null = null
    if (requestedId) {
      try {
        session = getSession(requestedId)
      } catch {}
    }
    session ??= sessions[0] ?? null

    const data = session ? sessionData(session.id) : { messages: [], tokensUsed: 0 }
    return {
      session: session ? sessionView(session) : null,
      sessions: sessions.map(sessionView),
      ...data,
      status: this.status(),
    }
  }

  private async send(request: Request, sessionId: string): Promise<Response> {
    if (isActive(sessionId)) return json({ error: "This session is already running" }, 409)
    const body = await request.json() as { text?: string }
    const text = body.text?.trim()
    if (!text) return json({ error: "Message text is required" }, 400)

    const skillContext = this.pendingSkillContext.join("\n")
    this.pendingSkillContext = []

    void prompt({
      sessionId,
      parts: [{ type: "text", text }],
      ...(skillContext ? { modelOnlyText: skillContext } : {}),
      model: this.modelOverride ?? undefined,
      agent: this.requestAgent(),
      ambientInstructions: loadAmbientInstructions,
      catalog: this.catalog.catalog,
    }).catch((error) => bus.emit("error", { sessionId, error }))

    return json({ sessionId }, 202)
  }

  private events(request: Request, sessionId: string): Response {
    const encoder = new TextEncoder()
    const listeners: Array<{ event: BusEventName; handler: (data: any) => void }> = []
    let heartbeat: ReturnType<typeof setInterval>

    const body = new ReadableStream({
      start: (controller) => {
        const write = (type: string, data: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`))
        }
        const cleanup = () => {
          clearInterval(heartbeat)
          for (const { event, handler } of listeners) bus.off(event as any, handler)
          try { controller.close() } catch {}
        }

        for (const event of streamEvents) {
          const handler = (data: any) => {
            const isSessionSwitch = event === "session-switch"
            if (!isSessionSwitch && data?.sessionId && data.sessionId !== sessionId) return
            if (data?.error) data = { ...data, error: errorMessage(data.error) }
            write(event, data)
          }
          listeners.push({ event, handler })
          bus.on(event as any, handler)
        }

        heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000)
        request.signal.addEventListener("abort", cleanup, { once: true })
        write("connected", { sessionId })
      },
      cancel: () => {
        clearInterval(heartbeat)
        for (const { event, handler } of listeners) bus.off(event as any, handler)
      },
    })

    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      },
    })
  }
}
