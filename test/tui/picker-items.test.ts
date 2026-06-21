import { describe, expect, test } from "bun:test"
import { buildPickerItems, pickerModeForCommand } from "../../src/tui/picker-items"

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
  test("opens model, profile, skills, and tools pickers", () => {
    expect(pickerModeForCommand("model")).toBe("models")
    expect(pickerModeForCommand("profile")).toBe("profiles")
    expect(pickerModeForCommand("skills")).toBe("skills")
    expect(pickerModeForCommand("tool list")).toBe("tools")
  })

  test("ignores non-picker commands", () => {
    expect(pickerModeForCommand("help")).toBeNull()
    expect(pickerModeForCommand("new")).toBeNull()
    expect(pickerModeForCommand("clear")).toBeNull()
    // /tool add is the add subcommand, not the list picker
    expect(pickerModeForCommand("tool add")).toBeNull()
  })
})
