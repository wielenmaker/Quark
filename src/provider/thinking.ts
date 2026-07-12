// ThinkingNormalizer — converts a thinking config into
// provider-specific providerOptions for the AI SDK streamText() call.
//
// Each model entry is self-describing: it declares its own
// effort levels, field names, and toggle/adaptive fields.
// No effort normalization — the API fields are whatever the
// model actually requires.

import type { JSONObject } from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Model thinking entry
// ---------------------------------------------------------------------------

type ThinkingEntry = {
  /** Field name for the effort value (e.g. "reasoningEffort", "reasoning_effort", "effort") */
  effortField?: string
  /** Fields always sent when thinking is enabled (toggle, adaptive, summary, etc.) */
  thinkingField?: JSONObject
  /** Valid effort levels including "none" as the off state */
  levels: string[]
  /** Provider option field for a reasoning mode */
  modeField?: string
  /** Valid reasoning modes for this model */
  modes?: string[]
  /** Default reasoning mode when thinking is enabled */
  defaultMode?: string
}

// ---------------------------------------------------------------------------
// Model thinking dictionary
// ---------------------------------------------------------------------------

const MODEL_THINKING: Record<string, ThinkingEntry> = {
  // Claude — adaptive thinking via @ai-sdk/anthropic
  "claude-opus-4-7": {
    effortField: "effort",
    thinkingField: { thinking: { type: "adaptive" } },
    levels: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  "claude-opus-4-6": {
    effortField: "effort",
    thinkingField: { thinking: { type: "adaptive" } },
    levels: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  "claude-sonnet-4-6": {
    effortField: "effort",
    thinkingField: { thinking: { type: "adaptive" } },
    levels: ["none", "low", "medium", "high", "xhigh", "max"],
  },

  // OpenAI — reasoning effort
  "gpt-5": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "gpt-5.5": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "gpt-5.5-pro": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "gpt-5.6": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "low", "medium", "high", "xhigh", "max"],
    modeField: "reasoningMode",
    modes: ["standard", "pro"],
    defaultMode: "standard",
  },
  "gpt-5.6-sol": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "low", "medium", "high", "xhigh", "max"],
    modeField: "reasoningMode",
    modes: ["standard", "pro"],
    defaultMode: "standard",
  },
  "gpt-5.6-terra": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "low", "medium", "high", "xhigh", "max"],
    modeField: "reasoningMode",
    modes: ["standard", "pro"],
    defaultMode: "standard",
  },
  "gpt-5.6-luna": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "low", "medium", "high", "xhigh", "max"],
    modeField: "reasoningMode",
    modes: ["standard", "pro"],
    defaultMode: "standard",
  },
  "gpt-5.4": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "gpt-5.4-pro": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "gpt-5.2": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "gpt-5-mini": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "gpt-5-nano": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "o4-mini": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "o3": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  "o1": {
    effortField: "reasoningEffort",
    thinkingField: { reasoningSummary: "auto" },
    levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },

  // Qwen — binary toggle, no effort levels
  "qwen-max":    { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },
  "qwen-plus":   { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },
  "qwen-turbo":  { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },
  "qwen3-max":   { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },
  "qwen3-plus":  { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },
  "qwen3.6-plus": { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },
  "qwen3.6":     { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },

  // MiniMax / GLM — binary toggle
  "minimax-m2.7": { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },
  "glm-5.1":      { thinkingField: { enable_thinking: true }, levels: ["none", "thinking"] },

  // Kimi — binary toggle via thinking.type
  "kimi-": { thinkingField: { thinking: { type: "enabled" } }, levels: ["none", "thinking"] },

  // DeepSeek — toggle + effort via raw API fields
  "deepseek-": {
    effortField: "reasoningEffort",
    thinkingField: { thinking: { type: "enabled" } },
    levels: ["none", "high", "max"],
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ProviderOptions = Record<string, JSONObject>

/** Backward-compatible type alias — now just a string */
export type ThinkingEffort = string

export interface ThinkingConfig {
  effort: string
  mode: string
  modeExplicit: boolean
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function lookupThinkingEntry(modelId: string): ThinkingEntry | undefined {
  const bareModel = modelId.includes("/") ? modelId.split("/").pop()! : modelId

  if (MODEL_THINKING[bareModel]) return MODEL_THINKING[bareModel]

  for (const [key, entry] of Object.entries(MODEL_THINKING)) {
    if (bareModel.startsWith(key)) return entry
  }

  return undefined
}

export function validateThinkingEffort(modelId: string, effort: string): void {
  const entry = lookupThinkingEntry(modelId)
  if (!entry) {
    throw new Error(`Thinking is not supported by model "${modelId}".`)
  }
  if (!entry.levels.includes(effort)) {
    throw new Error(
      `Invalid thinking effort "${effort}" for model "${modelId}". Supported efforts: ${entry.levels.join(", ")}.`,
    )
  }
}

export function getDefaultThinkingEffort(modelId: string): string {
  const entry = lookupThinkingEntry(modelId)
  return entry?.levels.includes("none") ? "none" : entry?.levels[0] ?? "none"
}

/**
 * Get the available effort levels for a model's UI.
 * Returns null if the model doesn't support thinking.
 */
export function getThinkingLevels(modelId: string): string[] | null {
  const entry = lookupThinkingEntry(modelId)
  return entry ? entry.levels : null
}

/**
 * Get the available reasoning modes for a model.
 * Returns null when the model does not support explicit modes.
 */
export function getThinkingModes(modelId: string): string[] | null {
  const modes = lookupThinkingEntry(modelId)?.modes
  return modes ? [...modes] : null
}

// ---------------------------------------------------------------------------
// ThinkingNormalizer
// ---------------------------------------------------------------------------

/**
 * ThinkingNormalizer — produces providerOptions for streamText()
 */
export class ThinkingNormalizer {
  private config: ThinkingConfig
  private modelId: string

  constructor(modelId: string, config?: Partial<ThinkingConfig>) {
    this.modelId = modelId
    this.config = {
      effort: config?.effort ?? "none",
      mode: config?.mode ?? "standard",
      modeExplicit: config?.modeExplicit ?? false,
    }
  }

  /** Update thinking configuration */
  configure(config: Partial<ThinkingConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /** Get current thinking config */
  getConfig(): ThinkingConfig {
    return { ...this.config }
  }

  /**
   * Normalize thinking config into provider-specific options.
   * @param providerId — the provider ID as used in config.yaml (e.g. "copilot", "anthropic")
   * @returns providerOptions or undefined if thinking is disabled or unsupported
   */
  normalize(providerId: string): ProviderOptions | undefined {
    if (this.config.effort === "none") return undefined

    const entry = lookupThinkingEntry(this.modelId)
    if (!entry) return undefined

    validateThinkingEffort(this.modelId, this.config.effort)

    if (!entry.modeField) {
      if (this.config.modeExplicit) {
        throw new Error(
          `thinking_mode is not supported by model "${this.modelId}". Remove thinking_mode or choose a model that supports modes.`,
        )
      }
    } else {
      const mode = this.config.mode || entry.defaultMode
      if (!mode || !entry.modes?.includes(mode)) {
        throw new Error(
          `Invalid thinking_mode "${mode}" for model "${this.modelId}". Supported modes: ${entry.modes?.join(", ")}.`,
        )
      }
    }

    const merged = { ...entry.thinkingField } as JSONObject
    if (entry.effortField) {
      merged[entry.effortField] = this.config.effort
    }
    if (entry.modeField) {
      merged[entry.modeField] = this.config.mode || entry.defaultMode
    }

    // Map provider → providerOptions key:
    //   @ai-sdk/openai              → "openai"
    //   @ai-sdk/anthropic           → "anthropic"
    //   @ai-sdk/openai-compatible   → provider name (e.g. "copilot", "deepseek")
    const key = providerId === "openai" ? "openai"
      : providerId === "anthropic" ? "anthropic"
      : providerId
    return { [key]: merged }
  }
}

// ---------------------------------------------------------------------------
// Singleton for session-level thinking state
// ---------------------------------------------------------------------------

let _normalizer: ThinkingNormalizer | undefined
let _currentModelId = ""

export function getThinkingNormalizer(modelId?: string): ThinkingNormalizer {
  if (!_normalizer || (modelId && modelId !== _currentModelId)) {
    const prior = _normalizer?.getConfig()
    _currentModelId = modelId || _currentModelId
    _normalizer = new ThinkingNormalizer(_currentModelId, prior)
  }
  return _normalizer
}

export function resetThinkingNormalizer(): void {
  _normalizer = undefined
  _currentModelId = ""
}
