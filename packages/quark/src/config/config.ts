// Versioned Quark configuration — app-owned (CLI/TUI preferences + provider setup).
//
// This is deliberately NOT part of @quark/runner: the engine accepts an
// AgentDefinition plus explicit policies/providers and never reads config.yaml.
// V3 never persists credential values, and agents live in filesystem manifests
// (`agents/<id>/agent.yaml`) instead of inline `profiles:` entries.
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"
import { BUNDLED_PROVIDER_IDS } from "@quark/runner/provider/definitions"
import { validateProviderId } from "@quark/runner/provider/registry"
export { providerCredentialSource } from "@quark/runner/provider/credentials"

/**
 * Resolved per call, not at import time: QUARK_CONFIG_DIR lets tests keep all
 * config I/O in a temp directory instead of the developer's real one.
 */
export function configDir(): string {
  return process.env.QUARK_CONFIG_DIR ?? path.join(os.homedir(), ".config", "quark")
}

export function configPath(): string {
  return path.join(configDir(), "config.yaml")
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

export interface ModelsConfig {
  small: string
}

export interface QuarkConfig {
  version: 3
  /** Agent id activated when no explicit one is requested. Resolved by agent/agent.ts. */
  defaultAgent: string
  models: ModelsConfig
  maxSteps: number
  branching: BranchingConfig
  providers: Record<string, CustomProviderConfig>
  hideReadonlyTools: boolean
  /** Optional executable name/path used to open local file links. */
  editor?: string
}

/** Default agent id used when config.yaml is missing `default_agent`. */
export const DEFAULT_AGENT_ID = "coder"

const BRANCHING_DEFAULTS: BranchingConfig = { threshold: 0.9, auto: true }
const DEFAULT_MODELS = {
  small: "openai/gpt-4o-mini",
}
const DEFAULT_MAX_STEPS = 100
const SECRET_KEYS = /^(apiKey|token|secret|password)$/i
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

function parseMaxSteps(raw: unknown): number {
  if (raw === undefined) return DEFAULT_MAX_STEPS
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error("max_steps must be a positive integer.")
  }
  return raw
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

function normalizeEndpoint(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`${field} must be an absolute HTTP(S) URL.`)
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${field} must be an absolute HTTP(S) URL.`) }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field} must use http or https.`)
  if (url.username || url.password) throw new Error(`${field} must not contain URL user-info.`)
  return url.toString().replace(/\/$/, "")
}

/** Bundled providers are configured by Quark itself, never by the user. */
function assertCustomProviderId(providerId: string): void {
  if (!BUNDLED_PROVIDER_IDS.has(providerId)) return
  throw new Error(
    `providers.${providerId} conflicts with the bundled ${providerId} provider. Rename the custom provider ID (for example, "company-${providerId}") and update model references to use that ID.`,
  )
}

export function parseCustomProviders(raw: unknown): Record<string, CustomProviderConfig> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("providers must be a mapping.")
  const result: Record<string, CustomProviderConfig> = {}
  for (const [rawId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (rawId !== rawId.toLowerCase()) {
      throw new Error(`Invalid custom provider ID "${rawId}": provider IDs must be lowercase.`)
    }
    const id = validateProviderId(rawId)
    assertCustomProviderId(id)
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
    result[id] = provider
  }
  return result
}

/** Defaults used when no config file exists yet. */
export function defaultConfig(): QuarkConfig {
  return {
    version: 3,
    defaultAgent: DEFAULT_AGENT_ID,
    models: { ...DEFAULT_MODELS },
    maxSteps: DEFAULT_MAX_STEPS,
    branching: { ...BRANCHING_DEFAULTS },
    providers: {},
    hideReadonlyTools: false,
  }
}

export function parseConfigV3(raw: Record<string, unknown>): QuarkConfig {
  if (raw.version !== 3) {
    if (raw.version === 2) {
      throw new Error(
        "config.yaml is version 2. Run `bun scripts/migrate-config-v2-to-v3.ts` to move `profiles:` into agents/<id>/agent.yaml and add `default_agent`.",
      )
    }
    throw new Error(
      raw.version === undefined
        ? "config.yaml has no \"version\" field. Version 1 configuration is no longer supported; add \"version: 3\", move small_model to models.small, and describe providers with base_url and api_key."
        : `Unsupported config version "${String(raw.version)}". Quark requires "version: 3" in config.yaml.`,
    )
  }
  if (!raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) {
    throw new Error("models must contain small.")
  }
  const models = raw.models as Record<string, unknown>
  return {
    version: 3,
    defaultAgent: nonEmptyString(raw.default_agent, DEFAULT_AGENT_ID),
    models: {
      small: validateModelSpec(nonEmptyString(models.small, DEFAULT_MODELS.small), "models.small"),
    },
    maxSteps: parseMaxSteps(raw.max_steps),
    branching: parseBranching(raw.branching),
    providers: parseCustomProviders(raw.providers),
    hideReadonlyTools: typeof raw.hide_readonly_tools === "boolean" ? raw.hide_readonly_tools : false,
    editor: typeof raw.editor === "string" && raw.editor.trim() ? raw.editor.trim() : undefined,
  }
}

export function loadConfig(): QuarkConfig {
  if (cached) return cached
  const raw = readRawConfig()
  cached = Object.keys(raw).length === 0 ? defaultConfig() : parseConfigV3(raw)
  return cached
}

export function serializeConfig(config: QuarkConfig): string {
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
    base_url: provider.base_url,
    ...(provider.api_key ? { api_key: provider.api_key } : {}),
  }]))
  return stringifyYAML({
    version: 3,
    default_agent: config.defaultAgent,
    models: config.models,
    max_steps: config.maxSteps,
    branching: config.branching,
    providers,
    hide_readonly_tools: config.hideReadonlyTools,
    ...(config.editor ? { editor: config.editor } : {}),
  })
}

export function writeConfigV3(config: QuarkConfig, file = configPath()): void {
  const content = serializeConfig(config)
  parseConfigV3(parseYAML(content) as Record<string, unknown>)
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

export function setConfigField<K extends "maxSteps" | "branching" | "hideReadonlyTools">(
  key: K,
  value: QuarkConfig[K],
): void {
  writeConfigV3({ ...loadConfig(), [key]: value })
}

export function resetConfigCache(): void {
  cached = null
}
