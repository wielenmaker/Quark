import { describe, expect, test } from "bun:test"
import {
  FLIP_BOTTOM_FRAME,
  FLIP_DONE_FRAME,
  FLIP_OLD_FRAME,
  FLIP_TOP_FRAME,
  flipPercentText,
  shouldAnimateTokenPercent,
  tokenPercentValue,
} from "../../src/tui/components/flip-percent-frame"

describe("flip percent frame helpers", () => {
  test("calculates token percentage to one decimal", () => {
    expect(tokenPercentValue(0, 0)).toBe(0)
    expect(tokenPercentValue(41000, 1000000)).toBe(4.1)
    expect(tokenPercentValue(45600, 1000000)).toBe(4.6)
    expect(tokenPercentValue(64000, 128000)).toBe(50)
  })

  test("animates only upward percentage changes", () => {
    expect(shouldAnimateTokenPercent(2, 3)).toBe(true)
    expect(shouldAnimateTokenPercent(3, 3)).toBe(false)
    expect(shouldAnimateTokenPercent(3, 0)).toBe(false)
  })

  test("rolls changed digits vertically", () => {
    expect(flipPercentText(4.1, 5.2, FLIP_OLD_FRAME)).toBe("4.1%")
    expect(flipPercentText(4.1, 5.2, FLIP_TOP_FRAME)).toBe("⁴.¹%")
    expect(flipPercentText(4.1, 5.2, FLIP_BOTTOM_FRAME)).toBe("₅.₂%")
    expect(flipPercentText(4.1, 5.2, FLIP_DONE_FRAME)).toBe("5.2%")
  })

  test("keeps transition width stable when digit count grows", () => {
    expect(flipPercentText(9.9, 10, FLIP_OLD_FRAME)).toBe(" 9.9%")
    expect(flipPercentText(9.9, 10, FLIP_TOP_FRAME)).toBe(" ⁹.⁹%")
    expect(flipPercentText(9.9, 10, FLIP_BOTTOM_FRAME)).toBe("₁₀.₀%")
    expect(flipPercentText(9.9, 10, FLIP_DONE_FRAME)).toBe("10.0%")
  })
})
