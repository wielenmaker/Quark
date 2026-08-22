// Tests for autocomplete dropdown background — verifies that the dropdown
// renders with a solid background color that matches the terminal background,
// preventing text bleed-through from underlying content.

import { beforeEach, describe, test, expect } from "bun:test"
import { RGBA } from "@opentui/core"
import { activeTheme, applyTheme, colors, setTerminalBg } from "../../src/tui/theme"
import { darkTheme } from "../../src/tui/themes/dark"
import { scrollTopForSelection } from "../../src/tui/components/autocomplete-scroll"
import type { AutocompleteMode } from "../../src/tui/components/autocomplete"
import { sessionControls } from "../../src/tui/session-controls"

describe("autocomplete dropdown background", () => {
  beforeEach(() => {
    applyTheme(darkTheme)
  })

  test("theme has a dropdownBg color defined", () => {
    expect(colors.dropdownBg).toBeDefined()
    expect(colors.dropdownBg).toBeInstanceOf(RGBA)
  })

  test("dropdownBg is a fully opaque color", () => {
    const bg = colors.dropdownBg
    expect(bg.a).toBe(1)
  })

  test("default dark dropdownBg matches the dark background fallback", () => {
    const expected = RGBA.fromHex("#21252A")
    expect(colors.dropdownBg.r).toBeCloseTo(expected.r, 2)
    expect(colors.dropdownBg.g).toBeCloseTo(expected.g, 2)
    expect(colors.dropdownBg.b).toBeCloseTo(expected.b, 2)
  })

  test("setTerminalBg keeps dropdownBg matched to detected terminal color", () => {
    const detected = RGBA.fromHex("#2b2b3c")
    setTerminalBg(detected)
    expect(colors.dropdownBg).toBe(detected)
    expect(activeTheme.name).toBe("dark")
  })

  test("setTerminalBg updated color is fully opaque", () => {
    const detected = RGBA.fromHex("#1c1c1c")
    setTerminalBg(detected)
    expect(colors.dropdownBg.a).toBe(1)
  })

  test("setTerminalBg still applies the light theme for light backgrounds", () => {
    const detected = RGBA.fromHex("#ffffff")
    setTerminalBg(detected)
    expect(colors.dropdownBg).toBe(detected)
    expect(activeTheme.name).toBe("light")
  })
})

describe("scrollTopForSelection", () => {
  // The session picker has 8 visible rows and no title row. The cursor
  // should anchor at visual row 3 (the 4th row) once the list is long enough
  // to scroll.
  const sessionMode = {
    type: "sessions" as const,
    rows: [],
    selectedIndex: 0,
    query: "",
    action: "browse" as const,
    scope: "worktree" as const,
  }

  test("returns 0 when the list fits in the viewport (no scroll needed)", () => {
    expect(scrollTopForSelection(sessionMode, 0, 3, 8)).toBe(0)
    expect(scrollTopForSelection(sessionMode, 2, 3, 8)).toBe(0)
  })

  test("anchors the cursor at row 3 once scrolled (top of list)", () => {
    // selectedIndex 0..2: scrollTop stays at 0 (cursor moves down naturally)
    expect(scrollTopForSelection(sessionMode, 0, 20, 8)).toBe(0)
    expect(scrollTopForSelection(sessionMode, 3, 20, 8)).toBe(0)
    // selectedIndex 4: cursor at visual row 3 (4 - 0 - 3 = 1? no, 4-3=1)
    // Actually: scrollTop = max(0, 4 - 3) = 1
    expect(scrollTopForSelection(sessionMode, 4, 20, 8)).toBe(1)
  })

  test("keeps the cursor anchored at row 3 as the user scrolls down", () => {
    // For selectedIndex 5..N-1-(8-3) = N-5, scrollTop = selectedIndex - 3
    expect(scrollTopForSelection(sessionMode, 5, 20, 8)).toBe(2)
    expect(scrollTopForSelection(sessionMode, 10, 20, 8)).toBe(7)
    expect(scrollTopForSelection(sessionMode, 15, 20, 8)).toBe(12)
  })

  test("clamps to the bottom of the list (cursor at the last visible row)", () => {
    // maxScrollTop = 20 - 8 = 12. For selectedIndex 19: scrollTop would be 16,
    // clamp to 12. Cursor at visual row 19 - 12 = 7 (last row).
    expect(scrollTopForSelection(sessionMode, 19, 20, 8)).toBe(12)
    expect(scrollTopForSelection(sessionMode, 18, 20, 8)).toBe(12)
    // selectedIndex 15: scrollTop = 12, cursor at visual row 3 (anchored)
    expect(scrollTopForSelection(sessionMode, 15, 20, 8)).toBe(12)
  })

  test("compacts pickers anchor at row 2 (5 visible rows)", () => {
    const filesMode = { type: "files" as const, items: [], selectedIndex: 0, query: "" }
    // maxScrollTop = 20 - 5 = 15
    expect(scrollTopForSelection(filesMode, 0, 20, 5)).toBe(0)
    expect(scrollTopForSelection(filesMode, 2, 20, 5)).toBe(0)
    expect(scrollTopForSelection(filesMode, 3, 20, 5)).toBe(1)
    expect(scrollTopForSelection(filesMode, 10, 20, 5)).toBe(8)
    expect(scrollTopForSelection(filesMode, 19, 20, 5)).toBe(15)
  })

  test("choice pickers account for the title row at index 0", () => {
    const modelsMode = { type: "models" as const, items: [], selectedIndex: 0 }
    // selectedIndex 0 → scrollIndex 1 (after title) → ideal -1, clamp to 0
    expect(scrollTopForSelection(modelsMode, 0, 20, 5)).toBe(0)
    // selectedIndex 2 → scrollIndex 3 → ideal 1
    expect(scrollTopForSelection(modelsMode, 2, 20, 5)).toBe(1)
    // selectedIndex 19 → scrollIndex 20 → ideal 18, clamp to 15
    expect(scrollTopForSelection(modelsMode, 19, 20, 5)).toBe(15)
  })
})

describe("session picker controls", () => {
  test("uses a shorter key guide on narrow terminals", () => {
    expect(sessionControls(140, "browse")).toContain("Alt+1…9")
    expect(sessionControls(90, "browse")).not.toContain("Alt+1…9")
    expect(sessionControls(60, "browse").length).toBeLessThan(54)
  })
})
