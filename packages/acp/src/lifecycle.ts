// Persistent session lifecycle (QUA-247): list / resume / load / delete / close.
//
// Every method here operates on the runner's own SessionStore (see
// @quark/runner/session/store), which MUST be the SAME store the host passes to
// `createRunner` for every session. Otherwise list/resume would name sessions
// the live runners cannot see, and delete could remove history a runner is
// still reading. `createAcpAgent` owns that single store and threads it both
// ways (see ./index).
//
// What each method genuinely backs, and why the rest is refused:
//
//   session/list    store.list()          -> persistable main sessions
//   session/resume  adopt store session   -> next prompt resumes history (no replay)
//   session/load    adopt + store.replay  -> resume AND replay history to the client
//   session/delete  store.get/isActive/delete -> remove one listed, idle session
//   session/close   sessions.close        -> cancel active work + forget attachment
//
// Safety rules enforced here (no silent data loss):
//   * cwd on list/resume/load must be absolute; resume/load must match the
//     session's stored workspace exactly (a session never silently moves).
//   * resume/load reject unknown, sub-agent, or ephemeral IDs — only what
//     `session/list` offered may be reopened.
//   * resume/load refuse a session with an active turn instead of racing it.
//   * delete refuses an active session, then evicts any idle attachment before
//     removing history, so a later prompt cannot resume deleted data.
//   * additionalDirectories are rejected, never silently dropped.
//   * mcpServers (QUA-245) must be stdio; they are connected before adoption
//     and killed when the session is closed/deleted (via the session bridge).

import { methods, RequestError } from "@agentclientprotocol/sdk"
import type {
  AgentApp,
  AgentCapabilities,
  AgentContext,
  CloseSessionRequest,
  DeleteSessionRequest,
  LoadSessionRequest,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  McpServer,
  McpServerStdio,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
} from "@agentclientprotocol/sdk"
import { isAbsolute } from "node:path"
import type { Session, SessionStore } from "@quark/runner"
import type { SessionBridge } from "./sessions"
import { connectStdioServers, requireStdio, type McpConnection } from "./mcp"
import { historyToUpdates, lastUsageUpdate } from "./updates"
import type { ToolCallIds } from "./tool-call-ids"

export interface LifecycleOptions {
  /**
   * Persistence backing this connection's runners. Must be the SAME store the
   * host hands to `createRunner`; a different store would list sessions the
   * live prompts cannot see, and delete history a runner is still reading.
   */
  store: SessionStore
  /** Diagnostics sink for MCP connect/teardown. Defaults to no-op (stderr in prod). */
  log?(message: string): void
  /**
   * QUA-265: the connection's tool-call-id registry, so a replayed tool row's
   * ACP id can never collide with a later live-turn id. Omitted (direct
   * callers/tests), replay mints local unique ids.
   */
  toolCallIds?: ToolCallIds
  /**
   * Build the `configOptions` for a session so `session/resume` and
   * `session/load` can include them in the response, the same way
   * `session/new` does. Omit to suppress config options in resume/load.
   */
  buildConfigOptions?(acpSessionId: string): SessionConfigOption[]
}

/**
 * Session lifecycle handlers plus the capabilities for exactly the methods that
 * were registered. Callable directly (tests, custom wiring) or installed with
 * {@link registerLifecycle}.
 */
export interface SessionLifecycle {
  /**
   * ACP capabilities for the registered subset. The parent threads this into
   * the `initialize` response, so advertisement cannot drift from the handlers.
   */
  capabilities: AgentCapabilities
  listSessions(params: ListSessionsRequest): ListSessionsResponse
  resumeSession(
    params: ResumeSessionRequest,
    client: AgentContext,
  ): ResumeSessionResponse | Promise<ResumeSessionResponse>
  /** Adopt the session, then replay its history as `session/update` notifications. */
  loadSession(params: LoadSessionRequest, client: AgentContext): Promise<LoadSessionResponse>
  deleteSession(params: DeleteSessionRequest): void
  closeSession(params: CloseSessionRequest): void
}

/**
 * Build the lifecycle handlers without an `AgentApp`.
 *
 * @example
 * ```ts
 * const lifecycle = createSessionLifecycle(sessions, { store })
 * const { sessions: listed } = lifecycle.listSessions({})
 * ```
 */
export function createSessionLifecycle(
  sessions: SessionBridge,
  options: LifecycleOptions,
): SessionLifecycle {
  const { store } = options

  /** Resolve a persisted, user-facing session or reject with invalidParams. */
  function requireListed(sessionId: string): Session & { directory: string } {
    // Only sessions `list` would return can be reopened/deleted, so these
    // methods cannot reach a sub-agent/ephemeral session the client never saw.
    const session = store.get(sessionId)
    if (!session || !isListable(session)) {
      throw RequestError.invalidParams({ sessionId }, "unknown session")
    }
    return session
  }

  /**
   * Validate a resume/load request and attach the session to the bridge.
   * Shared so both paths enforce identical safety rules. Returns a promise only
   * when the request carries MCP servers (which must be connected first);
   * otherwise the host session is attached synchronously.
   */
  function adopt(params: {
    sessionId: string
    cwd: string
    mcpServers?: readonly McpServer[]
    additionalDirectories?: readonly string[]
  }): void | Promise<void> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({ cwd: params.cwd }, "cwd must be an absolute path")
    }
    if (params.additionalDirectories?.length) {
      throw RequestError.invalidParams(
        { additionalDirectories: params.additionalDirectories },
        "additionalDirectories are not supported yet",
      )
    }
    // Validate transports synchronously so a refused request never spawns.
    const stdio: McpServerStdio[] = (params.mcpServers ?? []).map(requireStdio)
    const session = requireListed(params.sessionId)
    // A session is permanently bound to its workspace: refusing a mismatch
    // stops a resume from silently moving the conversation.
    if (session.directory !== params.cwd) {
      throw RequestError.invalidParams(
        { cwd: params.cwd, expected: session.directory },
        "cwd does not match the session's workspace",
      )
    }
    if (sessions.isActive(params.sessionId)) {
      throw RequestError.invalidParams({ sessionId: params.sessionId }, "session has an active turn")
    }
    // ACP session id == store id for adopted sessions, so subsequent
    // `session/prompt` requests name the same id the client listed.
    const attach = (mcp: McpConnection[]) => {
      try {
        sessions.adopt({
          acpSessionId: params.sessionId,
          cwd: params.cwd,
          runnerSessionId: params.sessionId,
          // Only carry the field when present: an adopted session with no MCP
          // servers stays byte-for-byte the same mapping as before QUA-245.
          ...(mcp.length > 0 ? { mcp } : {}),
        })
      } catch (error) {
        // Adoption refused (e.g. a concurrent attach): do not leak the children.
        for (const connection of mcp) void connection.dispose()
        throw error
      }
    }
    if (stdio.length === 0) {
      attach([])
      return
    }
    return connectStdioServers(stdio, { log: options.log }).then(({ connections }) => attach(connections))
  }

  /**
   * Build the response fragment with `configOptions` for a session that was
   * just adopted (resume/load). Mirrors the pattern `session/new` uses in
   * `registerSession`: include the array only when non-empty, omit it otherwise.
   */
  function configOptionsResponse(sessionId: string): { configOptions?: SessionConfigOption[] } {
    const configOptions = options.buildConfigOptions?.(sessionId)
    return configOptions?.length ? { configOptions } : {}
  }

  /**
   * Replay the session's last reported token usage, so a reopened conversation
   * shows its context-window meter without waiting for the next turn. Sessions
   * whose steps predate the persisted window size stay silent.
   */
  async function notifyUsage(sessionId: string, client: AgentContext): Promise<void> {
    const usage = lastUsageUpdate(store.replay(sessionId).parts)
    if (!usage) return
    await client.notify(methods.client.session.update, { sessionId, update: usage })
  }

  return {
    // Keep this in lockstep with the handlers below: one entry per method that
    // is actually installed.
    capabilities: {
      loadSession: true,
      sessionCapabilities: {
        list: {},
        delete: {},
        resume: {},
        close: {},
      },
    },

    listSessions({ cwd }) {
      if (cwd != null && !isAbsolute(cwd)) {
        throw RequestError.invalidParams({ cwd }, "cwd must be an absolute path")
      }
      // ponytail: single page — we never issue a nextCursor, so a client cursor
      // can only be stale. Add paging when a store exposes one.
      const listing = store
        .list()
        .filter(isListable)
        .filter((session) => cwd == null || session.directory === cwd)
        .sort((a, b) => b.timeUpdated - a.timeUpdated)
        .map(toSessionInfo)
      return { sessions: listing }
    },

    resumeSession(params, client) {
      // `adopt` throws synchronously for unsafe requests (unknown session, cwd
      // mismatch, active turn), and the no-usage path stays synchronous too.
      const pending = adopt(params)
      const respond = (): ResumeSessionResponse => configOptionsResponse(params.sessionId)
      // History is not replayed (the next prompt hands the runner the stored
      // session ID), but the last reported usage is: a client reattaching after
      // a restart has no live thread to seed its token meter from.
      const usage = lastUsageUpdate(store.replay(params.sessionId).parts)
      if (!pending && !usage) return respond()
      return (async () => {
        if (pending) await pending
        if (usage) {
          await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: usage })
        }
        return respond()
      })()
    },

    async loadSession(params, client) {
      const pending = adopt(params)
      if (pending) await pending
      const { messages, parts } = store.replay(params.sessionId)
      // Replay must reach the client before the load response, in order.
      for (const update of historyToUpdates({ messages, parts }, options.toolCallIds)) {
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update })
      }
      // The token meter is session state, not history: restore it last, after
      // the conversation it belongs to.
      await notifyUsage(params.sessionId, client)
      return configOptionsResponse(params.sessionId)
    },

    deleteSession({ sessionId }) {
      requireListed(sessionId)
      // Never remove history a live turn is still appending to.
      if (sessions.isActive(sessionId)) {
        throw RequestError.invalidParams(
          { sessionId },
          "session has an active turn; close it before deleting",
        )
      }
      // Evict any idle attachment first, so a later prompt for this id cannot
      // resume the history we are about to remove.
      sessions.close({ sessionId })
      store.delete(sessionId)
    },

    closeSession({ sessionId }) {
      // ACP `session/close`: cancel ongoing work and free the attachment.
      // `sessions.close` is idempotent for unknown/idle ids.
      sessions.close({ sessionId })
    },
  }
}

/**
 * Install the lifecycle handlers on an ACP `AgentApp` (QUA-242's composition
 * root) and return the handlers + capabilities. Registers `session/list`,
 * `session/resume`, `session/load`, `session/delete` and `session/close`.
 */
export function registerLifecycle(
  app: AgentApp,
  sessions: SessionBridge,
  options: LifecycleOptions,
): SessionLifecycle {
  const lifecycle = createSessionLifecycle(sessions, options)
  app.onRequest(methods.agent.session.list, ({ params }) => lifecycle.listSessions(params))
  app.onRequest(methods.agent.session.resume, ({ params, client }) =>
    lifecycle.resumeSession(params, client),
  )
  app.onRequest(methods.agent.session.load, ({ params, client }) => lifecycle.loadSession(params, client))
  app.onRequest(methods.agent.session.delete, ({ params }) => lifecycle.deleteSession(params))
  app.onRequest(methods.agent.session.close, ({ params }) => lifecycle.closeSession(params))
  return lifecycle
}

/** A session `session/list` may report and `session/resume`/`delete` may act on. */
function isListable(session: Session): session is Session & { directory: string } {
  return session.kind === "main" && session.directory != null
}

function toSessionInfo(session: Session & { directory: string }): SessionInfo {
  return {
    sessionId: session.id,
    cwd: session.directory,
    ...(session.title ? { title: session.title } : {}),
    updatedAt: new Date(session.timeUpdated).toISOString(),
  }
}
