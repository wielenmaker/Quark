// prompt() entry point + loop() — the core agent loop
//
// Flow:
// 1. prompt() saves the user message, creates/resumes a session, enters loop()
// 2. loop() iterates:
//    a. Load all messages from DB → convert to ModelMessage[]
//    b. Build system prompt
//    c. Resolve tools (ToolDef → AI SDK tool objects)
//    d. Create an assistant message row
//    e. Call processStream() which streams, persists parts, returns outcome
//    f. "continue" → next iteration (tool calls need follow-up)
//    g. "stop" → break

import { tool, jsonSchema, type ToolSet, type ToolExecutionOptions } from "ai"
import { z } from "zod"
import { createSession, getSession, touchSession } from "./session"
import { saveUserMessage, createAssistantMessage, addPart, finishMessage, loadMessages, toModelMessages } from "./message"
import { buildSystem } from "./system"
import { processStream } from "./processor"
import { shouldCompact, estimateTokens } from "./compaction"
import {
  resolve as resolveCompaction,
  takePending,
  type CompactMethodContext,
} from "./compact-resolver"
import { generateSessionTitle } from "./title"
import { list as listTools, resolve as resolveTools } from "../tool/registry"
import { getModel, createCopilotProvider, createOpenAICompatibleProvider, createCopilotAnthropicProvider, isClaude, getCopilotThinkingBudget } from "../provider/provider"
import { loadToken } from "../provider/copilot-auth"
import { getModelLimit } from "../provider/models"
import { defaultAgent, type AgentConfig } from "../agent"
import { getModelId, getProviderId, getProviderConfig, resolveApiKey, loadConfig, parseModelSpec } from "../config/config"
import type { ToolDef, ToolResult } from "../tool/tool"
import {
  ask as askPermission,
  evaluate as evaluatePermission,
  type Ruleset,
  DeniedError,
  RejectedError,
  CorrectedError,
} from "../permission/permission"
import type { JSONObject } from "@ai-sdk/provider"
import { bus } from "./events"
import { fireHook } from "../plugin/registry"

// ---------------------------------------------------------------------------
// Active sessions — track abort controllers so we can cancel
// ---------------------------------------------------------------------------
const active = new Map<string, AbortController>()

// ---------------------------------------------------------------------------
// prompt() — public entry point
// ---------------------------------------------------------------------------
/**
 * Run the agent loop for a given user input.
 *
 * Creates a new session if `sessionId` is not provided, saves the user message,
 * then iterates the agent loop until the model returns `stop` or `max_steps` is reached.
 *
 * @param input.sessionId - Resume an existing session (optional)
 * @param input.parentSessionId - Link this session as a sub-agent child (optional)
 * @param input.parts - User message parts (text content)
 * @param input.images - Optional image attachments (`mime` + base64 `data`)
 * @param input.model - Override the provider and model for this call
 * @param input.agent - Override the agent config (defaults to {@link defaultAgent})
 * @returns The session ID that was used (new or resumed)
 *
 * @example
 * ```ts
 * const { sessionId } = await prompt({
 *   parts: [{ type: 'text', text: 'Refactor src/index.ts to use async/await' }],
 * })
 * ```
 */
export async function prompt(input: {
  sessionId?: string
  parentSessionId?: string
  parts: { type: "text"; text: string }[]
  images?: { mime: string; data: string }[]
  model?: { provider: string; model: string }
  agent?: AgentConfig
}) {
  const agent = input.agent ?? defaultAgent

  // Resolve or create session (lazy — only created on first message)
  let sessionId: string
  if (input.sessionId) {
    getSession(input.sessionId) // throws if missing
    sessionId = input.sessionId
  } else {
    // If parentSessionId is provided but doesn't exist in the DB (e.g. sub-agent
    // with in-memory DB), skip it to avoid FOREIGN KEY constraint violation.
    // Still tag the session as kind: "subagent" for metadata purposes.
    let parentExists = false
    if (input.parentSessionId) {
      try {
        getSession(input.parentSessionId)
        parentExists = true
      } catch {
        // Parent doesn't exist in this DB (sub-agent in-memory DB)
      }
    }
    const sess = createSession(
      input.parentSessionId
        ? parentExists
          ? { parentSessionId: input.parentSessionId, kind: "subagent" }
          : { kind: "subagent" }
        : undefined,
    )
    sessionId = sess.id
    bus.emit("session-created", { sessionId })
    fireHook("session.created", { sessionId }).catch(() => {})
  }

  // Set QUARK_SESSION_ID so child processes (bash tool) can inherit it
  process.env.QUARK_SESSION_ID = sessionId

  touchSession(sessionId)

  // Save user message (concatenate all text parts)
  const text = input.parts.map((p) => p.text).join("\n")
  saveUserMessage({ sessionId, text, images: input.images })

  // Enter the loop
  const controller = new AbortController()
  active.set(sessionId, controller)
  bus.emit("loop-start", { sessionId })
  try {
    // Generate a title in the background if session is untitled
    // Uses the small_model from config — cheap and fast
    const session = getSession(sessionId)
    if (!session.title) {
      resolveModel(input.model, "small").then((model) => {
        generateSessionTitle({ sessionId, message: text, model })
      }).catch(() => {
        // Title generation is best-effort — never fail the session
      })
    }

    await loop(sessionId, controller.signal, agent, input.model)
  } finally {
    active.delete(sessionId)
    bus.emit("loop-end", { sessionId })
    fireHook("session.idle", { sessionId }).catch(() => {})
  }

  return { sessionId }
}

/**
 * Cancel a running agent loop for the given session.
 *
 * Triggers the `AbortController` associated with the session, which propagates
 * through the LLM stream and all active tool calls. Safe to call on sessions
 * that are not currently running (no-op).
 *
 * @param sessionId - The session to cancel
 */
export function cancel(sessionId: string) {
  const controller = active.get(sessionId)
  if (controller) {
    controller.abort()
    active.delete(sessionId)
  }
}

// ---------------------------------------------------------------------------
// loop() — the heart of the agent
// ---------------------------------------------------------------------------
async function loop(
  sessionId: string,
  abort: AbortSignal,
  agent: AgentConfig,
  modelOpt?: { provider: string; model: string },
) {
  // Build the AI SDK model
  // Priority: explicit modelOpt > agent.model > config main_model
  const effectiveModel = parseModelSpec(modelOpt?.model ?? agent.model ?? getModelId("main")).model
  const model = await resolveModel(
    modelOpt ?? (agent.model ? { provider: getProviderId("main"), model: agent.model } : undefined),
  )
  const modelLimit = getModelLimit(effectiveModel)

  // mutable — may change when compaction creates a new session
  let currentSessionId = sessionId

  let step = 0
  while (true) {
    if (abort.aborted) break
    step++

    // Safety: prevent runaway loops
    if (step > loadConfig().max_steps) break

    // Plugin hook: loop step beginning
    await fireHook("loop.step.before", { sessionId: currentSessionId, step })

    // 0. Run pending compaction (queued from previous iteration or tool call)
    const pendingReq = takePending(currentSessionId)
    if (pendingReq) {
      bus.emit("compaction-start", { sessionId: currentSessionId })
      try {
        const result = await resolveCompaction({
          trigger: pendingReq.trigger,
          ctx: pendingReq.ctx,
          methodId: pendingReq.methodId,
        })
        bus.emit("compaction-end", { sessionId: currentSessionId, result })
        if (result.type === "new-session") {
          currentSessionId = result.newSessionId
          const { messages: newMsgs, parts: newParts } = loadMessages(currentSessionId)
          const { dbToTuiMessages } = await import("../tui/state")
          const sys = buildSystem(agent)
          const newModelMsgs = toModelMessages(newMsgs, newParts)
          const sysStr = Array.isArray(sys) ? sys.join("\n") : sys
          bus.emit("session-switch", {
            sessionId: currentSessionId,
            messages: dbToTuiMessages(newMsgs, newParts),
            estimatedTokens: estimateTokens(sysStr, newModelMsgs),
          })
        }
      } catch (err) {
        bus.emit("compaction-end", { sessionId: currentSessionId, result: null })
        bus.emit("error", { sessionId: currentSessionId, error: err })
        fireHook("session.error", { sessionId: currentSessionId, error: err }).catch(() => {})
      }
    }

    // 1. Load conversation history
    const { messages, parts } = loadMessages(currentSessionId)
    const modelMessages = toModelMessages(messages, parts)

    // 2. Build system prompt
    const system = buildSystem(agent)

    // 3. Check if compaction is needed BEFORE the model call
    const cfg = loadConfig()
    if (cfg.compact.auto && shouldCompact(system, modelMessages, modelLimit, cfg.context_window, cfg.compact.threshold)) {
      bus.emit("compaction-start", { sessionId: currentSessionId })
      try {
        // Fire session.compacting hook — plugins can inject extra context
        const compactingOutput = await fireHook("session.compacting", { sessionId: currentSessionId })
        const compactCtx: CompactMethodContext = {
          sessionId: currentSessionId,
          messages,
          parts,
          modelMessages,
          model,
          agentPrompt: system,
          budget: modelLimit,
          persist: { createMessage: createAssistantMessage, addPart, finishMessage, saveUserMessage },
          session: { create: createSession },
          extraContext: compactingOutput.context,
        }
        const compactResult = await resolveCompaction({ trigger: "auto", ctx: compactCtx })
        bus.emit("compaction-end", { sessionId: currentSessionId, result: compactResult })

        if (compactResult.type === "new-session") {
          currentSessionId = compactResult.newSessionId
          // Load the new session's messages for the TUI
          const { messages: newMsgs, parts: newParts } = loadMessages(currentSessionId)
          const { dbToTuiMessages } = await import("../tui/state")
          const systemStr = Array.isArray(system) ? system.join("\n") : system
          const newModelMessages = toModelMessages(newMsgs, newParts)
          const estimatedTokens = estimateTokens(systemStr, newModelMessages)
          bus.emit("session-switch", {
            sessionId: currentSessionId,
            messages: dbToTuiMessages(newMsgs, newParts),
            estimatedTokens,
          })
        }

        // Re-load after compaction so the model sees the compacted context
        continue
      } catch (err) {
        bus.emit("compaction-end", { sessionId: currentSessionId, result: null })
        bus.emit("error", { sessionId: currentSessionId, error: err })
        fireHook("session.error", { sessionId: currentSessionId, error: err }).catch(() => {})
        // Continue with full context if compaction fails
      }
    }

    // 4. Create assistant message row
    const assistantMsg = createAssistantMessage({
      sessionId: currentSessionId,
      modelId: modelOpt?.model,
      providerId: modelOpt?.provider ?? "copilot",
    })
    bus.emit("assistant-message-start", { sessionId: currentSessionId, messageId: assistantMsg.id })

    // 5. Resolve tools with correct context for this iteration
    const tools = resolveToolSet(agent, currentSessionId, assistantMsg.id, abort, modelMessages)

    // 6. Stream + process
    // When thinking is enabled for a Copilot Claude model, pass providerOptions
    // so @ai-sdk/anthropic forwards the thinking param to the Anthropic Messages API.
    const thinkingBudget = getCopilotThinkingBudget()
    const providerId = modelOpt?.provider ?? "copilot"
    const thinkingProviderOptions: Record<string, JSONObject> | undefined =
      thinkingBudget > 0 && providerId === "copilot" && isClaude(effectiveModel)
        ? { anthropic: { thinking: { type: "enabled", budgetTokens: thinkingBudget } } as JSONObject }
        : undefined
    const result = await processStream({
      model,
      system,
      messages: modelMessages,
      tools,
      abort,
      msg: assistantMsg,
      sessionId: currentSessionId,
      ...(thinkingProviderOptions ? { providerOptions: thinkingProviderOptions } : {}),
    })

    // Plugin hook: loop step ending
    await fireHook("loop.step.after", { sessionId: currentSessionId, step, result })

    // 7. Decide next action
    if (result === "continue") continue
    break // "stop"
  }
}

// ---------------------------------------------------------------------------
// resolveModel — get the AI SDK LanguageModel
//
// kind: "main" (default) uses main_model from config
//        "small" uses small_model (for lightweight tasks like title generation)
//
// If opt.model is explicitly provided, it always wins over config.
// ---------------------------------------------------------------------------
export async function resolveModel(
  opt?: { provider: string; model: string },
  kind: "main" | "small" = "main",
) {
  // Parse namespaced model spec (e.g. "copilot/claude-sonnet-4.6")
  // Provider embedded in model spec wins over opt.provider and config default
  let providerId: string
  let modelId: string

  if (opt?.model) {
    const parsed = parseModelSpec(opt.model)
    modelId = parsed.model
    providerId = parsed.provider ?? opt.provider ?? getProviderId(kind)
  } else {
    modelId = getModelId(kind)
    providerId = opt?.provider ?? getProviderId(kind)
  }

  let provider
  // Plugin hook: allow plugins to intercept/modify provider+model before creating the AI SDK object
  const beforeOutput = await fireHook("provider.request.before", {
    provider: providerId,
    model: modelId,
    messages: [],
  }, { provider: providerId, model: modelId })
  providerId = beforeOutput.provider
  modelId = beforeOutput.model

  if (providerId === "copilot") {
    const getToken = async () => {
      const token = loadToken()
      if (!token) {
        throw new Error(
          "No Copilot token found. Run the login flow first (scripts/auth/copilot-login.ts).",
        )
      }
      return token
    }

    // Use the native Anthropic Messages API (via @ai-sdk/anthropic) for Claude models
    // when thinking is enabled — this endpoint returns thinking_delta events.
    if (isClaude(modelId) && getCopilotThinkingBudget() > 0) {
      const anthropicProvider = createCopilotAnthropicProvider({ getToken })
      return anthropicProvider(modelId)
    }

    // All other Copilot models use the OpenAI-compat Chat/Responses API
    provider = createCopilotProvider({ getToken })
  } else {
    const pc = getProviderConfig(providerId)
    if (!pc) {
      throw new Error(
        `Unknown provider "${providerId}". Define it in ~/.config/quark/config.yaml under "providers:".`,
      )
    }
    provider = createOpenAICompatibleProvider({
      name: providerId,
      baseURL: pc.baseURL,
      apiKey: resolveApiKey(pc.apiKey),
    })
  }

  return getModel(provider, modelId)
}

// ---------------------------------------------------------------------------
// resolveToolSet — convert our ToolDef[] to AI SDK ToolSet
// ---------------------------------------------------------------------------
function resolveToolSet(
  agent: AgentConfig,
  sessionId: string,
  messageId: string,
  abort: AbortSignal,
  messages: any[],
): ToolSet {
  const defs = resolveTools(agent.tools)
  const result: ToolSet = {}

  for (const def of defs) {
    result[def.id] = toAITool(def, sessionId, messageId, abort, messages)
  }

  return result
}

// ---------------------------------------------------------------------------
// toAITool — convert a single ToolDef to an AI SDK tool()
// ---------------------------------------------------------------------------
function toAITool(
  def: ToolDef,
  sessionId: string,
  messageId: string,
  abort: AbortSignal,
  messages: any[],
) {
  const schema = z.toJSONSchema(def.parameters)

  return tool({
    description: def.description,
    inputSchema: jsonSchema(schema as any),
    async execute(args: any, options: ToolExecutionOptions) {
      const ctx = {
        sessionId,
        messageId,
        callId: options.toolCallId,
        abort: options.abortSignal ?? abort,
        messages,
        async ask(permission: string, pattern: string) {
          await askPermission({
            sessionId,
            permission,
            pattern,
            ruleset: [], // TODO: load project/config rules when config system exists
          })
        },
      }
      // Plugin hooks: before/after tool execution
      const beforeArgs = await fireHook("tool.execute.before", { tool: def.id, args }, { args })
      const toolResult = await def.execute(beforeArgs.args as typeof args, ctx)
      await fireHook("tool.execute.after", { tool: def.id, args: beforeArgs.args, result: (toolResult as any).output ?? "" })
      return toolResult
    },
    toModelOutput(result: any) {
      return {
        type: "text" as const,
        value: result.output as string,
      }
    },
  })
}
