import { describe, expect, test } from "bun:test"
import { filterSlashCommands, slashCommands, slashParts, slashQuery } from "../../web/src/slash"

describe("web slash commands", () => {
  test("treats only leading slash text as a command query", () => {
    expect(slashQuery("/")).toBe("")
    expect(slashQuery("/new")).toBe("new")
    expect(slashQuery("  /new")).toBe(null)
    expect(slashQuery("hello /new")).toBe(null)
    expect(slashQuery("")).toBe(null)
  })

  test("ignores anything after the first line", () => {
    expect(slashQuery("/new\nsome body text")).toBe("new")
  })

  test("separates the command id from its arguments", () => {
    expect(slashParts("/model openai/gpt-5.6-terra")).toEqual({
      id: "model",
      args: "openai/gpt-5.6-terra",
      hasArgs: true,
    })
    expect(slashParts("/compact")).toEqual({ id: "compact", args: "", hasArgs: false })
    expect(slashParts("/steer ship the fix")).toEqual({ id: "steer", args: "ship the fix", hasArgs: true })
  })

  test("treats a trailing space as the start of arguments", () => {
    // The palette closes as soon as the user commits to a command with a space.
    expect(slashParts("/profile ")?.hasArgs).toBe(true)
    expect(slashParts("/profile")).toEqual({ id: "profile", args: "", hasArgs: false })
  })

  test("does not treat plain messages as commands", () => {
    expect(slashParts("hello world")).toBe(null)
    expect(slashParts("1/2 of the file")).toBe(null)
  })

  test("returns every command for an empty query", () => {
    expect(filterSlashCommands("")).toEqual(slashCommands)
  })

  test("ranks prefix matches ahead of substring matches", () => {
    const results = filterSlashCommands("s").map((command) => command.id)
    expect(results.slice(0, 3)).toEqual(["sessions", "skills", "steer"])
    expect(results.slice(3)).not.toContain("sessions")
  })

  test("finds a single command by prefix", () => {
    expect(filterSlashCommands("ex").map((command) => command.id)).toEqual(["export"])
  })

  test("matches against descriptions as a fallback", () => {
    expect(filterSlashCommands("markdown").map((command) => command.id)).toEqual(["export"])
  })

  test("returns nothing when no command matches", () => {
    expect(filterSlashCommands("zzz")).toEqual([])
  })
})
