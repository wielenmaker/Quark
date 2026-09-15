// Versioned Quark configuration.
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"
import type { CredentialSourceConfig } from "../provider/credentials"

/**
 * Resolved per call, not at import time: QUARK_CONFIG_DIR lets tests keep all
 * config I/O in a temp directory instead of the developer's real one.
 */
export function configPath(): string {
  const directory = process.env.QUARK_CONFIG_DIR ?? path.join(os.homedir(), ".config", "quark")
  return path.join(directory, "config.yaml")
}

export interface BranchingConfig {
  threshold: number
  auto: boolean
}

export interface CustomProviderConfig {
  /** OpenAI-compatible endpoint supplied by the user. */
  base_url: string
  /** `env:NAME` reads that environment variable; any other value is used as the literal key. */
  api_key?: string
}

export interface QuarkConfig {
  version: 2
  modelConfig: {
    small: string
  }
  max_steps: number
  branching: BranchingConfig
  /** Opaque passthrough; profile semantics live in src/profile/profile.ts. */
  profiles?: Record<string, unknown>
  /** Opaque passthrough; consumed by src/profile/profile.ts. */
  default_profile?: string
  providers: Record<string, CustomProviderConfig>
  hide_readonly_tools: boolean
  /** Optional executable name/path used to open local file links. */
  editor?: string
}

const BRANCHING_DEFAULTS: BranchingConfig = { threshold: 0.9, auto: true }
const DEFAULT_MODELS = {
  small: "openai/gpt-4o-mini",
}
const BUNDLED_PROVIDER_IDS = new Set([
  "openai", "anthropic", "openrouter", "deepseek", "copilot", "openai-codex", "ollama", "lmstudio",
])
const DEEPSEEK_PROVIDER_ID = "deepseek"
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com"
const DEEPSEEK_ENVIRONMENT_VARIABLE = "DEEPSEEK_API_KEY"
const SECRET_KEYS = /^(apiKey|token|secret|password)$/i
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/
const PROVIDER_KEYS = new Set(["base_url", "api_key"])

let cached: QuarkConfig | null = null

function readRawConfig(): Record<string, unknown> {
  try {
    const parsed = parseYAML(fs.readFileSync(configPath(), "utf8")) as unknown
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function parseBranching(raw: unknown): BranchingConfig {
  if (!raw || typeof raw !== "object") return { ...BRANCHING_DEFAULTS }
  const value = raw as Record<string, unknown>
  return {
    auto: typeof value.auto === "boolean" ? value.auto : BRANCHING_DEFAULTS.auto,
    threshold: typeof value.threshold === "number" && value.threshold > 0 && value.threshold <= 1
      ? value.threshold
      : BRANCHING_DEFAULTS.threshold,
  }
}

function validateModelSpec(spec: string, field: string): string {
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`${field} must use a complete provider/model specification.`)
  }
  return `${spec.slice(0, slash).toLowerCase()}/${spec.slice(slash + 1)}`
}

function parseApiKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty API key or an "env:NAME" reference.`)
  }
  const key = value.trim()
  if (!key.startsWith("env:")) return key
  const variable = key.slice(4)
  if (!ENVIRONMENT_VARIABLE.test(variable)) {
    throw new Error(`${field} must reference an uppercase environment-variable name after "env:".`)
  }
  return `env:${variable}`
}

/** Maps a configured provider onto its credential source. */
export function providerCredentialSource(provider: CustomProviderConfig): CredentialSourceConfig {
  if (!provider.api_key) return { source: "none" }
  return provider.api_key.startsWith("env:")
    ? { source: "environment", variable: provider.api_key.slice(4) }
    : { source: "inline", value: provider.api_key }
}

function normalizeEndpoint(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`${field} must be an absolute HTTP(S) URL.`)
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${field} must be an absolute HTTP(S) URL.`) }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field} must use http or https.`)
  if (url.username || url.password) throw new Error(`${field} must not contain URL user-info.`)
  return url.toString().replace(/\/$/, "")
}

function warnRedundantDeepSeek(provider: CustomProviderConfig): void {
  const canonicalEndpoint = provider.base_url === DEEPSEEK_ENDPOINT
    || provider.base_url === `${DEEPSEEK_ENDPOINT}/v1`
  if (!canonicalEndpoint || provider.api_key !== `env:${DEEPSEEK_ENVIRONMENT_VARIABLE}`) {
    throw new Error(
      `providers.deepseek conflicts with the bundled DeepSeek provider. Rename the custom provider ID (for example, "company-deepseek") and update model references to use that ID.`,
    )
  }
  console.warn("[quark] providers.deepseek is redundant because DeepSeek is bundled; remove providers.deepseek from config.yaml.")
}

export function parseCustomProviders(raw: unknown): Record<string, CustomProviderConfig> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("providers must be a mapping.")
  const result: Record<string, CustomProviderConfig> = {}
  for (const [rawId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const id = rawId.toLowerCase()
    if (!PROVIDER_ID.test(rawId) || rawId !== id) throw new Error(`Invalid custom provider ID "${rawId}".`)
    if (id === "compaction" || (BUNDLED_PROVIDER_IDS.has(id) && id !== DEEPSEEK_PROVIDER_ID)) {
      throw new Error(`Custom provider ID "${id}" is reserved or bundled.`)
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`providers.${id} must be a mapping.`)
    const value = entry as Record<string, unknown>
    const secret = Object.keys(value).find((key) => key !== "api_key" && SECRET_KEYS.test(key))
    if (secret) throw new Error(`Secret field providers.${id}.${secret} is forbidden; use api_key with an "env:NAME" reference.`)
    const unsupported = Object.keys(value).find((key) => !PROVIDER_KEYS.has(key))
    if (unsupported) {
      throw new Error(`providers.${id}.${unsupported} is not supported; providers accept base_url and api_key only.`)
    }
    const provider: CustomProviderConfig = {
      base_url: normalizeEndpoint(value.base_url, `providers.${id}.base_url`),
      ...(value.api_key === undefined ? {} : { api_key: parseApiKey(value.api_key, `providers.${id}.api_key`) }),
    }
    if (id === DEEPSEEK_PROVIDER_ID) warnRedundantDeepSeek(provider)
    result[id] = provider
  }
  return result
}

/** Defaults used when no config file exists yet. */
export function defaultConfig(): QuarkConfig {
  return {
    version: 2,
    modelConfig: { ...DEFAULT_MODELS },
    max_steps: 100,
    branching: { ...BRANCHING_DEFAULTS },
    providers: {},
    hide_readonly_tools: false,
  }
}

export function parseConfigV2(raw: Record<string, unknown>): QuarkConfig {
  if (raw.version !== 2) {
    throw new Error(
      raw.version === undefined
        ? "config.yaml has no \"version\" field. Version 1 configuration is no longer supported; add \"version: 2\", move small_model to models.small, and describe providers with base_url and api_key."
        : `Unsupported config version "${String(raw.version)}". Quark requires "version: 2" in config.yaml.`,
    )
  }
  if (!raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) {
    throw new Error("models must contain small.")
  }
  const models = raw.models as Record<string, unknown>
  return {
    version: 2,
    modelConfig: {
      small: validateModelSpec(nonEmptyString(models.small, DEFAULT_MODELS.small), "models.small"),
    },
    max_steps: typeof raw.max_steps === "number" ? raw.max_steps : 100,
    branching: parseBranching(raw.branching),
    profiles: raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)
      ? raw.profiles as Record<string, unknown> : undefined,
    default_profile: nonEmptyString(raw.default_profile, "") || undefined,
    providers: parseCustomProviders(raw.providers),
    hide_readonly_tools: typeof raw.hide_readonly_tools === "boolean" ? raw.hide_readonly_tools : false,
    editor: typeof raw.editor === "string" && raw.editor.trim() ? raw.editor.trim() : undefined,
  }
}

export function loadConfig(): QuarkConfig {
  if (cached) return cached
  const raw = readRawConfig()
  cached = Object.keys(raw).length === 0 ? defaultConfig() : parseConfigV2(raw)
  return cached
}

export function serializeConfig(config: QuarkConfig): string {
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
    base_url: provider.base_url,
    ...(provider.api_key ? { api_key: provider.api_key } : {}),
  }]))
  return stringifyYAML({
    version: 2,
    models: config.modelConfig,
    max_steps: config.max_steps,
    branching: config.branching,
    ...(config.default_profile ? { default_profile: config.default_profile } : {}),
    ...(config.profiles ? { profiles: config.profiles } : {}),
    providers,
    hide_readonly_tools: config.hide_readonly_tools,
    ...(config.editor ? { editor: config.editor } : {}),
  })
}

export function writeConfigV2(config: QuarkConfig, file = configPath()): void {
  const content = serializeConfig(config)
  parseConfigV2(parseYAML(content) as Record<string, unknown>)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
  cached = null
}

export function parseModelSpec(spec: string): { provider?: string; model: string } {
  const index = spec.indexOf("/")
  return index === -1 ? { model: spec } : { provider: spec.slice(0, index), model: spec.slice(index + 1) }
}

export function setConfigField<K extends "max_steps" | "branching" | "hide_readonly_tools">(
  key: K,
  value: QuarkConfig[K],
): void {
  writeConfigV2({ ...loadConfig(), [key]: value })
}

export function resetConfigCache(): void {
  cached = null
}
