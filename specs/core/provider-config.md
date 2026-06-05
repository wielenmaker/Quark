# Provider Configuration

## Responsibility

The provider module is responsible for **authentication only**:
- Which SDK adapter to use (`openai` / `anthropic` / `alibaba`)
- `baseURL` — where to send requests
- `apiKey` — how to authenticate

Everything else (thinking tokens, tool calls, streaming) is handled by other modules.

## Preset Dictionary

Known providers ship with defaults so users only need to supply an API key.

```ts
const PRESETS = {
  groq:       { type: "openai",    baseURL: "https://api.groq.com/openai/v1" },
  deepseek:   { type: "alibaba",   baseURL: "https://api.deepseek.com" },
  openrouter: { type: "openai",    baseURL: "https://openrouter.ai/api/v1" },
  together:   { type: "openai",    baseURL: "https://api.together.xyz/v1" },
  anthropic:  { type: "anthropic", baseURL: "https://api.anthropic.com" },
  fireworks:  { type: "openai",    baseURL: "https://api.fireworks.ai/inference/v1" },
}
```

Custom providers must supply `type` and `baseURL` manually.

## Config Schema

```yaml
providers:
  groq:
    apiKey: env:GROQ_API_KEY        # preset — baseURL and type inferred

  myprovider:
    type: openai
    baseURL: https://my-proxy.internal/v1
    apiKey: env:MY_KEY              # custom — all fields required
```

## CLI Wizard

```
$ quark provider add

┌ Add Provider
│
◇ Provider
│  ● groq  ○ anthropic  ○ deepseek  ○ openrouter  ○ custom
│
◇ API key
│  ▪ Value  ● Env var
│
◇ Env var name
│  GROQ_API_KEY
│
◇ Test connection? › Yes
│  ✓ Connected · 12 models available
│
└ Saved — use with groq/model-name
```

For **custom** providers, two extra prompts are inserted:

```
◇ Base URL
│  https://my-proxy.internal/v1
│
◇ Type
│  ● openai  ○ anthropic  ○ alibaba
```

## Rules

- API keys are always stored as env var references, never as literals
- Test connection hits `/v1/models` (OpenAI-compat) before saving
- If test fails, offer "save anyway" for internal/offline APIs
- Preset name is the provider identifier — no separate name field
