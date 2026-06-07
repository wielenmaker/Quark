---
title: ChatGPT Consumer API Provider (Codex Streaming)
date_created: 2026-06-06
date_modified: 2026-06-07
revision: 7
history:
  - 2026-06-06: Initial draft
  - 2026-06-06: Verified against real API — model is gpt-5.5, not gpt-4o/o3/o4
  - 2026-06-07: Fixed tool mapping to use Responses API flat format (tools[].name instead of tools[].function.name)
  - 2026-06-07: Real API and TUI tests fixed stream lifecycles and multi-turn tool-result replay
  - 2026-06-07: Documented final implementation, boundary fixes, and verification results
  - 2026-06-07: Isolated token persistence tests from the real user credential file
  - 2026-06-07: Completed token isolation fix and verified the TUI authentication boundary
status: done
---

## Problem

Quark has working OAuth for ChatGPT Plus/Pro subscriptions (`src/provider/codex-auth.ts`). The login flow completes and a consumer JWT is persisted. However, the current `resolver.ts` routes `codex/` model specs to `api.openai.com` via `createOpenAICompatible`, which rejects the consumer token with HTTP 403 because it lacks `api.model.read` scope.

The endpoint that accepts consumer tokens is `chatgpt.com/backend-api/codex/responses`. It uses SSE (or WebSocket) streaming with the OpenAI **Responses API** request/response format, not Chat Completions. Key differences:
- Tools use flat format: `{ type: "function", name, description, parameters }` (not nested under `function:`)
- Messages go in `input` array, not `messages`
- System prompt goes in `instructions`, not `input`

## Decision

Build a custom AI SDK v3 provider that talks directly to `chatgpt.com/backend-api/codex/responses` over SSE. This keeps `processor.ts` untouched — the provider implements `LanguageModelV3.doStream()` and returns a `ReadableStream<LanguageModelV3StreamPart>` that `streamText()` consumes natively.

## Architecture

```
src/provider/
├── codex-auth.ts              (existing — JWT, refresh, device flow)
├── codex-fetch.ts             (existing — standard API fetch wrapper)
├── codex-consumer.ts          (provider, request mapping, SSE mapping)
└── resolver.ts                (routes codex/ to consumer provider)
```

### Layer 1: Auth (reuse)
`codex-auth.ts` provides `loadToken()`, `refreshToken()`. The provider extracts `accountId` from the JWT payload claim `https://api.openai.com/auth.chatgpt_account_id`.

Token persistence defaults to `~/.config/quark/codex-token.json`. Tests must
use an explicit temporary path or `QUARK_CODEX_TOKEN_FILE`; they must never
write or delete the default user credential file.

### Layer 2: Provider factory (`codex-consumer.ts`)
Implements `LanguageModelV3`:
- `provider: "codex"`
- `doStream(options)`:
  1. Convert AI SDK `prompt` to ChatGPT `input` messages
  2. Build request body: `model`, `store: false`, `stream: true`, `instructions` (system prompt), `input`, `text: { verbosity: "low" }`, `include: ["reasoning.encrypted_content"]`
  3. POST to `https://chatgpt.com/backend-api/codex/responses` with headers: `Authorization: Bearer <jwt>`, `chatgpt-account-id: <id>`, `originator: pi`, `OpenAI-Beta: responses=experimental`, `accept: text/event-stream`
  4. On non-2xx: parse error, apply retry logic for 429/5xx, then throw
  5. On 2xx: parse SSE, map each event to `LanguageModelV3StreamPart`
  6. Return `ReadableStream<LanguageModelV3StreamPart>`

### Layer 3: Prompt mapping (`codex-consumer.ts`)
The Responses API requires different item shapes for each conversation role:
- User text → `{ role: "user", content }`
- Assistant text → `{ role: "assistant", content: [{ type: "output_text", text }] }`
- Assistant tool call → `{ type: "function_call", call_id, name, arguments }`
- Tool result → `{ type: "function_call_output", call_id, output }`

Using `input_text` for assistant history is invalid and returns HTTP 400.

### Layer 4: Stateful SSE mapping (`CodexStreamMapper`)
AI SDK v3 requires stable IDs and complete block lifecycles. Delta-only streams are discarded at the `streamText()` boundary.

- Message item added/done → `text-start` / `text-end`
- `response.output_text.delta` → `text-delta` with the message item ID
- Reasoning item added/done → `reasoning-start` / `reasoning-end`
- Reasoning delta → `reasoning-delta` with a stable reasoning ID
- Function item added/done → `tool-input-start` / `tool-input-end`
- Function argument delta → `tool-input-delta` with the API `call_id`
- Function item done → `tool-call`
- `response.completed` / `response.done` → `finish`
- `response.incomplete` → `finish` with `length` reason
- `response.failed` / `error` → `error`

When at least one function call is emitted, the finish reason is `tool-calls`; otherwise it is `stop`.

### Layer 5: Retry logic
Exponential backoff for 429, 500, 502, 503, 504. Max retries are configurable and default to zero. Retry headers are not currently applied.

## Simplifications (MVP)

| Feature | Pi reference | Quark MVP |
|---|---|---|
| Transport | WebSocket + SSE | SSE only |
| Delta caching | `previous_response_id` via WS pool | None — full context each turn |
| Debug stats | Per-session counters | None |
| Service tier pricing | Cost multiplier applied | Not tracked (AI SDK handles usage) |
| Tool approval | Provider-executed tools | Standard AI SDK tool flow |

## Acceptance Criteria

1. `resolveModel("codex/gpt-5.5")` returns a `LanguageModelV3` that streams from `chatgpt.com/backend-api`
2. A valid Codex token (from `codex-login.ts`) is accepted — no 403
3. Text streaming works: `streamText()` with the model produces `text-delta` events
4. Reasoning blocks are forwarded as `reasoning-delta` events
5. Tool calls are forwarded as `tool-call` events
6. Finish events include correct `stop`, `tool-calls`, or `length` finish reason
7. Rate-limit errors trigger retry with exponential backoff
8. All existing provider tests continue to pass
9. Assistant history and tool results are accepted on subsequent API turns
10. A TUI tool call executes and the final assistant response is persisted
11. Provider tests do not modify or delete the user's persisted Codex token

## Testing Strategy

- Mock `fetch` to return SSE responses with known event sequences
- Assert the provider yields expected `LanguageModelV3StreamPart` events
- Test retry logic with 429 responses
- Test JWT accountId extraction edge cases
- Test error event mapping (response.failed → error part)
- Test through AI SDK `streamText()` rather than only inspecting raw provider parts
- Run real API text and function-call requests with `codex/gpt-5.5`
- Run a manual TUI tool round-trip and verify persisted session output

## Verification

- Real API text stream returned `SDK_LIVE_OK`
- Real API function call returned `get_weather({ city: "Amsterdam" })`
- TUI rendered and persisted text output
- TUI executed `read(package.json)`, replayed the tool result, and returned `@quark/sdk`
- Provider suite: 194 passed, 5 skipped, 0 failed
- TypeScript typecheck passed
- Provider suite left a sentinel token file byte-for-byte unchanged
- TUI loaded an isolated token and reached the API authentication boundary
