// Stream event handler — consume LLM stream, persist parts, emit events
//
// Calls streamText() and iterates over fullStream events:
// - text-start/delta/end → persist text parts + emit to bus
// - tool-input-start/delta/end + tool-call → persist tool parts + emit
// - tool-result/tool-error → update tool parts with output + emit
// - start-step/finish-step → persist step metadata + emit
// - error → check retryable, throw otherwise
//
// Returns "continue" if the last finish reason was "tool-calls" (so the
// agent loop re-invokes the LLM), or "stop" otherwise.

import { streamText, type ModelMessage, type LanguageModel, type ToolSet } from "ai"
import { generateId } from "ai"
import type { JSONObject } from "@ai-sdk/provider"
import {
  addPart,
  updatePart,
  finishMessage,
  type MessageRow,
  type TextPartData,
  type ToolPartData,
  type StepFinishData,
  type ReasoningPartData,
} from "./message"
import { isRetryable, isContextTooLong, retryDelay, extractRetryAfter, sleep } from "./retry"
import { isOverContextThreshold, getContextWindow } from "./context"
import { bus, TypedBus } from "./events"
import type { SessionStore } from "./store"
import { globalHooks, type HookRegistry } from "../plugin/registry"
import { PORTABLE_POLICIES, type BranchingConfig } from "./policies"
import type { ResolvedModel } from "../provider/resolver"
import {
  addTokenUsage,
  aggregateCharges,
  calculateCharge,
  normalizeUsage,
  numericAggregateCost,
  type Charge,
  type TokenUsage,
} from "./accounting"
import { debug } from "../debug"

const dlog = debug("processor")

export interface ProcessInput {
  model: LanguageModel
  resolvedModel?: ResolvedModel
  system: string[]
  messages: ModelMessage[]
  tools: ToolSet
  abort: AbortSignal
  msg: MessageRow
  sessionId: string
  /** ID of the user message that initiated this turn. */
  userMessageId: string
  maxOutputTokens?: number
  /** Provider ID for plugin hooks (e.g. "copilot", "ollama") */
  providerId?: string
  /** Model ID for plugin hooks (e.g. "claude-sonnet-4.6") */
  modelId?: string
  /** Provider-specific options (e.g. thinking budget for Anthropic) */
  providerOptions?: Record<string, JSONObject>
  /**
   * Branching policy for the mid-stream overflow check. Omit to keep the
   * implicit config-file behavior; portable runners pass their own policy.
   */
  branching?: BranchingConfig
  /**
   * Optional callback so provider.request.error plugins can switch provider/model
   * without creating a circular import between processor and prompt.
   */
  rebuildModel?: (provider: string, model: string) => Promise<{
    resolvedModel: ResolvedModel
    providerOptions?: Record<string, JSONObject>
  }>
  /**
   * @internal Event bus for this run. Defaults to the singleton `bus` so the
   * legacy CLI/TUI path is unchanged; instance runners pass their own.
   */
  bus?: TypedBus
  /**
   * @internal Hook registry for this run. Defaults to the process-global
   * registry (legacy path); instance runners pass their own.
   */
  hooks?: HookRegistry
  /**
   * @internal Persistence store for this run. Defaults to the legacy JSONL
   * store; instance runners pass their own (portable default: in-memory).
   */
  store?: SessionStore
  /**
   * @internal Streaming primitive override. Defaults to the AI SDK's
   * `streamText`; a minimal seam for tests and custom transports.
   */
  stream?: StreamFn
}

/** The slice of a streaming primitive that {@link processStream} consumes. */
export type StreamFn = (options: any) => { fullStream: AsyncIterable<any> }

// Some providers do not settle their stream iterator after abort. Do not let a
// stalled next() keep the turn (and the TUI's loop-end) alive indefinitely.
async function* abortableStream(stream: AsyncIterable<any>, signal: AbortSignal): AsyncGenerator<any> {
  const iterator = stream[Symbol.asyncIterator]()
  let onAbort: (() => void) | undefined
  let completed = false
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("This operation was aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) {
        completed = true
        return
      }
      yield next.value
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
    // Never await return(): an uncooperative iterator can stall there too.
    if (!completed && iterator.return) void Promise.resolve().then(() => iterator.return!()).catch(() => {})
  }
}

export async function processStream(input: ProcessInput): Promise<"stop" | "continue" | "branch"> {
  // Track tool parts by callId so we can update them as events arrive
  const toolParts = new Map<string, { partId: string; data: ToolPartData }>()
  // Raw JSON argument text accumulated per callId while the model writes a
  // tool call. Display-only (bus "tool-input-draft"); never persisted, and
  // dropped as soon as the parsed tool-call replaces it.
  const toolDrafts = new Map<string, string>()
  let currentText: { partId: string; data: TextPartData } | undefined
  let currentReasoning: { partId: string; data: ReasoningPartData } | undefined
  let lastFinish: string | undefined
  let needsBranch = false
  const aggregateTokens: TokenUsage = {}
  const charges: Charge[] = []
  let attempt = 0
  const maxRetries = 5

  const sid = input.sessionId
  const mid = input.msg.id
  const userMessageId = input.userMessageId
  const eventBus = input.bus ?? bus
  const hooks = input.hooks ?? globalHooks
  const store = input.store
  const runStream = input.stream ?? streamText

  while (true) {
    try {
      const result = runStream({
        model: input.resolvedModel?.languageModel ?? input.model,
        messages: [
          ...input.system.map(
            (s): ModelMessage => ({ role: "system", content: s }),
          ),
          ...input.messages,
        ],
        tools: input.tools,
        abortSignal: input.abort,
        maxOutputTokens: input.maxOutputTokens,
        maxRetries: 0,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      })

      for await (const event of abortableStream(result.fullStream, input.abort)) {
        input.abort.throwIfAborted()

        if (dlog.enabled) {
          dlog("event:", event.type, event.type === "finish-step" ? `(reason=${(event as any).finishReason})` : "")
        }

        switch (event.type) {
          case "start":
            break

          case "text-start": {
            const data: TextPartData = { text: "" }
            const partId = addPart({
              messageId: mid,
              sessionId: sid,
              type: "text",
              data,
              store,
            })
            currentText = { partId, data }
            eventBus.emit("text-start", { sessionId: sid, messageId: mid, partId })
            break
          }

          case "text-delta": {
            if (currentText) {
              currentText.data.text += event.text
              eventBus.emit("text-delta", {
                sessionId: sid,
                messageId: mid,
                partId: currentText.partId,
                delta: event.text,
                text: currentText.data.text,
              })
            }
            break
          }

          case "text-end": {
            if (currentText) {
              currentText.data.text = currentText.data.text.trimEnd()
              updatePart(currentText.partId, currentText.data, sid, mid, "text", store)
              eventBus.emit("text-end", {
                sessionId: sid,
                messageId: mid,
                partId: currentText.partId,
                text: currentText.data.text,
              })
              currentText = undefined
            }
            break
          }

          case "tool-input-start": {
            // Create a pending tool part
            const data: ToolPartData = {
              tool: event.toolName,
              callId: event.id,
              status: "pending",
              input: {},
            }
            const partId = addPart({
              messageId: mid,
              sessionId: sid,
              type: "tool",
              data,
              store,
            })
            toolParts.set(event.id, { partId, data })
            toolDrafts.set(event.id, "")
            eventBus.emit("tool-start", {
              sessionId: sid,
              messageId: mid,
              partId,
              tool: event.toolName,
              callId: event.id,
            })
            break
          }

          case "tool-input-delta": {
            // Streaming argument text: relay the accumulated draft so the UI
            // can show the model writing it. Final args still arrive via
            // "tool-call", which replaces the draft.
            const match = toolParts.get(event.id)
            const delta = typeof event.delta === "string" ? event.delta : ""
            if (match && delta) {
              const text = (toolDrafts.get(event.id) ?? "") + delta
              toolDrafts.set(event.id, text)
              eventBus.emit("tool-input-draft", {
                sessionId: sid,
                messageId: mid,
                partId: match.partId,
                tool: match.data.tool,
                callId: event.id,
                text,
              })
            }
            break
          }

          case "tool-input-end":
            break

          case "tool-call": {
            const match = toolParts.get(event.toolCallId)
            if (match) {
              match.data.status = "pending"
              match.data.input = event.input as Record<string, unknown>
              match.data.tool = event.toolName

              updatePart(match.partId, match.data, sid, mid, "tool", store)
              eventBus.emit("tool-input", {
                sessionId: sid,
                messageId: mid,
                partId: match.partId,
                tool: event.toolName,
                callId: event.toolCallId,
                input: match.data.input,
              })
              toolDrafts.delete(event.toolCallId)
            }
            break
          }

          case "tool-result": {
            const match = toolParts.get(event.toolCallId)
            if (match) {
              match.data.status = "completed"
              match.data.input = (event.input as Record<string, unknown>) ?? match.data.input
              // Extract output text from the tool result
              const out = event.output as any
              match.data.output = extractOutput(out)
              // Store multi-modal content parts if the output is an array
              const contentParts = extractContentParts(out)
              if (contentParts) {
                match.data.contentParts = contentParts
              }
              // Extract diff from metadata if present
              const diff = extractDiff(out)
              const subAgent = extractSubAgentMetadata(out)
              if (subAgent) match.data.subAgent = subAgent
              updatePart(match.partId, match.data, sid, mid, "tool", store)
              eventBus.emit("tool-end", {
                sessionId: sid,
                messageId: mid,
                partId: match.partId,
                tool: match.data.tool,
                callId: event.toolCallId,
                status: "completed",
                output: match.data.output,
                diff,
              })
              toolParts.delete(event.toolCallId)
              toolDrafts.delete(event.toolCallId)
            }
            break
          }

          case "tool-error": {
            const match = toolParts.get(event.toolCallId)
            if (match) {
              match.data.status = "error"
              match.data.input = (event.input as Record<string, unknown>) ?? match.data.input
              match.data.error = String(event.error)
              updatePart(match.partId, match.data, sid, mid, "tool", store)
              eventBus.emit("tool-end", {
                sessionId: sid,
                messageId: mid,
                partId: match.partId,
                tool: match.data.tool,
                callId: event.toolCallId,
                status: "error",
                error: match.data.error,
              })
              toolParts.delete(event.toolCallId)
              toolDrafts.delete(event.toolCallId)
            }
            break
          }

          case "start-step": {
            addPart({
              messageId: mid,
              sessionId: sid,
              type: "step-start",
              data: {},
              store,
            })
            eventBus.emit("step-start", { sessionId: sid, messageId: mid })
            break
          }

          case "finish-step": {
            lastFinish = event.finishReason
            const usage = event.usage
            const normalized = normalizeUsage(usage)
            const runtime = input.resolvedModel
            const charge = runtime
              ? calculateCharge(normalized.tokens, runtime.pricingSnapshot)
              : { kind: "unknown" as const, reason: "runtime pricing unavailable" }
            const contextWindow = getContextWindow(runtime?.catalogModel.limit ?? null)
            const stepData: StepFinishData = {
              reason: event.finishReason,
              ...(runtime ? {
                model: runtime.ref,
                pricingSnapshot: runtime.pricingSnapshot,
              } : {}),
              tokens: normalized.tokens,
              ...(normalized.rawUsage ? { rawUsage: normalized.rawUsage } : {}),
              charge,
              // Persisted so a later `session/load` can replay the meter.
              ...(contextWindow > 0 ? { contextWindow } : {}),
            }
            addPart({
              messageId: mid,
              sessionId: sid,
              type: "step-finish",
              data: stepData,
              store,
            })
            eventBus.emit("step-finish", {
              sessionId: sid,
              messageId: mid,
              data: stepData,
              // The ACP bridge turns this into `usage_update`; without the window
              // size it must stay silent rather than send `size: 0`.
              contextWindow,
            })

            addTokenUsage(aggregateTokens, normalized.tokens)
            charges.push(charge)

            // Mid-stream overflow check: if the input tokens from this step
            // exceed the branching threshold, stop before the next tool round.
            if (!needsBranch && usage?.inputTokens) {
              const branching = input.branching ?? PORTABLE_POLICIES.branching
              if (branching.auto) {
                const modelLimit = input.resolvedModel?.catalogModel.limit ?? null
                const ctxWindow = getContextWindow(modelLimit)

                if (ctxWindow > 0 && isOverContextThreshold(usage.inputTokens, ctxWindow, branching.threshold)) {
                  needsBranch = true
                }
              }
            }
            break
          }

          case "error": {
            // Responses API via Copilot emits non-fatal "text part <id> not found"
            // errors interleaved with valid output. These are SDK parsing artifacts
            // from opaque Copilot part IDs — safe to ignore.
            const errMsg = String(event.error)
            if (/text part .+ not found/.test(errMsg)) break
            throw event.error
          }

          case "finish":
            break

          // reasoning events — persist and emit to bus for TUI rendering
          case "reasoning-start": {
            const data: ReasoningPartData = { text: "" }
            const partId = addPart({
              messageId: mid,
              sessionId: sid,
              type: "reasoning",
              data,
              store,
            })
            currentReasoning = { partId, data }
            eventBus.emit("reasoning-start", { sessionId: sid, messageId: mid, partId })
            break
          }

          case "reasoning-delta": {
            if (currentReasoning) {
              currentReasoning.data.text += event.text
              eventBus.emit("reasoning-delta", {
                sessionId: sid,
                messageId: mid,
                partId: currentReasoning.partId,
                delta: event.text,
                text: currentReasoning.data.text,
              })
            }
            break
          }

          case "reasoning-end": {
            if (currentReasoning) {
              updatePart(currentReasoning.partId, currentReasoning.data, sid, mid, "reasoning", store)
              eventBus.emit("reasoning-end", {
                sessionId: sid,
                messageId: mid,
                partId: currentReasoning.partId,
              })
              currentReasoning = undefined
            }
            break
          }

          default:
            break
        }

        // Mid-stream branching: if finish-step set needsBranch, stop
        // consuming the stream before the next tool round begins.
        if (needsBranch) break
      }
    } catch (e: any) {
      // Mark any in-flight tool parts as errored and notify the TUI via bus
      for (const [callId, entry] of toolParts) {
        if (entry.data.status === "pending" || entry.data.status === "running") {
          entry.data.status = "error"
          entry.data.error = "Tool execution aborted"
          updatePart(entry.partId, entry.data, sid, mid, "tool", store)
          eventBus.emit("tool-end", {
            sessionId: sid,
            messageId: mid,
            partId: entry.partId,
            tool: entry.data.tool,
            callId,
            status: "error",
            error: entry.data.error,
          })
        }
      }
      toolParts.clear()
      toolDrafts.clear()

      // Flush any in-progress text
      if (currentText) {
        currentText.data.text = currentText.data.text.trimEnd()
        updatePart(currentText.partId, currentText.data, sid, mid, "text", store)
        currentText = undefined
      }

      // User abort — mark the message as aborted so it's excluded from context
      if (input.abort.aborted) {
        finishMessage(mid, "aborted", undefined, sid, store)
        eventBus.emit("assistant-message-end", { sessionId: sid, messageId: mid, userMessageId, finish: "aborted" })
        return "stop"
      }

      // Context-too-long: signal the loop to branch instead of crashing
      if (isContextTooLong(e)) {
        finishMessage(mid, "stop", undefined, sid, store)
        eventBus.emit("context-too-long", { sessionId: sid, error: e })
        return "branch"
      }

      if (isRetryable(e)) {
        const serverDelay = extractRetryAfter(e)

        // If the server says wait > 5 minutes (e.g. monthly quota reset), don't retry — surface it
        if (serverDelay !== undefined && serverDelay > 5 * 60 * 1000) {
          finishMessage(mid, "stop", undefined, sid, store)
          eventBus.emit("error", { sessionId: sid, error: e, userMessageId })
          throw e
        }

        if (attempt >= maxRetries) {
          finishMessage(mid, "stop", undefined, sid, store)
          eventBus.emit("error", { sessionId: sid, error: e, userMessageId })
          throw e
        }
        attempt++
        const delay = serverDelay ?? retryDelay(attempt)
        eventBus.emit("retry", { sessionId: sid, attempt, delayMs: delay, error: e })
        await sleep(delay, input.abort).catch(() => {})
        if (input.abort.aborted) break
        continue
      }

      // Plugin hook: provider request error — plugins can request a retry with a new provider/model
      const hookOutput = await hooks.fire("provider.request.error", {
        provider: input.resolvedModel?.ref.providerId ?? input.providerId ?? "unknown",
        model: input.resolvedModel?.ref.modelId ?? input.modelId ?? "unknown",
        error: e,
        statusCode: (e as any)?.status,
      })
      if (hookOutput.retry) {
        // If the plugin wants to switch provider/model, rebuild the model
        if ((hookOutput.provider || hookOutput.model) && input.rebuildModel) {
          const newProvider = hookOutput.provider
            ?? input.resolvedModel?.ref.providerId
            ?? input.providerId
            ?? "unknown"
          const newModel = hookOutput.model
            ?? input.resolvedModel?.ref.modelId
            ?? input.modelId
            ?? "unknown"
          const rebuilt = await input.rebuildModel(newProvider, newModel)
          input.resolvedModel = rebuilt.resolvedModel
          input.model = rebuilt.resolvedModel.languageModel
          input.providerId = rebuilt.resolvedModel.ref.providerId
          input.modelId = rebuilt.resolvedModel.ref.modelId
          input.providerOptions = rebuilt.providerOptions
        }
        attempt++
        const delay = retryDelay(attempt)
        await sleep(delay, input.abort).catch(() => {})
        if (input.abort.aborted) break
        continue
      }

      // Update the message with error state
      finishMessage(mid, "stop", undefined, sid, store)
      eventBus.emit("error", { sessionId: sid, error: e, userMessageId })
      throw e
    }

    // Success path — finalize the message
    // Mid-stream branching: if we broke out of the stream because of overflow,
    // finalize the current message and signal the loop to branch.
    if (needsBranch) {
      const aggregateCharge = aggregateCharges(charges)
      finishMessage(mid, "stop", {
        ...(aggregateTokens.input !== undefined ? { tokensIn: aggregateTokens.input } : {}),
        ...(aggregateTokens.output !== undefined ? { tokensOut: aggregateTokens.output } : {}),
        ...(numericAggregateCost(aggregateCharge) !== undefined ? { cost: numericAggregateCost(aggregateCharge) } : {}),
        aggregate: { tokens: aggregateTokens, charge: aggregateCharge },
      }, sid, store)
      eventBus.emit("assistant-message-end", { sessionId: sid, messageId: mid, userMessageId, finish: "stop" })
      return "branch"
    }

    const finish = lastFinish === "tool-calls" ? "tool-calls" as const
      : lastFinish === "length" ? "length" as const
      : "stop" as const

    const aggregateCharge = aggregateCharges(charges)
    const aggregateCost = numericAggregateCost(aggregateCharge)
    finishMessage(mid, finish, {
      ...(aggregateTokens.input !== undefined ? { tokensIn: aggregateTokens.input } : {}),
      ...(aggregateTokens.output !== undefined ? { tokensOut: aggregateTokens.output } : {}),
      ...(aggregateCost !== undefined ? { cost: aggregateCost } : {}),
      aggregate: { tokens: aggregateTokens, charge: aggregateCharge },
    }, sid, store)
    eventBus.emit("assistant-message-end", { sessionId: sid, messageId: mid, userMessageId, finish })

    dlog(`stream finished: lastFinish=${lastFinish} → returning ${finish === "tool-calls" ? "continue" : "stop"}`)

    if (finish === "tool-calls") return "continue"
    return "stop"
  }

  // Should not reach here, but if abort breaks the retry loop
  if (input.abort.aborted) {
    finishMessage(mid, "aborted", undefined, sid, store)
  } else {
    finishMessage(mid, "stop", undefined, sid, store)
  }
  return "stop"
}

// Extract diff string from tool result metadata
function extractDiff(out: unknown): string | undefined {
  if (out && typeof out === "object") {
    const o = out as any
    if (typeof o.metadata?.diff === "string" && o.metadata.diff.length > 0) {
      return o.metadata.diff
    }
  }
  return undefined
}

function extractSubAgentMetadata(out: unknown): ToolPartData["subAgent"] | undefined {
  if (!out || typeof out !== "object") return undefined
  const value = (out as any).metadata?.subAgent
  if (!value || typeof value !== "object" || typeof value.profile !== "string") return undefined
  return {
    profile: value.profile,
    ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
    ...(typeof value.childSessionId === "string" ? { childSessionId: value.childSessionId } : {}),
    ...(typeof value.modelName === "string" ? { modelName: value.modelName } : {}),
    ...(typeof value.tokenLimit === "number" ? { tokenLimit: value.tokenLimit } : {}),
  }
}

// Extract string output from tool result (which may be various formats)
function extractOutput(out: unknown): string {
  if (typeof out === "string") return out
  if (out && typeof out === "object") {
    const o = out as any
    // AI SDK tool result shape: { output, title, metadata }
    if (Array.isArray(o.output)) {
      // Multi-modal content parts — extract text-only portions for the string field
      return o.output
        .filter((p: any) => p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join(" ")
    }
    if (typeof o.output === "string") return o.output
    // LanguageModelV3ToolResultOutput shape
    if (o.type === "text" && typeof o.value === "string") return o.value
    return JSON.stringify(out)
  }
  return String(out ?? "")
}

// Extract content parts array from tool result when output is multi-modal
function extractContentParts(out: unknown): any[] | undefined {
  if (out && typeof out === "object") {
    const o = out as any
    if (Array.isArray(o.output)) return o.output
  }
  return undefined
}
