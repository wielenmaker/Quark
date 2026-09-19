import { describe, expect, test } from "bun:test"
import { buildPickerItems, pickerModeForCommand } from "../../packages/quark/src/tui/picker-items"

describe("buildPickerItems", () => {
  test("sorts current item first and marks it", () => {
    const items = buildPickerItems(
      [
        { id: "coder", name: "coder" },
        { id: "researcher", name: "researcher" },
      ],
      "researcher",
    )

    expect(items[0]).toEqual({
      id: "researcher",
      label: "researcher",
      detail: "",
      isCurrent: true,
    })
  })

  test("filters by id or name", () => {
    const items = buildPickerItems(
      [
        { id: "coder", name: "Coder" },
        { id: "researcher", name: "Research Agent" },
      ],
      "coder",
      "agent",
    )

    expect(items.map((i) => i.id)).toEqual(["researcher"])
  })
})

describe("pickerModeForCommand", () => {
  test("opens the agent picker", () => {
    expect(pickerModeForCommand("agent")).toBe("agents")
  })

  test("/profile is a compatibility alias for the agent picker", () => {
    expect(pickerModeForCommand("profile")).toBe("agents")
  })

  test("ignores non-picker commands", () => {
    expect(pickerModeForCommand("help")).toBeNull()
    expect(pickerModeForCommand("model")).toBeNull()
    expect(pickerModeForCommand("skills")).toBeNull()
    expect(pickerModeForCommand("new")).toBeNull()
  })
})
