/**
 * ChatGPT Consumer API Provider
 * Custom AI SDK v3 provider that streams from chatgpt.com/backend-api/codex/responses
 * using a consumer JWT (ChatGPT Plus/Pro subscription token).
 */

import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import { generateId } from "ai"
import type { FetchFn } from "./codex-auth"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodexConsumerOptions {
	modelId: string
	jwt?: string
	accountId?: string
	getToken?: () => Promise<string>
	getAccountId?: () => Promise<string>
	fetch?: FetchFn
	maxRetries?: number
}

interface CodexRequestBody {
	model: string
	store: boolean
	stream: boolean
	instructions?: string
	input: unknown[]
	text?: { verbosity?: string }
	include?: string[]
	tools?: unknown[]
	tool_choice?: string
	parallel_tool_calls?: boolean
	temperature?: number
	previous_response_id?: string
	prompt_cache_key?: string
	service_tier?: "priority" | "default"
	reasoning?: { effort?: string; summary?: string; mode?: string; context?: string }
}

// ---------------------------------------------------------------------------
// Responses Lite transport
// ---------------------------------------------------------------------------

/**
 * Models requiring the "Responses Lite" transport (Codex CLI 0.144+ format):
 * tools/instructions move into the `input` array as developer items, plus
 * compatibility headers and a stable UUIDv7 session identity.
 *
 * gpt-5.6-terra and gpt-5.6-sol currently still work via the legacy format —
 * add them to this set if their legacy path breaks. Remove this entirely if
 * the backend starts accepting the legacy format for luna.
 *
 * See Quark #159 and the reference implementation in opencode PR #36143.
 */
const RESPONSES_LITE_MODELS = new Set(["gpt-5.6-luna"])

/** Codex CLI release that introduced Responses Lite; sent as the `version` header. */
const CODEX_CLI_VERSION = "0.144.0"

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp + random, portable (no Bun API). */
function uuidv7(): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	const ts = BigInt(Date.now())
	bytes[0] = Number((ts >> 40n) & 0xffn)
	bytes[1] = Number((ts >> 32n) & 0xffn)
	bytes[2] = Number((ts >> 24n) & 0xffn)
	bytes[3] = Number((ts >> 16n) & 0xffn)
	bytes[4] = Number((ts >> 8n) & 0xffn)
	bytes[5] = Number(ts & 0xffn)
	bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
	bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Adapt a legacy request body to the Responses Lite format. Pure function:
 * the legacy builder stays untouched, and this is trivially deletable once
 * the transport situation stabilizes.
 */
function toResponsesLite(body: CodexRequestBody): CodexRequestBody {
	const input: unknown[] = [
		// Always present, even with no tools — the backend expects the item.
		{ type: "additional_tools", role: "developer", tools: body.tools ?? [] },
	]
	if (body.instructions) {
		input.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: body.instructions }],
		})
	}
	input.push(...body.input.map((item) => stripImageDetail(item)))

	const lite: CodexRequestBody = {
		...body,
		input,
		tool_choice: "auto",
		parallel_tool_calls: false,
		reasoning: { ...body.reasoning, context: "all_turns" },
	}
	delete lite.tools
	delete lite.instructions
	return lite
}

/** Recursively remove `detail` from `input_image` parts (Lite rejects it). */
function stripImageDetail(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((v) => stripImageDetail(v))
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>
		const copy: Record<string, unknown> = {}
		for (const [key, val] of Object.entries(record)) {
			if (key === "detail" && record.type === "input_image") continue
			copy[key] = stripImageDetail(val)
		}
		return copy
	}
	return value
}

function applyLiteHeaders(h: Headers, sessionId: string): void {
	h.set("version", CODEX_CLI_VERSION)
	h.set("x-openai-internal-codex-responses-lite", "true")
	h.set("session-id", sessionId)
	h.set("x-session-affinity", sessionId)
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createCodexConsumer(options: CodexConsumerOptions): LanguageModelV3 {
	const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis) as FetchFn
	const maxRetries = options.maxRetries ?? 0
	// Stable per provider instance: used as prompt_cache_key for all requests and
	// as the Lite transport's session-id/x-session-affinity identity.
	const sessionId = uuidv7()

	return {
		specificationVersion: "v3",
		provider: "codex-consumer",
		modelId: options.modelId,
		supportedUrls: {},

		async doGenerate(opts: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			const streamResult = await this.doStream(opts)
			const reader = streamResult.stream.getReader()
			const parts: LanguageModelV3StreamPart[] = []
			let text = ""
			let finishReason: LanguageModelV3GenerateResult["finishReason"] = { unified: "stop", raw: undefined }
			let usage: LanguageModelV3GenerateResult["usage"] = {
				inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 0, text: 0, reasoning: 0 },
			}
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					parts.push(value)
					if (value.type === "text-delta") {
						text += value.delta
					}
					if (value.type === "finish") {
						finishReason = value.finishReason
						usage = value.usage
					}
				}
			} finally {
				reader.releaseLock()
			}
			return {
				content: [{ type: "text", text }],
				finishReason,
				usage,
				warnings: [],
			}
		},

		async doStream(opts: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
			const jwt = options.jwt ?? (await options.getToken!())
			const accountId = options.accountId ?? (await options.getAccountId!())
			let body = buildRequestBody(options.modelId, opts)
			body.prompt_cache_key = sessionId
			const headers = buildHeaders(jwt, accountId)
			if (RESPONSES_LITE_MODELS.has(options.modelId)) {
				body = toResponsesLite(body)
				applyLiteHeaders(headers, sessionId)
			}

			const response = await fetchWithRetry(
				"https://chatgpt.com/backend-api/codex/responses",
				{
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: opts.abortSignal,
				},
				baseFetch,
				maxRetries,
			)

			const stream = new ReadableStream<LanguageModelV3StreamPart>({
				async start(controller) {
					const reader = response.body!.getReader()
					const decoder = new TextDecoder()
					const mapper = new CodexStreamMapper()
					let buffer = ""
					let readerDone = false
					let aborted = false
					let closed = false

					const onAbort = () => {
						aborted = true
						void reader.cancel().catch(() => {})
					}
					opts.abortSignal?.addEventListener("abort", onAbort, { once: true })

					const closeIfNeeded = () => {
						if (!closed) {
							closed = true
							controller.close()
						}
					}

					try {
						while (!readerDone && !aborted) {
							const { value, done } = await reader.read()
							if (aborted) break
							if (done) {
								readerDone = true
								break
							}
							buffer += decoder.decode(value, { stream: true })

							let idx = buffer.indexOf("\n\n")
							while (idx !== -1) {
								const chunk = buffer.slice(0, idx)
								buffer = buffer.slice(idx + 2)

								const dataLines = chunk
									.split("\n")
									.filter((l) => l.startsWith("data:"))
									.map((l) => l.slice(5).trim())

								for (const data of dataLines) {
									if (!data || data === "[DONE]") continue
									for (const part of mapper.map(data)) {
										controller.enqueue(part)
										if (part.type === "finish" || part.type === "error") {
											closeIfNeeded()
											return
										}
									}
								}
								idx = buffer.indexOf("\n\n")
							}
						}

						// Flush any remaining data in buffer (no trailing \n\n)
						if (buffer.trim().length > 0) {
							const dataLines = buffer
								.split("\n")
								.filter((l) => l.startsWith("data:"))
								.map((l) => l.slice(5).trim())
							for (const data of dataLines) {
								if (!data || data === "[DONE]") continue
								for (const part of mapper.map(data)) {
									controller.enqueue(part)
									if (part.type === "finish" || part.type === "error") {
										closeIfNeeded()
										return
									}
								}
							}
						}

						closeIfNeeded()
					} catch (err) {
						if (!aborted) {
							controller.error(err)
						}
					} finally {
						opts.abortSignal?.removeEventListener("abort", onAbort)
						try {
							await reader.cancel()
						} catch {}
						try {
							reader.releaseLock()
						} catch {}
					}
				},
			})

			return { stream }
		},
	}
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function buildRequestBody(modelId: string, opts: LanguageModelV3CallOptions): CodexRequestBody {
	const systemParts = opts.prompt.filter((m) => m.role === "system")
	const nonSystemParts = opts.prompt.filter((m) => m.role !== "system")

	const instructions = systemParts
		.map((m) => {
			if (typeof m.content === "string") return m.content
			if (Array.isArray(m.content)) {
				return (m.content as Array<{ type: string; text?: string }>)
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n")
			}
			return ""
		})
		.join("\n")
		.trim()

	const input: unknown[] = []
	for (const m of nonSystemParts) {
		if (m.role === "user") {
			if (typeof m.content === "string") {
				input.push({ role: "user", content: m.content })
				continue
			}
			if (Array.isArray(m.content)) {
				const hasImages = m.content.some(
					(c) => c.type === "file" && (c as { mediaType?: string }).mediaType?.startsWith("image/"),
				)
				if (!hasImages) {
					const text = m.content
						.filter((c) => c.type === "text")
						.map((c) => (c as { text: string }).text)
						.join("")
					input.push({ role: "user", content: text })
					continue
				}
				const parts = m.content
					.map((c) => {
						if (c.type === "text") {
							return { type: "input_text", text: (c as { text: string }).text }
						}
						if (c.type === "file") {
							const f = c as { data: string | Uint8Array; mediaType: string }
							let imageUrl: string
							if (typeof f.data === "string") {
								// Base64 string or URL
								imageUrl = f.data.startsWith("http") ? f.data : `data:${f.mediaType};base64,${f.data}`
							} else {
								// Uint8Array → base64
								imageUrl = `data:${f.mediaType};base64,${Buffer.from(f.data).toString("base64")}`
							}
							return {
								type: "input_image",
								detail: "auto",
								image_url: imageUrl,
							}
						}
						return null
					})
					.filter(Boolean)
				input.push({ role: "user", content: parts })
				continue
			}
			input.push(m)
			continue
		}
		if (m.role === "assistant") {
			if (Array.isArray(m.content)) {
				const textParts = m.content
					.filter((c) => c.type === "text")
					.map((c) => ({ type: "output_text", text: (c as { text: string }).text }))
				if (textParts.length > 0) {
					input.push({ role: "assistant", content: textParts })
				}
				for (const c of m.content) {
					if (c.type === "tool-call") {
						const tc = c as { toolCallId: string; toolName: string; input: unknown }
						input.push({
							type: "function_call",
							call_id: tc.toolCallId,
							name: tc.toolName,
							arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
						})
					}
				}
			}
			continue
		}
		if (m.role === "tool") {
			const results = Array.isArray(m.content) ? m.content : []
			for (const c of results) {
				if (c.type !== "tool-result") continue
				const tr = c as { toolCallId: string; output: unknown }
				input.push({
					type: "function_call_output",
					call_id: tr.toolCallId,
					output: serializeToolOutput(tr.output),
				})
			}
			continue
		}
		input.push(m)
	}

	const body: CodexRequestBody = {
		model: modelId,
		store: false,
		stream: true,
		input,
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
	}

	if (instructions.length > 0) {
		body.instructions = instructions
	}

	if (opts.tools && opts.tools.length > 0) {
		body.tools = opts.tools.map((t) => {
			if (t.type !== "function") {
				return t as unknown
			}
			const ft = t as { name: string; description?: string; inputSchema?: unknown }
			return {
				type: "function",
				name: ft.name,
				description: ft.description,
				parameters: ft.inputSchema,
			}
		})
		body.tool_choice = "auto"
		body.parallel_tool_calls = true
	}

	if (opts.temperature !== undefined) {
		body.temperature = opts.temperature
	}

	// Codex consumer API uses nested `reasoning: { effort, summary }`
	// rather than the standard OpenAI `reasoningEffort` flat field.
	const codexOpts = opts.providerOptions?.codex as Record<string, unknown> | undefined
	const serviceTier = codexOpts?.serviceTier
	if (serviceTier !== undefined) {
		if (serviceTier !== "priority" && serviceTier !== "default") {
			throw new Error("Codex serviceTier must be priority or default.")
		}
		body.service_tier = serviceTier
	}
	const reasoningEffort = codexOpts?.reasoningEffort as string | undefined
	const reasoningSummary = codexOpts?.reasoningSummary as string | undefined
	const reasoningMode = codexOpts?.reasoningMode as string | undefined
	if (reasoningEffort && reasoningEffort !== "none") {
		body.reasoning = {
			effort: reasoningEffort,
			summary: reasoningSummary ?? "auto",
			...(reasoningMode ? { mode: reasoningMode } : {}),
		}
	}

	return body
}

function serializeToolOutput(output: unknown): unknown {
	if (!output || typeof output !== "object") return String(output ?? "")
	const value = output as Record<string, unknown>
	if (
		value.type === "text" ||
		value.type === "error-text" ||
		value.type === "json" ||
		value.type === "error-json"
	) {
		return typeof value.value === "string" ? value.value : JSON.stringify(value.value)
	}
	if (value.type === "execution-denied") {
		return typeof value.reason === "string" ? value.reason : "Tool execution denied."
	}
	if (value.type === "content" && Array.isArray(value.value)) {
		return value.value
			.filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
			.map((part) => ({
				type: "input_text",
				text: String((part as Record<string, unknown>).text ?? ""),
			}))
	}
	return JSON.stringify(output)
}

function buildHeaders(jwt: string, accountId: string): Headers {
	const h = new Headers()
	h.set("Authorization", `Bearer ${jwt}`)
	h.set("chatgpt-account-id", accountId)
	h.set("originator", "pi")
	h.set("OpenAI-Beta", "responses=experimental")
	h.set("Accept", "text/event-stream")
	h.set("Content-Type", "application/json")
	return h
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

const BASE_DELAY_MS = 1000

function isRetryableError(status: number, _errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true
	}
	return false
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"))
			return
		}
		const timeout = setTimeout(resolve, ms)
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout)
			reject(new Error("Request was aborted"))
		}, { once: true })
	})
}

async function fetchWithRetry(
	url: string,
	init: RequestInit,
	fetchFn: FetchFn,
	maxRetries: number,
): Promise<Response> {
	let lastError: Error | undefined

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetchFn(url, init)

			if (response.ok) {
				return response
			}

			const errorText = await response.text().catch(() => "")

			if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
				const delayMs = BASE_DELAY_MS * 2 ** attempt
				await sleep(delayMs, init.signal as AbortSignal | undefined)
				continue
			}

			throw new Error(`Codex consumer API error: ${response.status} ${response.statusText} — ${errorText || "no details"}`)
		} catch (error) {
			if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
				throw error
			}
			// Don't retry HTTP errors we already evaluated as non-retryable
			if (error instanceof Error && error.message.startsWith("Codex consumer API error")) {
				throw error
			}
			lastError = error instanceof Error ? error : new Error(String(error))
			if (attempt < maxRetries) {
				const delayMs = BASE_DELAY_MS * 2 ** attempt
				await sleep(delayMs, init.signal as AbortSignal | undefined)
				continue
			}
			throw lastError
		}
	}

	throw lastError ?? new Error("Failed after retries")
}

// ---------------------------------------------------------------------------
// SSE event parsing
// ---------------------------------------------------------------------------

interface ActiveTool {
	id: string
	name: string
}

class CodexStreamMapper {
	private textId?: string
	private reasoningIds = new Set<string>()
	private toolsByIndex = new Map<string, ActiveTool>()
	private toolsByItem = new Map<string, ActiveTool>()
	private pendingToolDeltas = new Map<string, string[]>()
	private hasToolCall = false

	map(data: string): LanguageModelV3StreamPart[] {
		let event: Record<string, unknown>
		try {
			event = JSON.parse(data) as Record<string, unknown>
		} catch {
			return []
		}

		const type = typeof event.type === "string" ? event.type : undefined
		if (!type) return []

		if (type === "response.output_item.added") {
			return this.startItem(event)
		}

		if (type === "response.output_text.delta") {
			const id = this.ensureText(event.item_id)
			const parts: LanguageModelV3StreamPart[] = []
			if (this.textId !== id) {
				this.textId = id
				parts.push({ type: "text-start", id })
			}
			parts.push({
				type: "text-delta",
				id,
				delta: typeof event.delta === "string" ? event.delta : "",
			})
			return parts
		}

		if (
			type === "response.reasoning_text.delta" ||
			type === "response.reasoning_summary_text.delta"
		) {
			const id = this.reasoningId(event)
			const parts: LanguageModelV3StreamPart[] = []
			if (!this.reasoningIds.has(id)) {
				this.reasoningIds.add(id)
				parts.push({ type: "reasoning-start", id })
			}
			parts.push({
				type: "reasoning-delta",
				id,
				delta: typeof event.delta === "string" ? event.delta : "",
			})
			return parts
		}

		if (type === "response.function_call_arguments.delta") {
			const tool = this.findTool(event)
			const delta = typeof event.delta === "string" ? event.delta : ""
			if (!tool) {
				const key = this.toolKey(event)
				const pending = this.pendingToolDeltas.get(key) ?? []
				pending.push(delta)
				this.pendingToolDeltas.set(key, pending)
				return []
			}
			return [{ type: "tool-input-delta", id: tool.id, delta }]
		}

		if (type === "response.output_item.done") {
			return this.finishItem(event)
		}

		if (type === "response.completed" || type === "response.done") {
			return [
				...this.closeOpenParts(),
				{
					type: "finish",
					usage: type === "response.completed"
						? mapUsage((event.response as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined)
						: zeroUsage(),
					finishReason: {
						unified: this.hasToolCall ? "tool-calls" : "stop",
						raw: type === "response.completed" ? "completed" : "done",
					},
				},
			]
		}

		if (type === "response.incomplete") {
			return [
				...this.closeOpenParts(),
				{
					type: "finish",
					usage: zeroUsage(),
					finishReason: { unified: "length", raw: "incomplete" },
				},
			]
		}

		const part = parseCodexSSE(data)
		return part ? [part] : []
	}

	private startItem(event: Record<string, unknown>): LanguageModelV3StreamPart[] {
		const item = event.item as Record<string, unknown> | undefined
		if (!item) return []

		if (item.type === "message") {
			const id = String(item.id ?? generateId())
			this.textId = id
			return [{ type: "text-start", id }]
		}

		if (item.type === "reasoning") {
			const id = `${String(item.id ?? generateId())}:0`
			this.reasoningIds.add(id)
			return [{ type: "reasoning-start", id }]
		}

		if (item.type === "function_call") {
			const tool = {
				id: String(item.call_id ?? item.id ?? generateId()),
				name: String(item.name ?? ""),
			}
			this.storeTool(event, item, tool)
			return [{ type: "tool-input-start", id: tool.id, toolName: tool.name }]
		}

		return []
	}

	private finishItem(event: Record<string, unknown>): LanguageModelV3StreamPart[] {
		const item = event.item as Record<string, unknown> | undefined
		if (!item) return []

		if (item.type === "message") {
			const id = String(item.id ?? this.textId ?? generateId())
			if (this.textId === id) this.textId = undefined
			return [{ type: "text-end", id }]
		}

		if (item.type === "reasoning") {
			const prefix = `${String(item.id ?? "")}:`
			const ids = [...this.reasoningIds].filter((id) => id.startsWith(prefix))
			for (const id of ids) this.reasoningIds.delete(id)
			return ids.map((id) => ({ type: "reasoning-end", id }))
		}

		if (item.type === "function_call") {
			const existing = this.findTool(event)
			const tool = existing ?? {
				id: String(item.call_id ?? item.id ?? generateId()),
				name: String(item.name ?? ""),
			}
			const parts: LanguageModelV3StreamPart[] = []
			if (!existing) {
				parts.push({ type: "tool-input-start", id: tool.id, toolName: tool.name })
			}
			for (const delta of this.pendingToolDeltas.get(this.toolKey(event)) ?? []) {
				parts.push({ type: "tool-input-delta", id: tool.id, delta })
			}
			this.pendingToolDeltas.delete(this.toolKey(event))
			parts.push(
				{ type: "tool-input-end", id: tool.id },
				{
					type: "tool-call",
					toolCallId: tool.id,
					toolName: tool.name,
					input: String(item.arguments ?? ""),
				},
			)
			this.hasToolCall = true
			return parts
		}

		return []
	}

	private closeOpenParts(): LanguageModelV3StreamPart[] {
		const parts: LanguageModelV3StreamPart[] = []
		if (this.textId) {
			parts.push({ type: "text-end", id: this.textId })
			this.textId = undefined
		}
		for (const id of this.reasoningIds) {
			parts.push({ type: "reasoning-end", id })
		}
		this.reasoningIds.clear()
		return parts
	}

	private ensureText(itemId: unknown): string {
		return typeof itemId === "string" ? itemId : this.textId ?? generateId()
	}

	private reasoningId(event: Record<string, unknown>): string {
		if (typeof event.item_id === "string") {
			const index = typeof event.summary_index === "number" ? event.summary_index : 0
			return `${event.item_id}:${index}`
		}
		return this.reasoningIds.values().next().value ?? `${generateId()}:0`
	}

	private toolKey(event: Record<string, unknown>): string {
		if (typeof event.output_index === "number") return `index:${event.output_index}`
		if (typeof event.item_id === "string") return `item:${event.item_id}`
		return "default"
	}

	private findTool(event: Record<string, unknown>): ActiveTool | undefined {
		if (typeof event.output_index === "number") {
			const tool = this.toolsByIndex.get(String(event.output_index))
			if (tool) return tool
		}
		if (typeof event.item_id === "string") {
			return this.toolsByItem.get(event.item_id)
		}
		return undefined
	}

	private storeTool(
		event: Record<string, unknown>,
		item: Record<string, unknown>,
		tool: ActiveTool,
	): void {
		if (typeof event.output_index === "number") {
			this.toolsByIndex.set(String(event.output_index), tool)
		}
		if (typeof item.id === "string") {
			this.toolsByItem.set(item.id, tool)
		}
	}
}

export function parseCodexSSE(data: string): LanguageModelV3StreamPart | null {
	let event: Record<string, unknown>
	try {
		event = JSON.parse(data) as Record<string, unknown>
	} catch {
		return null
	}

	const type = typeof event.type === "string" ? event.type : undefined
	if (!type) return null

	const id = generateId()

	switch (type) {
		case "response.output_text.delta": {
			const delta = typeof event.delta === "string" ? event.delta : ""
			return { type: "text-delta", id, delta }
		}

		case "response.reasoning_text.delta": {
			const delta = typeof event.delta === "string" ? event.delta : ""
			return { type: "reasoning-delta", id, delta }
		}

		case "response.function_call_arguments.delta": {
			const delta = typeof event.delta === "string" ? event.delta : ""
			return { type: "tool-input-delta", id, delta }
		}

		case "response.output_item.done": {
			const item = event.item as Record<string, unknown> | undefined
			if (item && item.type === "function_call") {
				return {
					type: "tool-call",
					toolCallId: String(item.id ?? generateId()),
					toolName: String(item.name ?? ""),
					input: String(item.arguments ?? ""),
				}
			}
			return null
		}

		case "response.completed": {
			const response = event.response as Record<string, unknown> | undefined
			const usage = response?.usage as Record<string, unknown> | undefined
			return {
				type: "finish",
				usage: mapUsage(usage),
				finishReason: { unified: "stop", raw: "completed" },
			}
		}

		case "response.done": {
			return {
				type: "finish",
				usage: zeroUsage(),
				finishReason: { unified: "stop", raw: "done" },
			}
		}

		case "response.incomplete": {
			return {
				type: "finish",
				usage: zeroUsage(),
				finishReason: { unified: "length", raw: "incomplete" },
			}
		}

		case "response.failed": {
			return { type: "error", error: new Error(codexErrorMessage(event, "Codex response failed")) }
		}

		case "error": {
			return { type: "error", error: new Error(codexErrorMessage(event, "Codex error")) }
		}

		default:
			return null
	}
}

function codexErrorMessage(event: Record<string, unknown>, fallback: string): string {
	if (typeof event.message === "string") return event.message
	if (typeof event.error === "string") return event.error
	const error = event.error as Record<string, unknown> | undefined
	if (typeof error?.message === "string") return error.message
	const response = event.response as Record<string, unknown> | undefined
	const responseError = response?.error as Record<string, unknown> | undefined
	return typeof responseError?.message === "string" ? responseError.message : fallback
}

function mapUsage(usage?: Record<string, unknown>): LanguageModelV3StreamPart & { type: "finish" } extends infer U ? (U extends { usage: infer V } ? V : never) : never {
	const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0
	const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0
	const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined
	const outputDetails = usage?.output_tokens_details as Record<string, unknown> | undefined
	const cacheRead = typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0
	const cacheWrite = typeof inputDetails?.cache_write_tokens === "number" ? inputDetails.cache_write_tokens : 0
	const reasoning = typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : 0
	return {
		inputTokens: {
			total: inputTokens,
			noCache: Math.max(0, inputTokens - cacheRead - cacheWrite),
			cacheRead,
			cacheWrite,
		},
		outputTokens: { total: outputTokens, text: Math.max(0, outputTokens - reasoning), reasoning },
		raw: usage ?? {},
	} as any
}

function zeroUsage(): any {
	return {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	}
}
