// Versioned Quark configuration. V2 never persists credential values.
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"
import type { BillingMode } from "../provider/definitions"
import type { CredentialSourceConfig } from "../provider/credentials"
import type { TelemetryConfig } from "../telemetry"

const CONFIG_DIR = path.join(os.homedir(), ".config", "quark")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml")
export const CONFIG_PATH = CONFIG_FILE

export interface BranchingConfig {
  threshold: number
  auto: boolean
}

export interface ProfileConfig {
  model?: string
  thinking?: { effort?: string; mode?: string }
}

export interface CustomProviderConfig {
  /** OpenAI-compatible endpoint supplied by the user. */
  base_url: string
  /** Environment variable containing this provider's API key. */
  api_key_env?: string
  /** Read-only compatibility for pre-v2.1 custom credential configuration. */
  legacyCredentialSource?: CredentialSourceConfig
  /** Optional cost-tracking metadata; it never affects authentication. */
  billing: BillingMode
}

/** Legacy V1 provider shape, retained for read/runtime plugin compatibility only. */
export interface ProviderConfig {
  baseURL: string
  apiKey: string
}

export interface QuarkConfig {
  version: 2
  modelConfig: {
    small: string
    favorites: string[]
  }
  max_steps: number
  branching: BranchingConfig
  profiles?: Record<string, ProfileConfig>
  providers: Record<string, CustomProviderConfig>
  hide_readonly_tools: boolean
  telemetry: TelemetryConfig
  /** Optional executable name/path used to open local file links. */
  editor?: string
  /** Compatibility projections; never serialized as V2 fields. */
  models: string[]
  small_model: string
  /** True when the source file had no version and was read through V1 compatibility. */
  legacy: boolean
}

const BRANCHING_DEFAULTS: BranchingConfig = { threshold: 0.9, auto: true }
const DEFAULT_MODELS = {
  small: "openai/gpt-4o-mini",
  favorites: [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "anthropic/claude-sonnet-4",
    "anthropic/claude-haiku-3.5",
    "openai/o4-mini",
  ],
}
const BUNDLED_PROVIDER_IDS = new Set([
  "openai", "anthropic", "openrouter", "deepseek", "copilot", "codex", "ollama", "lmstudio",
])
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com"
const DEEPSEEK_ENVIRONMENT_VARIABLE = "DEEPSEEK_API_KEY"
const SECRET_KEYS = /^(apiKey|api_key|token|secret|password)$/i
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/

let cached: QuarkConfig | null = null
const runtimeProviders: Record<string, ProviderConfig> = {}

function readRawConfig(): Record<string, unknown> {
  try {
    const parsed = parseYAML(fs.readFileSync(CONFIG_FILE, "utf8")) as unknown
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function parseTelemetry(raw: unknown): TelemetryConfig {
  if (raw === undefined) return { diagnostic: false }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("telemetry must be a mapping.")
  }
  const value = raw as Record<string, unknown>
  if (value.diagnostic !== undefined && typeof value.diagnostic !== "boolean") {
    throw new Error("telemetry.diagnostic must be a boolean.")
  }
  return { diagnostic: value.diagnostic === true }
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

function parseEnvironmentVariable(value: unknown, field: string): string {
  if (typeof value !== "string" || !ENVIRONMENT_VARIABLE.test(value)) {
    throw new Error(`${field} must be an uppercase environment-variable name.`)
  }
  return value
}

function parseBilling(value: unknown, field: string): BillingMode {
  if (!["metered", "subscription", "free", "unknown"].includes(String(value))) {
    throw new Error(`${field} is invalid.`)
  }
  return value as BillingMode
}

function normalizeEndpoint(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`${field} must be an absolute HTTP(S) URL.`)
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${field} must be an absolute HTTP(S) URL.`) }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field} must use http or https.`)
  if (url.username || url.password) throw new Error(`${field} must not contain URL user-info.`)
  return url.toString().replace(/\/$/, "")
}

function acceptCanonicalDeepSeek(
  provider: CustomProviderConfig,
  rawEndpoint: unknown,
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const endpoint = typeof rawEndpoint === "string" ? rawEndpoint.replace(/\/$/, "") : ""
  const credentialCompatible = provider.api_key_env === DEEPSEEK_ENVIRONMENT_VARIABLE
    || provider.legacyCredentialSource?.source === "store"
    || provider.legacyCredentialSource?.source === "auto"
  const canonical = (endpoint === DEEPSEEK_ENDPOINT || endpoint === `${DEEPSEEK_ENDPOINT}/v1`)
    && credentialCompatible
    && (provider.billing === "metered" || value.billing === undefined)
    && Object.keys(value).every((key) => allowedKeys.includes(key))
  if (!canonical) {
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
    if (id === "compaction" || (BUNDLED_PROVIDER_IDS.has(id) && id !== "deepseek")) {
      throw new Error(`Custom provider ID "${id}" is reserved or bundled.`)
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`providers.${id} must be a mapping.`)
    const value = entry as Record<string, unknown>
    const secret = Object.keys(value).find((key) => SECRET_KEYS.test(key))
    if (secret) throw new Error(`Secret field providers.${id}.${secret} is forbidden; choose a credential source.`)
    const hasCanonicalFields = "base_url" in value || "api_key_env" in value
    const hasLegacyFields = "protocol" in value || "endpoint" in value || "credential" in value
    if (hasCanonicalFields && hasLegacyFields) {
      throw new Error(`providers.${id} cannot mix base_url/api_key_env with legacy credential fields.`)
    }
    if (hasCanonicalFields) {
      const provider = {
        base_url: normalizeEndpoint(value.base_url, `providers.${id}.base_url`),
        api_key_env: parseEnvironmentVariable(value.api_key_env, `providers.${id}.api_key_env`),
        billing: value.billing === undefined ? "unknown" : parseBilling(value.billing, `providers.${id}.billing`),
      }
      if (id === "deepseek") {
        acceptCanonicalDeepSeek(provider, value.base_url, value, ["base_url", "api_key_env", "billing"])
      }
      result[id] = provider
      continue
    }
    if (value.protocol !== "openai-compatible") {
      throw new Error(`providers.${id}.protocol must be openai-compatible.`)
    }
    const credential = value.credential as Record<string, unknown> | undefined
    const source = credential?.source
    if (!["environment", "auto", "prompt", "store", "none"].includes(String(source))) {
      throw new Error(`providers.${id}.credential.source is invalid.`)
    }
    const legacyCredentialSource: CredentialSourceConfig = source === "environment"
      ? { source, variable: parseEnvironmentVariable(credential?.variable, `providers.${id}.credential.variable`) }
      : { source: source as "auto" | "prompt" | "store" | "none" }
    const provider: CustomProviderConfig = {
      base_url: normalizeEndpoint(value.endpoint, `providers.${id}.endpoint`),
      ...(source === "environment" ? { api_key_env: parseEnvironmentVariable(credential?.variable, `providers.${id}.credential.variable`) } : { legacyCredentialSource }),
      billing: value.billing === undefined ? "unknown" : parseBilling(value.billing, `providers.${id}.billing`),
    }
    if (id === "deepseek") {
      acceptCanonicalDeepSeek(provider, value.endpoint, value, ["protocol", "endpoint", "credential", "billing"])
    }
    result[id] = provider
  }
  return result
}

function withCompatibility(input: Omit<QuarkConfig, "models" | "small_model">): QuarkConfig {
  return {
    ...input,
    models: input.modelConfig.favorites,
    small_model: input.modelConfig.small,
  }
}

export function parseConfigV2(raw: Record<string, unknown>): QuarkConfig {
  if (raw.version !== 2) throw new Error(`Unsupported config version "${String(raw.version)}".`)
  if (!raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) {
    throw new Error("models must contain small and favorites.")
  }
  const models = raw.models as Record<string, unknown>
  const favorites = Array.isArray(models.favorites) && models.favorites.every((item) => typeof item === "string")
    ? models.favorites as string[] : [...DEFAULT_MODELS.favorites]
  const modelConfig = {
    small: validateModelSpec(nonEmptyString(models.small, DEFAULT_MODELS.small), "models.small"),
    favorites: favorites.map((model, index) => validateModelSpec(model, `models.favorites[${index}]`)),
  }
  return withCompatibility({
    version: 2,
    modelConfig,
    max_steps: typeof raw.max_steps === "number" ? raw.max_steps : 100,
    branching: parseBranching(raw.branching),
    profiles: raw.profiles && typeof raw.profiles === "object"
      ? raw.profiles as Record<string, ProfileConfig> : undefined,
    providers: parseCustomProviders(raw.providers),
    hide_readonly_tools: typeof raw.hide_readonly_tools === "boolean" ? raw.hide_readonly_tools : false,
    telemetry: parseTelemetry(raw.telemetry),
    editor: typeof raw.editor === "string" && raw.editor.trim() ? raw.editor.trim() : undefined,
    legacy: false,
  })
}

function parseV1Providers(raw: unknown): Record<string, CustomProviderConfig> {
  if (!raw || typeof raw !== "object") return {}
  const result: Record<string, CustomProviderConfig> = {}
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || !PROVIDER_ID.test(id) || BUNDLED_PROVIDER_IDS.has(id)) continue
    const value = entry as Record<string, unknown>
    if (typeof value.baseURL !== "string") continue
    const apiKey = typeof value.apiKey === "string" ? value.apiKey : ""
    if (!apiKey.startsWith("env:") || !ENVIRONMENT_VARIABLE.test(apiKey.slice(4))) continue
    result[id] = {
      base_url: normalizeEndpoint(value.baseURL, `providers.${id}.baseURL`),
      api_key_env: apiKey.slice(4),
      billing: "unknown",
    }
  }
  return result
}

function qualifyLegacyModel(spec: string): string {
  return spec.includes("/") ? spec : `openai/${spec}`
}

function parseV1(raw: Record<string, unknown>): QuarkConfig {
  const legacyFavorites = Array.isArray(raw.models) && raw.models.every((item) => typeof item === "string")
    ? raw.models as string[] : ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4", "claude-haiku-3.5", "gemini-2.5-pro", "o4-mini"]
  const legacySmall = nonEmptyString(raw.small_model, "gpt-4o-mini")
  const modelConfig = {
    small: qualifyLegacyModel(legacySmall),
    favorites: legacyFavorites.map(qualifyLegacyModel),
  }
  return {
    version: 2,
    modelConfig,
    max_steps: typeof raw.max_steps === "number" ? raw.max_steps : 100,
    branching: parseBranching(raw.branching),
    providers: parseV1Providers(raw.providers),
    hide_readonly_tools: typeof raw.hide_readonly_tools === "boolean" ? raw.hide_readonly_tools : false,
    telemetry: parseTelemetry(raw.telemetry),
    editor: typeof raw.editor === "string" && raw.editor.trim() ? raw.editor.trim() : undefined,
    legacy: true,
    models: legacyFavorites,
    small_model: legacySmall,
  }
}

export function loadConfig(): QuarkConfig {
  if (cached) return cached
  const raw = readRawConfig()
  cached = raw.version === undefined ? parseV1(raw) : parseConfigV2(raw)
  return cached
}

export function serializeConfig(config: QuarkConfig): string {
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => {
    if (provider.api_key_env) {
      return [id, {
        base_url: provider.base_url,
        api_key_env: provider.api_key_env,
        ...(provider.billing === "unknown" ? {} : { billing: provider.billing }),
      }]
    }
    // Preserve legacy entries during unrelated writes; do not silently change their credential behavior.
    return [id, {
      protocol: "openai-compatible",
      endpoint: provider.base_url,
      credential: provider.legacyCredentialSource,
      ...(provider.billing === "unknown" ? {} : { billing: provider.billing }),
    }]
  }))
  return stringifyYAML({
    version: 2,
    models: config.modelConfig,
    max_steps: config.max_steps,
    branching: config.branching,
    ...(config.profiles ? { profiles: config.profiles } : {}),
    providers,
    hide_readonly_tools: config.hide_readonly_tools,
    telemetry: config.telemetry,
    ...(config.editor ? { editor: config.editor } : {}),
  })
}

export function writeConfigV2(config: QuarkConfig, file = CONFIG_FILE): void {
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

/** Rewrite V1 as normalized V2. Literal secrets are replaced by prompt sources, never copied. */
export function migrateConfigToV2(file = CONFIG_FILE): QuarkConfig {
  const raw = (() => {
    try { return parseYAML(fs.readFileSync(file, "utf8")) as Record<string, unknown> } catch { return {} }
  })()
  const config = raw.version === 2 ? parseConfigV2(raw) : parseV1(raw)
  writeConfigV2({ ...config, legacy: false }, file)
  return { ...config, legacy: false }
}

export function resolveApiKey(raw: string): string {
  return raw.startsWith("env:") ? process.env[raw.slice(4)] ?? "" : raw
}

export function parseModelSpec(spec: string): { provider?: string; model: string } {
  const index = spec.indexOf("/")
  return index === -1 ? { model: spec } : { provider: spec.slice(0, index), model: spec.slice(index + 1) }
}

/** Bridge V2 custom providers into the old resolver/plugin shape. */
export function getProviderConfig(id: string): ProviderConfig | null {
  const normalized = id.toLowerCase()
  if (runtimeProviders[normalized]) return runtimeProviders[normalized]!
  const provider = loadConfig().providers[normalized]
  if (!provider) return null
  const apiKey = provider.api_key_env
    ? `env:${provider.api_key_env}`
    : provider.legacyCredentialSource?.source === "environment"
      ? `env:${provider.legacyCredentialSource.variable}`
      : ""
  return { baseURL: provider.base_url, apiKey }
}

/** @deprecated Runtime-only compatibility API; keys are never serialized. */
export function registerProvider(id: string, config: ProviderConfig): void {
  const normalized = id.trim().toLowerCase()
  if (!PROVIDER_ID.test(normalized) || normalized === "compaction") throw new Error(`Invalid or reserved provider ID "${id}".`)
  if (BUNDLED_PROVIDER_IDS.has(normalized)) throw new Error(`Provider ID "${normalized}" is bundled and cannot be replaced by a plugin.`)
  if (runtimeProviders[normalized] || loadConfig().providers[normalized]) throw new Error(`Provider ID "${normalized}" is already registered.`)
  console.warn("[quark] registerProvider(id, { baseURL, apiKey }) is deprecated; register a non-secret provider definition instead.")
  runtimeProviders[normalized] = config
}

export function setConfigField<K extends "max_steps" | "branching" | "hide_readonly_tools" | "telemetry">(
  key: K,
  value: QuarkConfig[K],
): void
export function setConfigField(key: "small_model" | "models", value: string | string[]): void
export function setConfigField(key: string, value: unknown): void {
  const config = loadConfig()
  if (key === "small_model") config.modelConfig.small = qualifyLegacyModel(value as string)
  else if (key === "models") config.modelConfig.favorites = (value as string[]).map(qualifyLegacyModel)
  else (config as unknown as Record<string, unknown>)[key] = value
  writeConfigV2({ ...withCompatibility({ ...config, legacy: false }), legacy: false })
}

export function resetConfigCache(): void {
  cached = null
}
