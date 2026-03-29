// Config loader — reads ~/.config/atom/config.yaml
//
// Model-related keys live alongside profile config in the same YAML file:
//   models:      [claude-sonnet-4.5, gpt-4o, ...]  # user's curated favorites (shown in /model picker)
//   main_model:  claude-sonnet-4.5                  # main agent loop
//   small_model: gpt-4o-mini                        # lightweight tasks (title generation, etc.)
//
// Provider is always embedded in the model string as "provider/model".
// If no provider prefix is given, defaults to "copilot".
//
// Missing file or fields fall back to sensible defaults.

import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"

const CONFIG_DIR = path.join(os.homedir(), ".config", "atom")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml")

// ---------------------------------------------------------------------------
// Session DB path — ~/.config/quark/session/<sha1-of-cwd>/quark.db
// ---------------------------------------------------------------------------

export const SESSION_DIR = path.join(os.homedir(), ".config", "quark", "session")

/**
 * Returns the DB file path for a given project directory.
 * Path: ~/.config/quark/session/<sha1-of-cwd>/quark.db
 * Creates the session directory if it doesn't exist.
 */
export function getDBPath(cwd?: string): string {
  const dir = path.resolve(cwd ?? process.cwd())
  const id = createHash("sha1").update(dir).digest("hex").slice(0, 12)
  const sessionDir = path.join(SESSION_DIR, id)
  fs.mkdirSync(sessionDir, { recursive: true })
  return path.join(sessionDir, "quark.db")
}

// ---------------------------------------------------------------------------
// Compact config — nested under AtomConfig
// ---------------------------------------------------------------------------

export interface CompactConfig {
  /** Which compaction method to use. Default: "general" */
  method: string
  /** Number of recent user/assistant turn pairs to keep verbatim. Default: 5 */
  retain_turns: number
  /**
   * Fraction of the model's context window at which auto-compaction triggers.
   * e.g. 0.95 means compact when estimated tokens >= 95% of context_window.
   * Default: 0.95
   */
  threshold: number
  /** Enable auto-compaction. Default: true */
  auto: boolean
}

const COMPACT_DEFAULTS: CompactConfig = {
  method: "general",
  retain_turns: 5,
  threshold: 0.95,
  auto: true,
}

// ---------------------------------------------------------------------------
// Provider config — user-defined OpenAI-compatible providers
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  /** Base URL for the OpenAI-compatible API (e.g. "http://localhost:11434/v1") */
  baseURL: string
  /** API key — literal string or "env:VAR_NAME" to read from environment */
  apiKey: string
}

// ---------------------------------------------------------------------------
// AtomConfig — top-level config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  models: [
    "gpt-4o",
    "gpt-4o-mini",
    "claude-sonnet-4",
    "claude-haiku-3.5",
    "gemini-2.5-pro",
    "o4-mini",
  ] as readonly string[],
  small_model: "gpt-4o-mini",
  main_model: "gpt-4o",
  max_steps: 100,
  context_window: 100_000,
  compact: COMPACT_DEFAULTS,
  providers: {} as Record<string, ProviderConfig>,
} as const

export interface AtomConfig {
  models: string[]
  small_model: string
  main_model: string
  max_steps: number
  /** Fallback context window (tokens) when models.dev doesn't have the model. */
  context_window: number
  compact: CompactConfig
  /** User-defined OpenAI-compatible providers (keyed by provider ID) */
  providers: Record<string, ProviderConfig>
}

// Cached config — loaded once, reused thereafter
let cached: AtomConfig | null = null

// Runtime-registered providers — added by plugins, not from config.yaml
const runtimeProviders: Record<string, ProviderConfig> = {}

function readRawConfig(): Record<string, unknown> {
  try {
    const content = fs.readFileSync(CONFIG_FILE, "utf-8")
    const raw = parseYAML(content) as Record<string, unknown>
    return raw && typeof raw === "object" ? raw : {}
  } catch {
    return {}
  }
}

function parseCompactConfig(raw: unknown): CompactConfig {
  if (!raw || typeof raw !== "object") return { ...COMPACT_DEFAULTS }
  const r = raw as Record<string, unknown>
  return {
    method: typeof r.method === "string" && r.method ? r.method : COMPACT_DEFAULTS.method,
    retain_turns:
      typeof r.retain_turns === "number" && r.retain_turns > 0
        ? r.retain_turns
        : COMPACT_DEFAULTS.retain_turns,
    threshold:
      typeof r.threshold === "number" && r.threshold > 0 && r.threshold <= 1
        ? r.threshold
        : COMPACT_DEFAULTS.threshold,
    auto: typeof r.auto === "boolean" ? r.auto : COMPACT_DEFAULTS.auto,
  }
}

function parseProviders(raw: unknown): Record<string, ProviderConfig> {
  if (!raw || typeof raw !== "object") return {}
  const result: Record<string, ProviderConfig> = {}
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue
    const v = val as Record<string, unknown>
    if (typeof v.baseURL !== "string" || !v.baseURL) continue
    result[id] = {
      baseURL: v.baseURL,
      apiKey: typeof v.apiKey === "string" ? v.apiKey : "",
    }
  }
  return result
}

/**
 * Resolve an apiKey value. If it starts with "env:", read from the environment.
 * Otherwise return the literal string.
 */
export function resolveApiKey(raw: string): string {
  if (raw.startsWith("env:")) {
    return process.env[raw.slice(4)] ?? ""
  }
  return raw
}

/**
 * Load config from disk. Returns defaults for any missing or invalid fields.
 * Never throws — config is best-effort.
 */
export function loadConfig(): AtomConfig {
  if (cached) return cached

  const raw = readRawConfig()

  cached = {
    models:
      Array.isArray(raw.models) && raw.models.every((m: unknown) => typeof m === "string")
        ? (raw.models as string[])
        : [...DEFAULTS.models],
    small_model:
      typeof raw.small_model === "string" && raw.small_model
        ? raw.small_model
        : DEFAULTS.small_model,
    main_model:
      typeof raw.main_model === "string" && raw.main_model
        ? raw.main_model
        : DEFAULTS.main_model,
    max_steps:
      typeof raw.max_steps === "number" ? raw.max_steps : DEFAULTS.max_steps,
    context_window:
      typeof raw.context_window === "number" ? raw.context_window : DEFAULTS.context_window,
    compact: parseCompactConfig(raw.compact),
    providers: parseProviders(raw.providers),
  }

  return cached
}

/**
 * Parse a possibly-namespaced model spec like "copilot/claude-sonnet-4.6"
 * into { provider, model }. If no "/" is present, provider is undefined.
 */
export function parseModelSpec(spec: string): { provider?: string; model: string } {
  const idx = spec.indexOf("/")
  if (idx === -1) return { model: spec }
  return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) }
}

/**
 * Get the model ID for a given purpose (strips provider prefix if present).
 */
export function getModelId(kind: "main" | "small"): string {
  const config = loadConfig()
  const raw = kind === "small" ? config.small_model : config.main_model
  return parseModelSpec(raw).model
}

/**
 * Get both provider and model for a given purpose.
 * Provider is embedded in the model string as "provider/model".
 * If no provider prefix, defaults to "copilot".
 */
export function getModelSpec(kind: "main" | "small"): { provider: string; model: string } {
  const config = loadConfig()
  const raw = kind === "small" ? config.small_model : config.main_model
  const parsed = parseModelSpec(raw)
  return {
    provider: parsed.provider ?? "copilot",
    model: parsed.model,
  }
}

export function getProviderId(kind: "main" | "small"): string {
  return getModelSpec(kind).provider
}

/**
 * Look up a provider's config by ID.
 * Checks runtime-registered providers first (added by plugins), then config.yaml.
 * Returns null if not defined in either.
 */
export function getProviderConfig(id: string): ProviderConfig | null {
  if (runtimeProviders[id]) return runtimeProviders[id]!
  const config = loadConfig()
  return config.providers[id] ?? null
}

/**
 * Register a provider at runtime (e.g. from a plugin).
 * Takes precedence over config.yaml providers for the same ID.
 * Does NOT persist to disk.
 */
export function registerProvider(id: string, config: ProviderConfig): void {
  runtimeProviders[id] = config
}

/**
 * Update a config field and persist to disk.
 * Merges with existing config — only overwrites the specified field.
 */
export function setConfigField<K extends keyof AtomConfig>(
  key: K,
  value: AtomConfig[K],
): void {
  const raw = readRawConfig()

  raw[key] = value
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, stringifyYAML(raw), "utf-8")

  // Invalidate cache so next read picks up the change
  cached = null
}

/**
 * Clear cached config — useful if config file changes at runtime.
 */
export function resetConfigCache(): void {
  cached = null
}
