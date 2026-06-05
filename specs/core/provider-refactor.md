# Provider Module Refactor

## Problem

`src/provider/provider.ts` (210 lines) is a god module mixing 7 concerns:
1. Copilot mutable state management (6 module-level globals)
2. Model routing logic (`shouldUseResponsesApi`, `isClaude`)
3. 5 different provider factory functions with different signatures
4. Legacy thinking budget dual-path (body injection vs providerOptions)
5. Copilot-settable functions exposed globally (`setCopilotThinking`, `setCopilotForceAgent`)
6. Web-proxy provider support (`@ai-sdk/alibaba`)
7. Thin wrapper that just calls `createOpenAI` with same args

`reasoning-fetch.ts` exists solely because two gaps both strip `reasoning_content`:
- Gap 1: `toModelMessages()` has no handler for `reasoning` parts (message.ts:414-448)
- Gap 2: `@ai-sdk/openai`'s converter has no `case 'reasoning'` (unlike `@ai-sdk/openai-compatible`)

---

## Target Architecture

```
src/provider/
├── custom-fetch.ts           ← setForceAgent() + getCustomFetch() dispatcher
├── copilot-fetch.ts          ← Copilot HTTP interceptor (thinkingBody removed)
├── copilot-auth.ts           ← Copilot OAuth (unchanged)
├── thinking.ts               ← ThinkingNormalizer (alibaba/dashscope cases removed)
├── models.ts                 ← models.dev (unchanged)
```

No more god module. Copilot is not a first-class branch — it's an OpenAI-compatible provider with a custom fetch, same as any future proxy provider.

---

## Delete

| File | Reason |
|------|--------|
| `src/provider/provider.ts` | God module — all 7 concerns split elsewhere or eliminated |
| `src/provider/reasoning-fetch.ts` | Root cause fixed — `toModelMessages` + `createOpenAICompatible` preserves `reasoning_content` |
| `src/provider/claude-web-proxy-auth.ts` | Web proxy support removed |
| `test/provider/provider.test.ts` | Tests for deleted file |
| `test/provider/web-provider.test.ts` | Tests for deleted web proxy |
| `test/provider/claude-web-proxy-auth.test.ts` | Tests for deleted web proxy auth |
| `scripts/web-proxy/` | Web proxy server |
| `scripts/claude-web-proxy.py` | Standalone proxy |
| `scripts/proxy/claude-web-proxy.py` | Duplicate proxy |
| `scripts/start-claude-proxy.sh` | Proxy launcher |
| `specs/web-proxy-architecture.md` | Docs |
| `specs/web-proxy-profiling.md` | Docs |
| `specs/web-proxy-thinking-tokens.md` | Docs |

---

## Create

### `src/provider/custom-fetch.ts`

Central dispatcher for all custom fetch wrappers. Contains:

```ts
import type { FetchFn } from "@ai-sdk/provider-utils"
import { createCopilotFetch, type CopilotFetchFn } from "./copilot-fetch"

const copilotInstances = new Map<string, CopilotFetchFn>()

/** Force x-initiator to "agent" for compaction and sub-agent runs */
export function setForceAgent(force: boolean): void {
  for (const fetch of copilotInstances.values()) {
    fetch.setForceAgent(force)
  }
}

/**
 * Returns a custom fetch wrapper for the given provider, or undefined
 * if the standard fetch works fine.
 * Extend this with new functions when adding providers that need
 * custom headers, stream normalization, etc.
 */
export function getCustomFetch(
  providerId: string,
  options?: { getToken: () => Promise<string> }
): FetchFn | undefined {
  if (providerId === "copilot" && options) {
    const fetch = createCopilotFetch(options)
    copilotInstances.set("copilot", fetch)
    return fetch as unknown as FetchFn
  }
  return undefined
}
```

---

## Modify

### 1. `src/session/message.ts` — Fix `toModelMessages()` reasoning gap

**File**: `src/session/message.ts`, lines 400-448 (assistant message builder)

**Change**: Add `case "reasoning"` handler inside the `msgParts` loop:

```ts
// Inside the for-loop at line 414:
case "reasoning": {
  const d = JSON.parse(p.data) as ReasoningPartData
  if (d.text) {
    assistantContent.push({ type: "reasoning", text: d.text })
  }
  break
}
```

**Why**: Reasoning parts are stored in the DB by `processor.ts:300-334` but `toModelMessages()` never reads them when building replay messages. This is Gap 1. The AI SDK's `convertToOpenAICompatibleChatMessages` DOES handle `{ type: "reasoning" }` parts and emits `reasoning_content` in the wire format — but only if the part is present in the content array.

**Note**: `ReasoningPartData` interface exists at `provider/thinking.ts` or may need to be defined/imported in message.ts. Check existing type definitions.

### 2. `src/session/prompt.ts` — Simplify provider routing

**File**: `src/session/prompt.ts`

**Imports** (lines 35-44): Replace:
```diff
- import { getModel, createCopilotProvider, createOpenAICompatibleProvider,
-   createAlibabaCompatibleProvider, createReasoningCompatibleProvider,
-   createCopilotAnthropicProvider, isClaude, setCopilotForceAgent
- } from "../provider/provider"
- import { getThinkingNormalizer, needsReasoningReplay } from "../provider/thinking"
+ import { getThinkingNormalizer } from "../provider/thinking"
+ import { setForceAgent } from "../provider/custom-fetch"
+ import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
+ import { createOpenAI } from "@ai-sdk/openai"
+ import { createAnthropic } from "@ai-sdk/anthropic"
+ import { loadToken } from "../provider/copilot-auth"
```

**`setCopilotForceAgent` calls** (8 call sites at lines 138, 159, 233, 268, 292, 355, 407, 465):
Replace `setCopilotForceAgent(x)` → `setForceAgent(x)`.

**`resolveModel` function** (lines 512-573): Replace the 5-branch routing with:

```ts
async function resolveModel(
  modelSpec: string,
  _role: "main" | "small",
): Promise<LanguageModelV1> {
  let { provider: providerId, model: modelId } = parseModelSpec(modelSpec)
  if (!providerId) throw new Error(`Model must include provider prefix (e.g. "openai/gpt-4o")`)

  // Plugin hook
  const beforeOutput = await fireHook("provider.request.before", {
    provider: providerId, model: modelId, messages: [],
  }, { provider: providerId, model: modelId })
  providerId = beforeOutput.provider
  modelId = beforeOutput.model

  // Branch 1: Copilot — OAuth auth, not config.yaml
  if (providerId === "copilot") {
    const getToken = async () => {
      const token = loadToken()
      if (!token) throw new Error(
        "No Copilot token found. Run the login flow first (scripts/copilot-login.ts)."
      )
      return token
    }
    const fetch = getCustomFetch("copilot", { getToken })
    return createOpenAICompatible({
      name: "copilot",
      baseURL: "https://api.githubcopilot.com",
      apiKey: "copilot",
      fetch,
    })(modelId)
  }

  // Branch 2: User-configured providers from ~/.config/quark/config.yaml
  const pc = getProviderConfig(providerId)
  if (!pc) throw new Error(
    `Unknown provider "${providerId}". Define it in ~/.config/quark/config.yaml under "providers:".`
  )

  // Native SDK providers
  if (providerId === "openai") {
    return createOpenAI({ apiKey: resolveApiKey(pc.apiKey), baseURL: pc.baseURL })(modelId)
  }
  if (providerId === "anthropic") {
    return createAnthropic({ apiKey: resolveApiKey(pc.apiKey), baseURL: pc.baseURL })(modelId)
  }

  // Branch 3: OpenAI-compatible (DeepSeek, Kimi, OpenRouter, OpenCode Go, ...)
  const customFetch = getCustomFetch(providerId)
  return createOpenAICompatible({
    name: providerId,
    baseURL: pc.baseURL,
    apiKey: resolveApiKey(pc.apiKey),
    fetch: customFetch,
  })(modelId)
}
```

**What's removed**:
- `isClaude(modelId) && thinking` → no more separate Anthropic path for Copilot Claude
- `providerId === "web"` → no more web proxy / Alibaba
- `needsReasoningReplay(modelId)` → no more special DeepSeek/Kimi provider (fixed at source)
- `getModel(provider, modelId)` → no more Responses API routing (AI SDK auto-selects)
- The `let provider` mutable local variable

### 3. `src/provider/thinking.ts` — Remove alibaba/dashscope cases

**File**: `src/provider/thinking.ts`

**`normalizeNative()`** (lines 236-252): Remove the alibaba/dashscope-specific block:

```diff
-   if (providerId === "alibaba" || providerId === "dashscope") {
-     return { alibaba: { reasoning: true } as JSONObject }
-   }
```

The rest of `normalizeNative` stays — it handles Qwen via openai-compatible endpoint with `enable_thinking`.

### 4. `src/provider/copilot-fetch.ts` — Remove legacy thinking body injection

**File**: `src/provider/copilot-fetch.ts`

**Remove**:
- `setThinkingBudget()` method on `CopilotFetchFn` interface (line 16)
- `thinkingBudget` option in `createCopilotFetch()` signature (line 184)
- `currentBudget` variable and the body injection block (lines 208-213):
  ```ts
  if (currentBudget > 0 && parsedBody && typeof parsedBody === "object") {
    (parsedBody as Record<string, unknown>).thinking = {
      type: "enabled",
      budget_tokens: currentBudget,
    }
    bodyToSend = JSON.stringify(parsedBody)
  }
  ```
- The `bodyToSend` variable — use `init?.body` directly instead.

**Why**: Thinking is now purely via `providerOptions` + `ThinkingNormalizer`. No dual-path.

### 5. `src/web/server.ts` — Remove Copilot thinking toggle

**File**: `src/web/server.ts`

```diff
- import { setCopilotThinking } from "../provider/provider"
  import { getThinkingNormalizer, EFFORT_TO_BUDGET } from "../provider/thinking"

  // In /api/thinking POST handler (line 248):
    getThinkingNormalizer(activeModel).configure({ enabled: body.enabled, effort })
-   setCopilotThinking(EFFORT_TO_BUDGET[effort] ?? 0)
```

### 6. `src/tui/components/App.tsx` — Remove Copilot thinking toggle

**File**: `src/tui/components/App.tsx`

```diff
- import { setCopilotThinking } from "../../provider/provider"
  import { getThinkingNormalizer, EFFORT_TO_BUDGET } from "../../provider/thinking"

  // In Ctrl+T handler (line 911):
    getThinkingNormalizer(state.store.status.modelName).configure({ enabled: effort !== "none", effort })
-   setCopilotThinking(EFFORT_TO_BUDGET[effort] ?? 0)
```

### 7. `package.json` — Update dependencies

```diff
- "@ai-sdk/alibaba": "^1.0.17",
+ "@ai-sdk/openai-compatible": "^2.0.41",
```

Then run `bun install` to update lockfile.

### 8. `specs/architecture.md` — Update provider routing diagram

Replace the 5-path diagram with the new 3-branch structure. Remove web proxy and alibaba references.

### 9. `specs/provider-config.md` — Remove alibaba references

Remove alibaba/dashscope from provider type documentation.

---

## What Stays Unchanged

| File | Why |
|------|-----|
| `copilot-auth.ts` | OAuth device flow — independent of routing |
| `copilot-fetch.ts` (core) | Fetch wrapper stays — only thinkingBody removed |
| `models.ts` | models.dev cache — independent of routing |
| `thinking.ts` (core) | ThinkingNormalizer stays — only per-provider cases removed |

---

## Summary of Eliminated Concepts

| Removed | Replaced by |
|---------|-------------|
| `createAlibabaCompatibleProvider()` | Nothing — web proxy gone |
| `createOpenAICompatibleProvider()` | Direct `createOpenAI()` / `createOpenAICompatible()` |
| `createCopilotProvider()` + `createCopilotAnthropicProvider()` | `createOpenAICompatible({ fetch: createCopilotFetch() })` |
| `createReasoningCompatibleProvider()` + `reasoning-fetch.ts` | `toModelMessages()` reasonining fix + `createOpenAICompatible` |
| `shouldUseResponsesApi()` + `getModel()` | AI SDK auto-selects API per model |
| `isClaude()` | Copilot no longer does per-model routing |
| `setCopilotThinking()` + `getCopilotThinkingBudget()` | `ThinkingNormalizer` via `providerOptions` |
| `setCopilotForceAgent()` (provider.ts) | `setForceAgent()` in custom-fetch.ts |
| 6 module-level mutables in provider.ts | 1 Map in custom-fetch.ts |
| `@ai-sdk/alibaba` | `@ai-sdk/openai-compatible` |

---

## Test Notes

After implementation, verify:
1. `bun test test/provider/` — remaining provider tests pass
2. Models that previously used `reasoning-fetch.ts` (DeepSeek, Kimi) still work — run a multi-turn conversation with tool calls to confirm `reasoning_content` is preserved on replay
3. Copilot auth works through the new `createOpenAICompatible` path — run `/connect copilot` and a test prompt
4. Native OpenAI/Anthropic providers work unchanged
5. User-configured OpenAI-compatible providers (OpenRouter, local llama.cpp) work through Branch 3
6. TUI Ctrl+T thinking toggle still works via `ThinkingNormalizer.configure()`
7. Web API `/api/thinking` endpoint still works
