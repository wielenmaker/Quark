import { describe, expect, test } from "bun:test"
import { thinkingEnabled, thinkingFill, thinkingFraction, thinkingLabel, thinkingTriggerLabel } from "../../web/src/thinking"
import type { AppStatus } from "../../web/src/types"

function status(thinkingEffort: string, thinkingLevels: string[]): AppStatus {
  return {
    modelName: "openai/gpt-5.6-terra",
    modelLabel: "GPT-5.6 Terra",
    thinkingEffort,
    thinkingLevels,
    tokenLimit: 1_050_000,
    cwd: "/tmp/project",
    branch: "main",
    profile: "general",
  }
}

const LEVELS = ["none", "low", "medium", "high"]

describe("web thinking control", () => {
  test("title-cases effort names", () => {
    expect(thinkingLabel("none")).toBe("None")
    expect(thinkingLabel("high")).toBe("High")
    expect(thinkingLabel("xhigh")).toBe("Xhigh")
  })

  test("prompts for an effort only when thinking is off", () => {
    expect(thinkingTriggerLabel(status("none", LEVELS))).toBe("Select effort")
    expect(thinkingTriggerLabel(status("medium", LEVELS))).toBe("Medium")
  })

  test("treats a model with no levels beyond none as unconfigurable", () => {
    expect(thinkingEnabled(status("none", ["none"]))).toBe(false)
    expect(thinkingEnabled(status("none", ["none", "thinking"]))).toBe(true)
  })

  test("maps the active level onto the track", () => {
    expect(thinkingFraction(status("none", LEVELS))).toBe(0)
    expect(thinkingFraction(status("high", LEVELS))).toBe(1)
    expect(thinkingFraction(status("medium", LEVELS))).toBeCloseTo(2 / 3, 5)
  })

  test("clamps an effort the model no longer supports to the start", () => {
    expect(thinkingFraction(status("max", LEVELS))).toBe(0)
  })

  test("insets the fill by half a knob so it meets the thumb", () => {
    expect(thinkingFill(status("none", LEVELS))).toBe("calc(15px + (100% - 30px) * 0)")
    expect(thinkingFill(status("high", LEVELS))).toBe("calc(15px + (100% - 30px) * 1)")
  })
})
