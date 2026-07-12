import { describe, test, expect } from "bun:test"
import {
  getDefaultThinkingEffort,
  getThinkingLevels,
  getThinkingModes,
  getThinkingNormalizer,
  resetThinkingNormalizer,
} from "../../src/provider/thinking"

import { beforeEach } from "bun:test"

beforeEach(() => resetThinkingNormalizer())

describe("getDefaultThinkingEffort", () => {
  test("uses none for models that support it and unknown models", () => {
    expect(getDefaultThinkingEffort("opencode/deepseek-v4-pro")).toBe("none")
    expect(getDefaultThinkingEffort("unknown-model")).toBe("none")
  })
})

describe("getThinkingLevels", () => {
  test("returns effort levels for gpt-5", () => {
    const levels = getThinkingLevels("gpt-5")
    expect(levels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
  })

  test("returns effort levels for claude-opus-4-7", () => {
    const levels = getThinkingLevels("claude-opus-4-7")
    expect(levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  })

  test("returns binary levels for qwen3-max", () => {
    const levels = getThinkingLevels("qwen3-max")
    expect(levels).toEqual(["none", "thinking"])
  })

  test("returns effort levels for deepseek", () => {
    const levels = getThinkingLevels("deepseek-v4-pro")
    expect(levels).toEqual(["none", "high", "max"])
  })

  test("returns null for unknown model", () => {
    const levels = getThinkingLevels("unknown-model")
    expect(levels).toBeNull()
  })

  test("prefix matches kimi- models", () => {
    const levels = getThinkingLevels("kimi-k2-thinking")
    expect(levels).toEqual(["none", "thinking"])
  })

  // ── gpt-5.6 models (issue #161) ────────────────────────────────────────

  test("returns effort levels for gpt-5.6", () => {
    const levels = getThinkingLevels("gpt-5.6")
    expect(levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  })

  test("returns effort levels for gpt-5.6-luna", () => {
    const levels = getThinkingLevels("gpt-5.6-luna")
    expect(levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  })

  test("returns effort levels for gpt-5.6-terra", () => {
    const levels = getThinkingLevels("gpt-5.6-terra")
    expect(levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  })

  test("returns effort levels for gpt-5.6-sol", () => {
    const levels = getThinkingLevels("gpt-5.6-sol")
    expect(levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  })
})

describe("getThinkingModes", () => {
  test("returns explicit modes for gpt-5.6 models", () => {
    expect(getThinkingModes("codex/gpt-5.6-luna")).toEqual(["standard", "pro"])
  })

  test("returns null for models without explicit modes", () => {
    expect(getThinkingModes("copilot/gpt-5")).toBeNull()
    expect(getThinkingModes("unknown-model")).toBeNull()
  })
})

describe("ThinkingNormalizer normalize", () => {
  test("defaults to effort none without an enabled field", () => {
    const normalizer = getThinkingNormalizer("gpt-5")
    expect(normalizer.getConfig()).toEqual({ effort: "none", mode: "standard", modeExplicit: false })
    expect(normalizer.normalize("copilot")).toBeUndefined()
  })

  test("qwen3-max uses correct providerOptions key", () => {
    const normalizer = getThinkingNormalizer("qwen3-max")
    normalizer.configure({ effort: "thinking" })
    const result = normalizer.normalize("copilot")
    expect(result).toBeDefined()
    expect(result!.copilot).toEqual({ enable_thinking: true })
  })

  test("gpt-5 uses correct providerOptions key", () => {
    const normalizer = getThinkingNormalizer("gpt-5")
    normalizer.configure({ effort: "medium" })
    const result = normalizer.normalize("copilot")
    expect(result).toBeDefined()
    expect(result!.copilot!.reasoningEffort).toBe("medium")
    expect(result!.copilot!.reasoningSummary).toBe("auto")
  })

  test("claude-opus-4-7 uses anthropic key", () => {
    const normalizer = getThinkingNormalizer("claude-opus-4-7")
    normalizer.configure({ effort: "low" })
    const result = normalizer.normalize("anthropic")
    expect(result).toBeDefined()
    expect(result!.anthropic!.thinking).toEqual({ type: "adaptive" })
    expect(result!.anthropic!.effort).toBe("low")
  })

  test("deepseek uses correct key with reasoningEffort and thinking toggle", () => {
    const normalizer = getThinkingNormalizer("deepseek-v4-pro")
    normalizer.configure({ effort: "high" })
    const result = normalizer.normalize("copilot")
    expect(result).toBeDefined()
    expect(result!.copilot!.reasoningEffort).toBe("high")
    expect(result!.copilot!.thinking).toEqual({ type: "enabled" })
  })

  test("returns undefined when effort is none", () => {
    const normalizer = getThinkingNormalizer("gpt-5")
    normalizer.configure({ effort: "none" })
    const result = normalizer.normalize("copilot")
    expect(result).toBeUndefined()
  })

  test("returns undefined for unknown model", () => {
    const normalizer = getThinkingNormalizer("unknown-model")
    normalizer.configure({ effort: "high" })
    const result = normalizer.normalize("copilot")
    expect(result).toBeUndefined()
  })

  test("rejects an effort unsupported by the configured model", () => {
    const normalizer = getThinkingNormalizer("deepseek-v4-flash")
    normalizer.configure({ effort: "xhigh" })

    expect(() => normalizer.normalize("opencode")).toThrow(
      'Invalid thinking effort "xhigh" for model "deepseek-v4-flash". Supported efforts: none, high, max.',
    )
  })

  test("kimi uses correct key with thinking type enabled", () => {
    const normalizer = getThinkingNormalizer("kimi-k2.6")
    normalizer.configure({ effort: "thinking" })
    const result = normalizer.normalize("copilot")
    expect(result).toBeDefined()
    expect(result!.copilot!.thinking).toEqual({ type: "enabled" })
  })

  test("binary model with effort=none returns undefined", () => {
    const normalizer = getThinkingNormalizer("qwen3-max")
    normalizer.configure({ effort: "none" })
    const result = normalizer.normalize("copilot")
    expect(result).toBeUndefined()
  })

  // ── gpt-5.6 models — codex provider normalizer (issue #161) ────────────

  test("gpt-5.6-luna normalizes for codex provider with reasoningEffort and reasoningSummary", () => {
    const normalizer = getThinkingNormalizer("gpt-5.6-luna")
    normalizer.configure({ effort: "high" })
    const result = normalizer.normalize("codex")
    expect(result).toBeDefined()
    expect(result!.codex!.reasoningEffort).toBe("high")
    expect(result!.codex!.reasoningSummary).toBe("auto")
  })

  test("gpt-5.6-terra normalizes for codex provider with reasoningEffort", () => {
    const normalizer = getThinkingNormalizer("gpt-5.6-terra")
    normalizer.configure({ effort: "medium" })
    const result = normalizer.normalize("codex")
    expect(result).toBeDefined()
    expect(result!.codex!.reasoningEffort).toBe("medium")
    expect(result!.codex!.reasoningSummary).toBe("auto")
  })

  test("gpt-5.6-sol normalizes for codex provider with max effort", () => {
    const normalizer = getThinkingNormalizer("gpt-5.6-sol")
    normalizer.configure({ effort: "xhigh" })
    const result = normalizer.normalize("codex")
    expect(result).toBeDefined()
    expect(result!.codex!.reasoningEffort).toBe("xhigh")
    expect(result!.codex!.reasoningSummary).toBe("auto")
  })

  test("gpt-5.6 emits the default standard mode", () => {
    const normalizer = getThinkingNormalizer("gpt-5.6")
    normalizer.configure({ effort: "high" })
    expect(normalizer.normalize("codex")!.codex!.reasoningMode).toBe("standard")
  })

  test("gpt-5.6 emits an explicit pro mode", () => {
    const normalizer = getThinkingNormalizer("gpt-5.6")
    normalizer.configure({ effort: "high", mode: "pro", modeExplicit: true })
    expect(normalizer.normalize("codex")!.codex!.reasoningMode).toBe("pro")
  })

  test("rejects invalid mode for gpt-5.6", () => {
    const normalizer = getThinkingNormalizer("gpt-5.6")
    normalizer.configure({ effort: "high", mode: "ultra", modeExplicit: true })
    expect(() => normalizer.normalize("codex")).toThrow('Invalid thinking_mode "ultra"')
  })

  test("rejects explicit mode for a model without mode support", () => {
    const normalizer = getThinkingNormalizer("gpt-5")
    normalizer.configure({ effort: "high", mode: "pro", modeExplicit: true })
    expect(() => normalizer.normalize("copilot")).toThrow("thinking_mode is not supported")
  })

  test("ignores default mode for a model without mode support", () => {
    const normalizer = getThinkingNormalizer("gpt-5")
    normalizer.configure({ effort: "high", mode: "standard", modeExplicit: false })
    expect(normalizer.normalize("copilot")!.copilot!.reasoningMode).toBeUndefined()
  })

  test("effort none disables mode validation", () => {
    const normalizer = getThinkingNormalizer("gpt-5")
    normalizer.configure({ effort: "none", mode: "ultra", modeExplicit: true })
    expect(normalizer.normalize("copilot")).toBeUndefined()
  })

  test("gpt-5.6-luna returns undefined when effort is none", () => {
    const normalizer = getThinkingNormalizer("gpt-5.6-luna")
    normalizer.configure({ effort: "none" })
    const result = normalizer.normalize("codex")
    expect(result).toBeUndefined()
  })
})
