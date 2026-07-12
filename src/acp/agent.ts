// ACP agent — implements agent-side JSON-RPC methods
//
// Handles: initialize, session/new, session/load, session/prompt, session/cancel
// Orchestrates between transport, event bridge, and Quark internals.

import type { IncomingMessage, OutgoingMessage, AcpTransport } from "./transport"
import * as s from "./schema"
import { bridgeSession, type BridgeHandle } from "./bridge"
import { createSession, getSession } from "../session/session"
import { prompt, cancel } from "../session/prompt"
import { loadMessages } from "../session/message"
import { defaultAgent, agentFromProfile, type AgentConfig } from "../agent"
import { resolveProfile, readPromptFile, listProfiles, loadProfileConfig } from "../profile/profile"
import { bootstrap } from "../bootstrap"
import { loadConfig } from "../config/config"
import { debug } from "../debug"
import { bus } from "../session/events"
import { respond as respondPermission } from "../permission/permission"
import type { PartRow } from "../session/message"

const dlog = debug("acp")

const QUARK_VERSION = "0.1.0"
const ACP_PROTOCOL_VERSION = 1

// ─── Agent State ──────────────────────────────────────────────────────────────

interface SessionState {
  bridges: BridgeHandle[]
  model?: string          // "provider/model" e.g. "deepseek/deepseek-v4-pro"
  profileId?: string      // e.g. "coder", "finder"
}

const sessions = new Map<string, SessionState>()

// Pre-cached at startup
let availableModels: string[] = []
let agentByProfile = new Map<string, AgentConfig>()
let defaultProfileId = "coder"
let defaultModel = "gpt-4o"

// Default agent used when no profile-specific agent matches
let resolvedAgent: AgentConfig = defaultAgent

// Last profile ID that was bootstrapped (for re-bootstrap on set_mode)
let bootstrappedProfileId: string | null = null

// ─── Content Block Conversion ─────────────────────────────────────────────────

function convertContentBlocks(blocks: s.ContentBlock[]): {
  parts: { type: "text"; text: string }[]
  images: { mime: string; data: string }[]
} {
  const parts: { type: "text"; text: string }[] = []
  const images: { mime: string; data: string }[] = []

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text })
        break
      case "image":
        images.push({ mime: block.mimeType, data: block.data })
        break
      case "resource": {
        const r = block.resource
        if ("text" in r) {
          parts.push({ type: "text", text: `[${r.uri}]\n${r.text}` })
        }
        break
      }
      case "resource_link":
        parts.push({ type: "text", text: `[${block.name}](${block.uri})` })
        break
    }
  }

  return { parts, images }
}

// ─── Session Replay ───────────────────────────────────────────────────────────

function replaySession(sessionId: string, send: (msg: OutgoingMessage) => void): void {
  const { messages, parts } = loadMessages(sessionId)
  const partsByMsg = new Map<string, PartRow[]>()
  for (const p of parts) {
    const list = partsByMsg.get(p.messageId) ?? []
    list.push(p)
    partsByMsg.set(p.messageId, list)
  }

  for (const msg of messages) {
    const msgParts = partsByMsg.get(msg.id) ?? []

    if (msg.role === "user") {
      for (const p of msgParts) {
        if (p.type === "text") {
          const data = JSON.parse(p.data) as { text: string }
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: data.text },
            },
          })
        }
      }
    } else if (msg.role === "assistant") {
      for (const p of msgParts) {
        const data = JSON.parse(p.data) as Record<string, unknown>

        switch (p.type) {
          case "text": {
            const text = data.text as string
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
              },
            })
            break
          }
          case "reasoning": {
            const text = data.text as string
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text },
              },
            })
            break
          }
          case "tool": {
            const tool = data.tool as string
            const callId = data.callId as string
            const status = data.status as string
            const output = data.output as string | undefined
            const error = data.error as string | undefined

            const toolStatus: s.ToolCallStatus =
              status === "completed" ? "completed"
              : status === "error" ? "failed"
              : "completed"

            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionUpdate: "tool_call",
                toolCallId: callId,
                title: tool,
                kind: "other",
                status: toolStatus,
                content: output ? [{ type: "text", text: output }] : undefined,
                rawOutput: error ? { error } : undefined,
              },
            })
            break
          }
        }
      }
    }
  }

  // Send session info update if the session already has a title
  const session = getSession(sessionId)
  if (session.title) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: new Date(session.timeUpdated).toISOString(),
      },
    })
  }
}

// ─── Permission Bridge ───────────────────────────────────────────────────────

function bridgePermissions(
  sessionId: string,
  call: (method: string, params: unknown) => Promise<unknown>,
): () => void {
  const handler = (data: { sessionId: string; requestId: string; tool: string; input: Record<string, unknown> }) => {
    if (data.sessionId !== sessionId) return

    const pattern = (data.input.pattern as string) ?? data.tool

    call("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: data.requestId,
        title: data.tool,
        kind: "other",
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    }).then((result) => {
      const outcome = result as s.RequestPermissionOutcome
      if (outcome.outcome === "cancelled") {
        respondPermission({ requestId: data.requestId, reply: "reject" })
        return
      }
      if (outcome.outcome === "selected") {
        const reply = optionToReply(outcome.optionId)
        respondPermission({ requestId: data.requestId, reply })
      }
    }).catch(() => {
      respondPermission({ requestId: data.requestId, reply: "reject" })
    })
  }

  bus.on("permission-request", handler)
  return () => bus.off("permission-request", handler)
}

function optionToReply(optionId: string): "once" | "always" | "reject" {
  switch (optionId) {
    case "allow-once": return "once"
    case "allow-always": return "always"
    case "reject-once": return "reject"
    default: return "reject"
  }
}

// ─── Session Meta (configOptions + modes) ─────────────────────────────────────

function buildSessionMeta(sessionId: string): {
  configOptions: s.SessionConfigOption[]
  modes: s.SessionModeState
} {
  const state = sessions.get(sessionId)
  const currentModelId = state?.model ?? defaultModel
  const currentModeId = state?.profileId ?? defaultProfileId

  const availableModes = [...agentByProfile.entries()].map(([id, agent]) => ({
    id,
    name: agent.name,
  }))

  return {
    configOptions: [
      { name: "model", value: currentModelId },
      { name: "available_models", value: availableModels },
    ],
    modes: { currentModeId, availableModes },
  }
}

// ─── Bootstrap helper ─────────────────────────────────────────────────────────

async function ensureBootstrapped(profileId: string): Promise<void> {
  if (bootstrappedProfileId === profileId) return

  const profile = resolveProfile(profileId)

  await bootstrap({
    profileTools: profile.tools,
    boundSkills: profile.skills,
  })

  bootstrappedProfileId = profileId
  dlog("bootstrapped profile: %s (tools: %d, skills: %d)", profileId, profile.tools.length, profile.skills.length)
}

// ─── Method Handlers ──────────────────────────────────────────────────────────

function handleInitialize(
  id: s.RequestId,
  _params: unknown,
  send: (msg: OutgoingMessage) => void,
): void {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
        },
        sessionCapabilities: {
          resume: {},
          close: {},
        },
      },
      agentInfo: {
        name: "quark",
        title: "Quark",
        version: QUARK_VERSION,
      },
      authMethods: [],
    },
  })
}

function handleNewSession(
  id: s.RequestId,
  params: unknown,
  send: (msg: OutgoingMessage) => void,
): void {
  const parsed = s.NewSessionRequest.shape.params.safeParse(params)
  if (!parsed.success) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.InvalidParams, message: parsed.error.message },
    })
    return
  }

  const session = createSession({ directory: parsed.data.cwd })
  sessions.set(session.id, { bridges: [] })

  const meta = buildSessionMeta(session.id)

  send({
    jsonrpc: "2.0",
    id,
    result: {
      sessionId: session.id,
      configOptions: meta.configOptions,
      modes: meta.modes,
    },
  })
}

function handleLoadSession(
  id: s.RequestId,
  params: unknown,
  send: (msg: OutgoingMessage) => void,
): void {
  const parsed = s.LoadSessionRequest.shape.params.safeParse(params)
  if (!parsed.success) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.InvalidParams, message: parsed.error.message },
    })
    return
  }

  const { sessionId } = parsed.data
  const session = getSession(sessionId)
  if (!session) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.ResourceNotFound, message: `Session not found: ${sessionId}` },
    })
    return
  }

  replaySession(sessionId, send)

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { bridges: [] })
  }

  const meta = buildSessionMeta(sessionId)

  send({
    jsonrpc: "2.0",
    id,
    result: {
      configOptions: meta.configOptions,
      modes: meta.modes,
    },
  })
}

async function handlePrompt(
  id: s.RequestId,
  params: unknown,
  send: (msg: OutgoingMessage) => void,
  call: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  const parsed = s.PromptRequest.shape.params.safeParse(params)
  if (!parsed.success) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.InvalidParams, message: parsed.error.message },
    })
    return
  }

  const { sessionId, prompt: blocks } = parsed.data
  const session = getSession(sessionId)
  if (!session) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.ResourceNotFound, message: `Session not found: ${sessionId}` },
    })
    return
  }

  let state = sessions.get(sessionId)
  if (!state) {
    state = { bridges: [] }
    sessions.set(sessionId, state)
  }

  // Pick the right agent for the session's current profile
  const profileId = state.profileId ?? defaultProfileId
  const agent = agentByProfile.get(profileId) ?? resolvedAgent

  // Pick model: session override → agent config → default
  const model = state.model ?? agent.model ?? defaultModel

  const { parts, images } = convertContentBlocks(blocks)

  // Bridge events to ACP notifications
  const bridge = bridgeSession(sessionId, send)
  state.bridges.push(bridge)

  // Bridge permission requests to editor
  const unbridgePerms = bridgePermissions(sessionId, call)

  let stopReason: s.StopReason = "end_turn"

  try {
    await prompt({
      sessionId,
      parts,
      images: images.length > 0 ? images : undefined,
      agent,
      model,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("abort") || msg.includes("cancel")) {
      stopReason = "cancelled"
    } else {
      dlog("prompt error: %s", msg)
      stopReason = "refusal"
    }
  } finally {
    unbridgePerms()
    bridge.close()
    state.bridges = state.bridges.filter((b) => b !== bridge)
  }

  send({
    jsonrpc: "2.0",
    id,
    result: { stopReason },
  })
}

function handleCancel(params: unknown): void {
  const parsed = s.CancelNotification.shape.params.safeParse(params)
  if (!parsed.success) return

  cancel(parsed.data.sessionId)
}

function handleSetSessionMode(
  id: s.RequestId,
  params: unknown,
  send: (msg: OutgoingMessage) => void,
): void {
  const parsed = s.SetSessionModeRequest.shape.params.safeParse(params)
  if (!parsed.success) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.InvalidParams, message: parsed.error.message },
    })
    return
  }

  const { sessionId, modeId } = parsed.data

  if (!agentByProfile.has(modeId)) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.InvalidParams, message: `Unknown mode: ${modeId}` },
    })
    return
  }

  let state = sessions.get(sessionId)
  if (!state) {
    state = { bridges: [] }
    sessions.set(sessionId, state)
  }
  state.profileId = modeId

  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionUpdate: "current_mode_update",
      modeId,
    },
  })

  send({ jsonrpc: "2.0", id, result: null })
}

function handleSetSessionConfigOption(
  id: s.RequestId,
  params: unknown,
  send: (msg: OutgoingMessage) => void,
): void {
  const parsed = s.SetSessionConfigOptionRequest.shape.params.safeParse(params)
  if (!parsed.success) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: s.ErrorCodes.InvalidParams, message: parsed.error.message },
    })
    return
  }

  const { sessionId, configOptions } = parsed.data

  let state = sessions.get(sessionId)
  if (!state) {
    state = { bridges: [] }
    sessions.set(sessionId, state)
  }

  for (const opt of configOptions) {
    if (opt.name === "model" && typeof opt.value === "string") {
      state.model = opt.value
    }
  }

  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionUpdate: "config_option_update",
      configOptions,
    },
  })

  send({ jsonrpc: "2.0", id, result: null })
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

export async function runAcpAgent(transport: AcpTransport, profileName?: string): Promise<void> {
  // Load config
  const config = loadConfig()
  availableModels = config.models
  defaultModel = config.main_model

  // Pre-cache all profile → agent configs
  const profileIds = listProfiles()
  for (const pid of profileIds) {
    const profile = resolveProfile(pid)
    const promptResult = readPromptFile(profile)
    agentByProfile.set(pid, agentFromProfile(profile, promptResult.content))
  }
  defaultProfileId = profileName ?? loadProfileConfig().defaultProfile

  // Resolve default agent
  resolvedAgent = agentByProfile.get(defaultProfileId) ?? defaultAgent

  // Bootstrap default profile
  await ensureBootstrapped(defaultProfileId)

  dlog("acp agent started (profile: %s, model: %s)", defaultProfileId, resolvedAgent.model ?? defaultModel)

  for await (const msg of transport) {
    if (msg.kind === "error") {
      dlog("parse error: %s", msg.error)
      continue
    }

    if (msg.kind === "notification") {
      const { method, params } = msg.data
      if (method === "session/cancel") {
        handleCancel(params)
      }
      continue
    }

    if (msg.kind === "response") continue

    const { id, method, params } = msg.data

    try {
      switch (method) {
        case "initialize":
          handleInitialize(id, params, transport.send)
          break
        case "session/new":
          handleNewSession(id, params, transport.send)
          break
        case "session/load":
          handleLoadSession(id, params, transport.send)
          break
        case "session/prompt": {
          // Re-bootstrap if the session's profile differs, then dispatch
          // the prompt WITHOUT awaiting so the main loop can keep reading
          // incoming messages (notably `session/cancel`) while the prompt
          // is in flight. Awaiting here would block notification handling
          // for the entire duration of the LLM stream.
          const parsed = s.PromptRequest.shape.params.safeParse(params)
          const pid = parsed.success
            ? (sessions.get(parsed.data.sessionId)?.profileId ?? defaultProfileId)
            : defaultProfileId
          void ensureBootstrapped(pid)
            .then(() => handlePrompt(id, params, transport.send, transport.call))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              dlog("prompt dispatch error: %s", message)
              transport.send({
                jsonrpc: "2.0",
                id,
                error: { code: s.ErrorCodes.InternalError, message },
              })
            })
          break
        }
        case "session/set_mode": {
          handleSetSessionMode(id, params, transport.send)
          // Re-bootstrap for the new mode
          const parsed = s.SetSessionModeRequest.shape.params.safeParse(params)
          if (parsed.success) {
            await ensureBootstrapped(parsed.data.modeId)
          }
          break
        }
        case "session/set_config_option":
          handleSetSessionConfigOption(id, params, transport.send)
          break
        default:
          transport.send({
            jsonrpc: "2.0",
            id,
            error: { code: s.ErrorCodes.MethodNotFound, message: `Unknown method: ${method}` },
          })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      dlog("internal error: %s", message)
      transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: s.ErrorCodes.InternalError, message },
      })
    }
  }

  // Clean up all bridges
  for (const [, state] of sessions) {
    for (const bridge of state.bridges) {
      bridge.close()
    }
  }
  sessions.clear()
  dlog("acp agent stopped")
}
