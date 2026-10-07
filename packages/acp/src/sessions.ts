// ACP session registry + runner bridge (QUA-248).
//
// Maps ACP session IDs to isolated @quark/runner runners:
//
//   session/new   -> allocate an ACP session ID, connect any stdio MCP servers,
//                    record cwd, create no runner yet
//   session/prompt-> lazily create that session's runner (seeded with the MCP
//                    tools discovered above), translate blocks, run one turn,
//                    remember the runner-created session ID
//
// ACP IDs and persisted IDs converge: `session/new` mints an ACP id that
// becomes the persisted session id on the first prompt (see
// SessionState.runnerSessionId), so the id the client stores as its thread id
// is the one `session/load`/`session/resume` finds after a restart. Adopted
// sessions arrive with the two already equal.
//
// MCP (QUA-245): ACP v1 requires stdio MCP servers to be accepted. Nonempty
// `mcpServers` is validated (stdio only, absolute command) and the servers are
// spawned and hand-shaken on `session/new`; a failure refuses the session
// rather than handing back a session whose declared tools are missing. The
// discovered tools are injected into the runner via `createRunner(cwd, tools)`
// and the connections are killed on `close`/`dispose`/`delete`. HTTP/SSE/ACP
// transports are refused.
//
// Images (QUA-245): when the composition root enables `images`, `image` prompt
// blocks map to `RunnerPromptInput.images`; otherwise they are refused as
// unsupported. Audio/embedded-resource blocks stay unsupported either way.
//
// Persistent lifecycle (QUA-247) attaches to ALREADY-PERSISTED runner sessions:
// `adopt` seeds the ACP→runner mapping with a store session ID so the next
// prompt resumes that history (no replay), `close` cancels and forgets an
// attachment, and `isActive` lets `session/delete` refuse to remove history a
// live turn is still writing. The store supports every runner; it is owned by
// the composition root and threaded here, where this module reads it to
// resolve/create the persisted record behind a new ACP session.

import { methods, RequestError } from "@agentclientprotocol/sdk"
import type {
  AgentApp,
  AgentContext,
  ContentBlock,
  ImageContent,
  McpServerStdio,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResourceLink,
  SessionConfigOption,
} from "@agentclientprotocol/sdk"
import { isAbsolute } from "node:path"
import { createSession, type BusEvents, type Runner, type SessionStore, type ToolDef } from "@quark/runner"
import { connectStdioServers, requireStdio, type McpConnection } from "./mcp"

/** One ACP session's registry entry. */
interface SessionState {
  acpSessionId: string
  /** Absolute workspace requested by the client; used as targetWorkspace. */
  cwd: string
  /** Created lazily on first prompt — a session/new must stay cheap. */
  runner: Runner | null
  /**
   * Persisted session id. Null until the first prompt, which persists
   * `acpSessionId` and adopts it here (the two then stay equal). Adopted
   * sessions enter with the store id already set.
   */
  runnerSessionId: string | null
  /** One active turn per session. */
  active: boolean
  /** Set when `cancel()` hit an active turn, so prompt() reports "cancelled". */
  cancelled: boolean
  /**
   * Latest client context (from a `session/prompt` call), for notifications
   * that can land outside a turn: the generated title arrives asynchronously
   * after the first message, possibly after that turn ended.
   */
  client: AgentContext | null
  /**
   * The active turn's abort controller, owned by `prompt()`. `cancel()`,
   * `close()` and `dispose()` abort it so provider streaming, tool execution,
   * a pending permission dialog, and MCP calls all stop together.
   */
  turnController: AbortController | null
  /** Removes the runner bus listener created with the runner. */
  unsubscribe: (() => void) | null
  /** Live stdio MCP servers for this session; killed on close/dispose. */
  mcp: McpConnection[]
  /** Tools discovered from `mcp`; injected into the lazy runner. */
  mcpTools: ToolDef[]
  /** Per-session model override; null means use the agent's default. */
  modelOverride: string | null
  /** Per-session thinking-effort override; null means use the agent's default. */
  effortOverride: string | null
  /**
   * Per-session profile (agent manifest) override; null means the connection
   * default. Changing it drops the cached runner, so the next prompt builds one
   * for the new profile on the same persisted history.
   */
  profileOverride: string | null
}

/** Context handed to `onTurnStart`, once per turn, before the runner runs. */
export interface SessionTurn {
  acpSessionId: string
  /** Persisted session ID; persisted before the turn runs, so never null here. */
  runnerSessionId: string | null
  /** The session's isolated runner, for QUA-244 to subscribe to `runner.bus`. */
  runner: Runner
  /**
   * The turn's abort signal. Aborted by `session/cancel`, `close`, `dispose`,
   * or when the ACP connection closes — the same signal the runner and its
   * tools (including MCP) observe, so a cancel stops all of them together.
   */
  signal: AbortSignal
  /** ACP client context, for `notify(methods.client.session.update, ...)`. */
  client: AgentContext
}

/**
 * A session's explicit selections, as `session/set_config_option` left them.
 * Both null means the connection defaults apply.
 */
export interface SessionSelection {
  /** Profile id, or null for the connection default. */
  profile: string | null
  /** Model id, or null for the selected profile's own model. */
  model: string | null
}

export interface SessionBridgeOptions {
  /**
   * Persistence shared with every session runner. The ACP id minted by
   * `session/new` becomes the persisted session id on the first prompt, so the
   * client's stored thread id round-trips through `session/load`/`resume`.
   * Must be the SAME store each runner is created with: a mismatch would
   * orphan the history the client is naming, so it is refused on first prompt.
   */
  store: SessionStore
  /**
   * Create the runner for a session. Called lazily on the first prompt of a
   * session, and again after its profile changes, so a `session/new` cannot fail
   * on provider/agent setup. `mcpTools` are the tools discovered from the
   * session's stdio MCP servers (empty when none); the host merges them into the
   * agent's tool set. `profile` is the session's selected profile id, or null for
   * the connection default — the host resolves it to the agent the runner binds
   * (its tools, system prompt, skills, and model). Must be synchronous: the
   * bridge captures the runner before the turn awaits, so `cancel` can reach a
   * session's first turn.
   */
  createRunner(cwd: string, mcpTools: ToolDef[], profile: string | null): Runner
  /**
   * QUA-244 seam: called at the start of every turn with the runner and client
   * context, so the integrator can bridge `runner.bus` events to
   * `client.notify(methods.client.session.update, ...)`.
   */
  onTurnStart?(turn: SessionTurn): void
  /**
   * Turn-cleanup seam (QUA-267): awaited in `prompt()`'s `finally`, before the
   * `session/prompt` response is written. It must flush any queued
   * notifications so a client is never left with a truncated turn, and it runs
   * for every turn — including one detached by `session/close` and one aborted
   * by `dispose()`, because `dispose()` awaits the turn's promise. A throw here
   * is logged and swallowed: a teardown flush failure must not turn a settled
   * turn into an error response.
   */
  onTurnEnd?(turn: SessionTurn): void | Promise<void>
  /**
   * Accept ACP `image` prompt blocks and map them to `RunnerPromptInput.images`.
   * Off by default: the baseline bridge only claims the mandatory `text` and
   * `resource_link` blocks. The composition root turns this on only when it
   * also advertises `promptCapabilities.image`.
   */
  images?: boolean
  /**
   * Whether the model a session will actually run accepts image input, when the
   * host knows — a function of that session's selections, because switching
   * profile or model changes which model answers. `false` + an image-bearing
   * prompt rejects up front with a clear `invalidParams` error (option B: accept
   * the capability, fail the prompt loudly instead of silently degrading).
   * `true`/`undefined` (unknown model) pass images through and let the provider
   * surface its own error.
   */
  imageSupport?(selection: SessionSelection): boolean | undefined
  /**
   * Build the initial `configOptions` for a session (profile, model, effort).
   * Called once per `session/new`; the returned array is included in the
   * response so the client can render config UI immediately. Omit or return
   * an empty array to suppress config options. `acpSessionId` lets the host
   * resolve that session's current profile/model/effort selections.
   */
  buildConfigOptions?(acpSessionId: string): SessionConfigOption[]
  /** Diagnostics sink for MCP connect/teardown. Defaults to no-op (stderr in prod). */
  log?(message: string): void
}

/** Per-request dependencies passed to `SessionBridge.prompt`. */
export interface SessionCallContext {
  signal: AbortSignal
  client: AgentContext
}

/**
 * Session handlers, callable directly (tests, custom wiring) or installed onto
 * an `AgentApp` with `registerSessions`.
 *
 * `cancel` is intentionally NOT registered here: QUA-250 owns the
 * `session/cancel` notification handler and calls this method.
 */
export interface SessionBridge {
  /**
   * Register a session. Synchronous when it has no MCP servers; returns a
   * promise (spawning/hand-shaking the servers) when it does.
   */
  newSession(params: NewSessionRequest): NewSessionResponse | Promise<NewSessionResponse>
  prompt(params: PromptRequest, ctx: SessionCallContext): Promise<PromptResponse>
  /** QUA-250 seam: abort the active turn of `sessionId` (no-op if idle). */
  cancel(params: { sessionId: string }): void
  /**
   * QUA-247 seam: attach an existing persisted runner session to `acpSessionId`
   * so the next prompt resumes that history. The runner loads the stored
   * messages for the model; nothing is replayed to the client (that is
   * `session/load`'s job). `cwd` is the client-requested workspace; the runner's
   * stored directory remains authoritative on resume. `mcp` are already-connected
   * stdio servers (resume/load), owned by the bridge and killed on close.
   */
  adopt(params: {
    acpSessionId: string
    cwd: string
    runnerSessionId: string
    mcp?: McpConnection[]
  }): void
  /** Cancel any active turn for `sessionId` and forget the attachment. */
  close(params: { sessionId: string }): void
  /** Whether an active turn is running for this ACP or runner session ID. */
  isActive(sessionId: string): boolean
  /**
   * Cancel active turns and forget all sessions (connection teardown). Awaits
   * every in-flight turn (which runs its `onTurnEnd`, flushing queued
   * notifications) and every MCP disposal before resolving; memoized, so a
   * second call returns the same promise.
   */
  dispose(): Promise<void>
  /** Runner session ID for an ACP session; for diagnostics and tests. */
  runnerSessionId(acpSessionId: string): string | null
  /** Set the model override for a session (used by `session/set_config_option`); null clears it. */
  setModelOverride(acpSessionId: string, model: string | null): void
  /** Get the model override for a session; null means the agent default. */
  getModelOverride(acpSessionId: string): string | null
  /** Set the thinking-effort override for a session; null clears it. */
  setEffortOverride(acpSessionId: string, effort: string | null): void
  /** Get the thinking-effort override for a session; null means the agent default. */
  getEffortOverride(acpSessionId: string): string | null
  /**
   * Switch the session's profile (used by `session/set_config_option`). Drops the
   * cached runner so the next prompt builds one for the new profile, keeping the
   * same persisted session. Throws while a turn is in progress: replacing the
   * runner mid-turn would orphan that turn's abort path.
   */
  setProfileOverride(acpSessionId: string, profile: string | null): void
  /** Get the profile override for a session; null means the connection default. */
  getProfileOverride(acpSessionId: string): string | null
}

/**
 * Build session handlers without an `AgentApp`.
 *
 * @example
 * ```ts
 * const store = new MemorySessionStore()
 * const sessions = createSessionHandlers({ store, createRunner: (cwd) => createRunner({ agent, store }) })
 * const { sessionId } = sessions.newSession({ cwd, mcpServers: [] })
 * ```
 */
export function createSessionHandlers(options: SessionBridgeOptions): SessionBridge {
  const sessions = new Map<string, SessionState>()
  const log = options.log ?? (() => {})
  /**
   * Every in-flight turn promise, tracked at bridge scope (not on SessionState)
   * so a turn detached by `session/close` is still awaited by `dispose()`.
   */
  const inFlight = new Set<Promise<unknown>>()
  /** Memoized teardown so `dispose()` is idempotent and multiple awaits share it. */
  let disposal: Promise<void> | null = null

  function requireSession(acpSessionId: string): SessionState {
    const state = sessions.get(acpSessionId)
    if (!state) {
      throw RequestError.invalidParams({ sessionId: acpSessionId }, "unknown session")
    }
    return state
  }

  /** Register a new session with its (already connected) MCP servers. */
  function registerSession(cwd: string, mcp: McpConnection[]): NewSessionResponse {
    // The ACP id becomes the persisted id on the first prompt, so it must not
    // shadow an existing session: re-mint until it is free.
    let acpSessionId: string
    do {
      acpSessionId = crypto.randomUUID()
    } while (options.store.get(acpSessionId))
    sessions.set(acpSessionId, {
      acpSessionId,
      cwd,
      runner: null,
      runnerSessionId: null,
      active: false,
      cancelled: false,
      client: null,
      turnController: null,
      unsubscribe: null,
      mcp,
      mcpTools: mcp.flatMap((connection) => connection.tools),
      modelOverride: null,
      effortOverride: null,
      profileOverride: null,
    })
    const configOptions = options.buildConfigOptions?.(acpSessionId)
    return {
      sessionId: acpSessionId,
      ...(configOptions?.length ? { configOptions } : {}),
    }
  }

  /**
   * Kill a state's MCP children and return their disposal promises so callers
   * that must await teardown (`dispose`) can; `close` fire-and-forgets them.
   */
  function disposeMcp(state: SessionState): Promise<void>[] {
    const disposals = state.mcp.map((connection) => connection.dispose())
    state.mcp = []
    state.mcpTools = []
    return disposals
  }

  function runnerFor(state: SessionState): Runner {
    if (state.runner) return state.runner
    const runner = options.createRunner(state.cwd, state.mcpTools, state.profileOverride)
    // The runner mints its own session ID on the first prompt and announces it
    // synchronously on this bus, before the turn awaits. Capturing it here lets
    // cancel() reach a first turn and lets later turns resume the same session.
    const onCreated = ({ sessionId }: { sessionId: string }) => {
      state.runnerSessionId ??= sessionId
    }
    runner.bus.on("session-created", onCreated)
    // Titles arrive during a fresh session's first prompt: a synchronous
    // fallback from the user's text, then the generated title, which can land
    // after the turn ended. Forward them for the session's lifetime (not the
    // turn's) so clients show the title in their thread and session list
    // without waiting for a session/list refresh.
    const onTitleChanged = (data: BusEvents["session-title-changed"]) => {
      if (data.title === null) return
      // Child/sub-agent sessions share this runner's bus (see subagent
      // forward-events); only the session this ACP attachment names may
      // retitle the client's thread.
      if (state.runnerSessionId !== null && data.sessionId !== state.runnerSessionId) return
      const client = state.client
      if (!client) return
      client
        .notify(methods.client.session.update, {
          sessionId: state.acpSessionId,
          update: { sessionUpdate: "session_info_update", title: data.title },
        })
        .catch((error: unknown) => {
          log(
            `session title update delivery failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }
    runner.bus.on("session-title-changed", onTitleChanged)
    state.runner = runner
    state.unsubscribe = () => {
      runner.bus.off("session-created", onCreated)
      runner.bus.off("session-title-changed", onTitleChanged)
    }
    return runner
  }

  const bridge: SessionBridge = {
    newSession(params) {
      if (!isAbsolute(params.cwd)) {
        throw RequestError.invalidParams({ cwd: params.cwd }, "cwd must be an absolute path")
      }
      if (params.additionalDirectories?.length) {
        throw RequestError.invalidParams(
          { additionalDirectories: params.additionalDirectories },
          "additionalDirectories are not supported yet",
        )
      }
      // Validate every server synchronously first: a refused request must not
      // leave spawned children behind.
      const stdio: McpServerStdio[] = (params.mcpServers ?? []).map(requireStdio)
      if (stdio.length === 0) return registerSession(params.cwd, [])
      // Fail closed: a server that will not connect refuses the session rather
      // than producing one whose declared tools are silently absent.
      return connectStdioServers(stdio, { log })
        .then(({ connections }) => registerSession(params.cwd, connections))
        .catch((error: unknown) => {
          throw RequestError.invalidParams(
            { mcpServers: stdio.map((server) => server.name) },
            `failed to connect MCP server: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    },

    async prompt(params, ctx) {
      const state = requireSession(params.sessionId)
      if (state.active) {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          "a turn is already in progress for this session",
        )
      }
      const { parts, images } = toRunnerInput(params.prompt, options.images === true)
      // Option B: the capability is advertised, but a model known to lack
      // vision rejects up front — a clear error beats a silent degradation or
      // a mid-turn provider failure after the user already sent the prompt. The
      // verdict follows this session's selections: switching profile or model
      // changes which model answers, so a stale answer would refuse images a
      // vision model could take (or wave through a blind one's).
      const selection: SessionSelection = {
        profile: state.profileOverride,
        model: state.modelOverride,
      }
      if (images.length > 0 && options.imageSupport?.(selection) === false) {
        throw RequestError.invalidParams(
          { images: images.length },
          "this session's model does not accept image input; resend the prompt without image blocks",
        )
      }
      state.active = true
      state.cancelled = false
      // Keep the latest client context: the title forwarder may need to reach
      // the client after this request (and its turn) has settled.
      state.client = ctx.client
      // QUA-264: one controller per turn, shared by the permission/update
      // bridges, the runner, its tools, and MCP. `session/cancel` is a
      // notification, so it never touches `ctx.signal`; aborting this
      // controller is what actually stops the turn.
      const controller = new AbortController()
      state.turnController = controller
      const abortFromRequest = () => controller.abort()
      if (ctx.signal.aborted) controller.abort()
      else ctx.signal.addEventListener("abort", abortFromRequest, { once: true })
      let createdForTurn = false
      let turnStarted = false
      let turn: SessionTurn | undefined
      try {
        const runner = runnerFor(state)
        // The persisted record must live in the same store the runner reads;
        // otherwise this writes a session the runner can never resume.
        if (runner.store !== options.store) {
          throw new Error(
            "session bridge store mismatch: the runner must be created with the bridge's store",
          )
        }
        // First prompt: persist the ACP id so the client's thread id names a
        // real session. Done before onTurnStart/runner.prompt so a failure
        // cannot strand a turn against a nonexistent record.
        if (state.runnerSessionId === null) {
          const existing = options.store.get(state.acpSessionId)
          if (!existing) {
            createSession({ id: state.acpSessionId, directory: state.cwd }, options.store)
            createdForTurn = true
          } else if (existing.kind !== "main" || existing.directory !== state.cwd) {
            throw new Error(`ACP session id collision: ${state.acpSessionId}`)
          }
          state.runnerSessionId = state.acpSessionId
        }
        turn = {
          acpSessionId: state.acpSessionId,
          runnerSessionId: state.runnerSessionId,
          runner,
          signal: controller.signal,
          client: ctx.client,
        }
        turnStarted = true
        options.onTurnStart?.(turn)
        const result = await runner.prompt({
          sessionId: state.runnerSessionId,
          controller,
          parts,
          ...(images.length > 0 ? { images } : {}),
          ...(state.modelOverride ? { model: state.modelOverride } : {}),
          ...(state.effortOverride ? { thinkingEffort: state.effortOverride } : {}),
          targetWorkspace: state.cwd,
        })
        state.runnerSessionId = result.sessionId
        return { stopReason: state.cancelled ? "cancelled" : "end_turn" }
      } catch (error) {
        // A turn that failed before writing its user message leaves an empty
        // envelope behind. Remove it so the id can be retried cleanly; never
        // swallow the failure.
        if (
          createdForTurn &&
          state.runnerSessionId === state.acpSessionId &&
          options.store.replay(state.acpSessionId).messages.length === 0
        ) {
          options.store.delete(state.acpSessionId)
          state.runnerSessionId = null
        }
        // ACP: an aborted operation must not surface as an error response.
        // runner.cancel() aborts the run, so prompt() rejects with an
        // AbortError; report `cancelled` instead (also for teardown cancels,
        // which call runner.cancel without setting `cancelled`). The controller
        // check covers a turn that stopped by observing the shared signal.
        if (state.cancelled || controller.signal.aborted || isAbortError(error)) {
          return { stopReason: "cancelled" }
        }
        throw error
      } finally {
        ctx.signal.removeEventListener("abort", abortFromRequest)
        // Flush queued notifications (and any other turn cleanup) before the
        // session/prompt response is written: a client must never receive a
        // truncated turn. Runs here, not in a wrapped runner.prompt, so it also
        // fires for a turn detached by close() or aborted by dispose().
        if (turnStarted && turn) {
          try {
            await options.onTurnEnd?.(turn)
          } catch (error) {
            log(`onTurnEnd failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (state.turnController === controller) state.turnController = null
        state.active = false
        state.cancelled = false
      }
    },

    cancel({ sessionId }) {
      const state = sessions.get(sessionId)
      // Only an active turn is cancellable; a late cancel must not mark the
      // next turn cancelled.
      if (!state?.active) return
      state.cancelled = true
      // Abort the turn-level controller first: it reaches the permission
      // bridge, provider streaming, tools and MCP even before the runner has
      // announced a session ID. runner.cancel() stays for the runner's own
      // active-run bookkeeping.
      state.turnController?.abort()
      if (state.runner && state.runnerSessionId) {
        state.runner.cancel(state.runnerSessionId)
      }
    },

    adopt({ acpSessionId, cwd, runnerSessionId, mcp = [] }) {
      const existing = sessions.get(acpSessionId)
      if (existing) {
        // Re-adopting the same mapping must not strand newly spawned MCP children.
        if (existing.runnerSessionId === runnerSessionId) {
          for (const connection of mcp) void connection.dispose()
          return
        }
        throw RequestError.invalidParams(
          { sessionId: acpSessionId },
          "session id is already attached to a different session",
        )
      }
      // One persisted session must not back two live attachments: both runners
      // would resume and append to the same history.
      for (const state of sessions.values()) {
        if (state.runnerSessionId === runnerSessionId) {
          throw RequestError.invalidParams({ sessionId: runnerSessionId }, "session is already attached")
        }
      }
      sessions.set(acpSessionId, {
        acpSessionId,
        cwd,
        runner: null,
        runnerSessionId,
        active: false,
        cancelled: false,
        client: null,
        turnController: null,
        unsubscribe: null,
        mcp,
        mcpTools: mcp.flatMap((connection) => connection.tools),
        modelOverride: null,
        effortOverride: null,
        profileOverride: null,
      })
    },

    close({ sessionId }) {
      // ACP `session/close`: cancel ongoing work, kill MCP servers, then forget
      // the attachment. Idempotent for unknown/idle IDs. An active turn keeps
      // running against the now-detached state and resolves through its abort.
      for (const [key, state] of sessions) {
        if (state.acpSessionId !== sessionId && state.runnerSessionId !== sessionId) continue
        if (state.active) {
          state.cancelled = true
          state.turnController?.abort()
          if (state.runner && state.runnerSessionId) state.runner.cancel(state.runnerSessionId)
        }
        state.unsubscribe?.()
        disposeMcp(state)
        sessions.delete(key)
      }
    },

    isActive(sessionId) {
      for (const state of sessions.values()) {
        if (state.active && (state.acpSessionId === sessionId || state.runnerSessionId === sessionId)) {
          return true
        }
      }
      return false
    },

    dispose() {
      if (disposal) return disposal
      disposal = (async () => {
        const mcpDisposals: Promise<void>[] = []
        for (const state of sessions.values()) {
          if (state.active) {
            state.turnController?.abort()
            if (state.runner && state.runnerSessionId) state.runner.cancel(state.runnerSessionId)
          }
          state.unsubscribe?.()
          mcpDisposals.push(...disposeMcp(state))
        }
        // Snapshot before clearing: a turn detached by close() is not in the
        // map, but its promise is in `inFlight`. Awaiting it runs its onTurnEnd,
        // which flushes the queued notify chain.
        const turns = [...inFlight]
        sessions.clear()
        await Promise.allSettled(turns)
        await Promise.allSettled(mcpDisposals)
      })()
      return disposal
    },

    runnerSessionId(acpSessionId) {
      return sessions.get(acpSessionId)?.runnerSessionId ?? null
    },

    setModelOverride(acpSessionId, model) {
      const state = requireSession(acpSessionId)
      state.modelOverride = model
    },

    getModelOverride(acpSessionId) {
      return sessions.get(acpSessionId)?.modelOverride ?? null
    },

    setEffortOverride(acpSessionId, effort) {
      const state = requireSession(acpSessionId)
      state.effortOverride = effort
    },

    getEffortOverride(acpSessionId) {
      return sessions.get(acpSessionId)?.effortOverride ?? null
    },

    setProfileOverride(acpSessionId, profile) {
      const state = requireSession(acpSessionId)
      if (state.profileOverride === profile) return
      // The profile is part of the runner's identity (agent tools, system
      // prompt, skills, model), so it cannot be swapped under a live turn: the
      // running generation owns that turn's abort path.
      if (state.active) {
        throw RequestError.invalidParams(
          { sessionId: acpSessionId },
          "cannot switch profile while a turn is in progress; cancel it first",
        )
      }
      // Drop the cached runner; the next prompt builds one for the new profile.
      // `runnerSessionId` stays, so the new runner resumes the same persisted
      // session and the conversation carries over.
      state.unsubscribe?.()
      state.unsubscribe = null
      state.runner = null
      state.profileOverride = profile
    },

    getProfileOverride(acpSessionId) {
      return sessions.get(acpSessionId)?.profileOverride ?? null
    },
  }

  // Track every turn promise so `dispose()` can await turns detached by
  // `session/close` (whose state is no longer in the map). The wrapper is a
  // plain function: it adds no behavior to the turn itself.
  const runTurn = bridge.prompt.bind(bridge)
  bridge.prompt = (params, ctx) => {
    const turnPromise = runTurn(params, ctx)
    inFlight.add(turnPromise)
    const forget = () => inFlight.delete(turnPromise)
    turnPromise.then(forget, forget)
    return turnPromise
  }
  return bridge
}

/**
 * Install the session handlers on an ACP `AgentApp` (QUA-242's composition root).
 * Registers `session/new` and `session/prompt` only — `session/cancel` is
 * QUA-250's. Returns the bridge so the host can call `dispose()` on connection
 * close (which must cancel active runners).
 */
export function registerSessions(app: AgentApp, options: SessionBridgeOptions): SessionBridge {
  const bridge = createSessionHandlers(options)
  app.onRequest(methods.agent.session.new, ({ params }) => bridge.newSession(params))
  app.onRequest(methods.agent.session.prompt, ({ params, signal, client }) =>
    bridge.prompt(params, { signal, client }),
  )
  return bridge
}

/** AbortError-shaped failures (DOMException or Error with the name) mean cancelled. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError"
}

/** Runner prompt pieces derived from ACP content blocks. */
interface RunnerInput {
  parts: { type: "text"; text: string }[]
  images: { mime: string; data: string }[]
}

/**
 * Translate ACP prompt blocks to runner parts (+ images when enabled),
 * rejecting unsupported ones so a block is never silently dropped.
 */
function toRunnerInput(blocks: ContentBlock[], imagesEnabled: boolean): RunnerInput {
  if (blocks.length === 0) {
    throw RequestError.invalidParams(undefined, "prompt must contain at least one content block")
  }
  const parts: RunnerInput["parts"] = []
  const images: RunnerInput["images"] = []
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push({ type: "text", text: block.text })
        break
      case "resource_link":
        parts.push({ type: "text", text: resourceLinkText(block) })
        break
      case "image":
        if (!imagesEnabled) {
          // Advertised capability and mapping must agree: never accept an image
          // the runner was not wired to forward.
          throw RequestError.invalidParams(
            { type: block.type },
            `unsupported prompt content block "image"; the agent has not advertised promptCapabilities.image`,
          )
        }
        {
          const image = block as ImageContent
          if (!image.data || !image.mimeType) {
            throw RequestError.invalidParams({ type: "image" }, "image block must carry mimeType and base64 data")
          }
          images.push({ mime: image.mimeType, data: image.data })
        }
        break
      default:
        // Baseline blocks are text + resource_link; image is opt-in.
        throw RequestError.invalidParams(
          { type: block.type },
          `unsupported prompt content block "${block.type}"; only text, resource_link${
            imagesEnabled ? ", image" : ""
          } are supported`,
        )
    }
  }
  if (parts.length === 0 && images.length === 0) {
    throw RequestError.invalidParams(undefined, "prompt contained no usable content")
  }
  return { parts, images }
}

// ponytail: flatten a resource link into text until the runner accepts a
// resource part. The URI is load-bearing; the label is for the model's benefit.
function resourceLinkText(link: ResourceLink): string {
  const label = link.title ?? link.name
  const note = link.description ? ` — ${link.description}` : ""
  return `[${label}](${link.uri})${note}`
}
