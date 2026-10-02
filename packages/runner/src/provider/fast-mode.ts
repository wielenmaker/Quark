import type { ProviderDefinition } from "./definitions"
import type { ProviderOptions } from "./registry"

/** Speed is independent of reasoning. Do not send OpenAI tiers to other backends. */
export function encodeFastMode(definition: ProviderDefinition, fastMode?: boolean): ProviderOptions | undefined {
  if (fastMode === undefined) return undefined
  if (typeof fastMode !== "boolean") throw new Error("fastMode must be a boolean.")
  if (definition.id !== "openai" && definition.id !== "openai-codex") {
    throw new Error(`Fast mode is not supported for provider "${definition.id}".`)
  }
  return { [definition.providerOptionsKey]: { serviceTier: fastMode ? "priority" : "default" } }
}

/** Merge speed without overwriting reasoning options in the same provider namespace. */
export function withFastMode(
  definition: ProviderDefinition,
  options: ProviderOptions | undefined,
  fastMode?: boolean,
): ProviderOptions | undefined {
  const speed = encodeFastMode(definition, fastMode)
  if (!speed) return options
  const key = definition.providerOptionsKey
  return { ...options, [key]: { ...options?.[key], ...speed[key] } }
}
