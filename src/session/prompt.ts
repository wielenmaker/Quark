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
import { saveUserMessage, createAssistantMessage, loadMessages, toModelMessages } from "./message"
import { buildSystem } from "./system"
import { processStream } from "./processor"
import { shouldCompact, compact } from "./compaction"
import { generateSessionTitle } from "./title"
import { list as listTools, resolve as resolveTools } from "../tool/registry"
import { getModel, createCopilotProvider } from "../provider/provider"
import { loadToken } from "../provider/copilot-auth"
import { defaultAgent, type AgentConfig } from "../agent"
import type { ToolDef, ToolResult } from "../tool/tool"
import {
  ask as askPermission,
  evaluate as evaluatePermission,
  type Ruleset,
  DeniedError,
  RejectedError,
  CorrectedError,
} from "../permission/permission"
import { bus } from "./events"

// ---------------------------------------------------------------------------
// Active sessions — track abort controllers so we can cancel
// ---------------------------------------------------------------------------
const active = new Map<string, AbortController>()

// ---------------------------------------------------------------------------
// prompt() — public entry point
// ---------------------------------------------------------------------------
export async function prompt(input: {
  sessionId?: string
  parts: { type: "text"; text: string }[]
  model?: { provider: string; model: string }
  agent?: AgentConfig
}) {
  const agent = input.agent ?? defaultAgent

  // Resolve or create session
  let sessionId: string
  if (input.sessionId) {
    getSession(input.sessionId) // throws if missing
    sessionId = input.sessionId
  } else {
    const sess = createSession()
    sessionId = sess.id
  }

  touchSession(sessionId)

  // Save user message (concatenate all text parts)
  const text = input.parts.map((p) => p.text).join("\n")
  saveUserMessage({ sessionId, text })
  bus.emit("user-message", { sessionId, messageId: "", text })

  // Enter the loop
  const controller = new AbortController()
  active.set(sessionId, controller)
  bus.emit("loop-start", { sessionId })
  try {
    await loop(sessionId, controller.signal, agent, input.model, text)
  } finally {
    active.delete(sessionId)
    bus.emit("loop-end", { sessionId })
  }

  return { sessionId }
}

// ---------------------------------------------------------------------------
// cancel() — abort a running session
// ---------------------------------------------------------------------------
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
  const model = await resolveModel(modelOpt)

  let step = 0
  while (true) {
    if (abort.aborted) break
    step++

    // Safety: prevent runaway loops
    if (step > agent.maxSteps) break

    // 1. Load conversation history
    const { messages, parts } = loadMessages(sessionId)
    const modelMessages = toModelMessages(messages, parts)

    // 2. Build system prompt
    const system = buildSystem(agent)

    // 3. Create assistant message row
    const assistantMsg = createAssistantMessage({
      sessionId,
      modelId: modelOpt?.model,
      providerId: modelOpt?.provider ?? "copilot",
    })
    bus.emit("assistant-message-start", { sessionId, messageId: assistantMsg.id })

    // 4. Resolve tools with correct context for this iteration
    const tools = resolveToolSet(agent, sessionId, assistantMsg.id, abort, modelMessages)

    // 5. Stream + process
    const result = await processStream({
      model,
      system,
      messages: modelMessages,
      tools,
      abort,
      msg: assistantMsg,
      sessionId,
    })

    // 6. Check if compaction is needed (before deciding next action)
    if (result === "continue" || result === "stop") {
      const latest = loadMessages(sessionId)
      if (shouldCompact(latest.parts, agent.contextLimitTokens)) {
        await compact({ sessionId, model, abort })
      }
    }

    // 7. Decide next action
    if (result === "continue") continue
    break // "stop"
  }
}

// ---------------------------------------------------------------------------
// resolveModel — get the AI SDK LanguageModel
// ---------------------------------------------------------------------------
export async function resolveModel(opt?: { provider: string; model: string }) {
  // Validate that a token exists at startup
  const initial = loadToken()
  if (!initial) {
    throw new Error(
      "No Copilot token found. Run the login flow first (scripts/copilot-login.ts).",
    )
  }

  // Pass a callback that re-reads token on each request (avoids stale closures)
  const provider = createCopilotProvider({
    getToken: async () => {
      const token = loadToken()
      if (!token) throw new Error("Copilot token expired or removed.")
      return token
    },
  })

  return getModel(provider, opt?.model)
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
      return def.execute(args, ctx)
    },
    toModelOutput(result: any) {
      return {
        type: "text" as const,
        value: result.output as string,
      }
    },
  })
}
