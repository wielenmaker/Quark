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
    const profilesMode = { type: "profiles" as const, items: [], selectedIndex: 0 }
    // selectedIndex 0 → scrollIndex 1 (after title) → ideal -1, clamp to 0
    expect(scrollTopForSelection(profilesMode, 0, 20, 5)).toBe(0)
    // selectedIndex 2 → scrollIndex 3 → ideal 1
    expect(scrollTopForSelection(profilesMode, 2, 20, 5)).toBe(1)
    // selectedIndex 19 → scrollIndex 20 → ideal 18, clamp to 15
    expect(scrollTopForSelection(profilesMode, 19, 20, 5)).toBe(15)
  })

  test("profile pickers scroll once selection moves below the visible rows", () => {
    const profilesMode = { type: "profiles" as const, items: [], selectedIndex: 0 }
    // Five visible rows include the title and four profiles. Moving to the
    // fifth profile advances the window so its selected row remains visible.
    expect(scrollTopForSelection(profilesMode, 4, 10, 5)).toBe(3)
  })
})

describe("session picker controls", () => {
  test("uses the actions menu shortcut at every width", () => {
    expect(sessionControls(140, "browse")).toContain("Ctrl+K actions")
    expect(sessionControls(90, "browse")).toContain("Ctrl+K actions")
    expect(sessionControls(60, "browse")).toContain("Ctrl+K")
    expect(sessionControls(60, "browse").length).toBeLessThan(54)
  })

  test("does not offer scope switching or deletion", () => {
    expect(sessionControls(140, "browse")).not.toContain("scope")
    expect(sessionControls(140, "browse")).not.toContain("delete")
  })
})
