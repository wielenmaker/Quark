// Tests for filterCommands — slash command filtering logic

import { describe, test, expect } from "bun:test"
import { filterCommands, commands } from "../../src/tui/commands"

describe("filterCommands", () => {
  test("returns all commands when query is empty", () => {
    const result = filterCommands("")
    expect(result).toEqual(commands)
  })

  test("returns all commands when query is empty with default limit", () => {
    // The default cap is 30; with ≤30 commands this returns the full list.
    const result = filterCommands("")
    expect(result.length).toBe(commands.length)
  })

  test("filters by prefix match", () => {
    const result = filterCommands("m")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("model")
  })

  test("filters by longer prefix", () => {
    const result = filterCommands("mod")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("model")
  })

  test("is case-insensitive", () => {
    const result = filterCommands("MODEL")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("model")
  })

  test("c prefix matches clear only", () => {
    const result = filterCommands("c")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("clear")
  })

  test("returns empty array when no commands match", () => {
    const result = filterCommands("zzz")
    expect(result).toEqual([])
  })

  test("respects limit parameter", () => {
    const result = filterCommands("", 2)
    expect(result.length).toBe(2)
  })

  test("returns exact match", () => {
    const result = filterCommands("help")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("help")
  })

  test("sessions command has usage hint", () => {
    const result = filterCommands("sessions")
    expect(result.length).toBe(1)
    expect(result[0]!.usage).toBe("[session-id]")
  })

  test("model command has usage hint", () => {
    const result = filterCommands("model")
    expect(result.length).toBe(1)
    expect(result[0]!.usage).toBe("<model-name>")
  })

  test("profile command has usage hint", () => {
    const result = filterCommands("profile")
    expect(result.length).toBe(1)
    expect(result[0]!.usage).toBe("<profile-name>")
  })

  test("help command has no usage hint", () => {
    const result = filterCommands("help")
    expect(result[0]!.usage).toBeUndefined()
  })

  test("s prefix matches sessions, settings, skills, steer, and statistics", () => {
    const result = filterCommands("s")
    expect(result.length).toBe(5)
    expect(result.map((c) => c.id)).toContain("sessions")
    expect(result.map((c) => c.id)).toContain("settings")
    expect(result.map((c) => c.id)).toContain("skills")
    expect(result.map((c) => c.id)).toContain("steer")
    expect(result.map((c) => c.id)).toContain("statistics")
  })

  test("r prefix matches reload-config only", () => {
    const result = filterCommands("r")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("reload-config")
  })

  test("e prefix matches exit only", () => {
    const result = filterCommands("e")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("exit")
  })

  test("h prefix matches help only", () => {
    const result = filterCommands("h")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("help")
  })

  // --- /skills slash command registration and filtering ---

  test("skills command exists in commands list", () => {
    const skillsCmd = commands.find((c) => c.id === "skills")
    expect(skillsCmd).toBeDefined()
    expect(skillsCmd!.description).toMatch(/skill/i)
  })

  test("sk prefix matches skills", () => {
    const result = filterCommands("sk")
    expect(result.length).toBeGreaterThanOrEqual(1)
    const ids = result.map((c) => c.id)
    expect(ids).toContain("skills")
  })

  test("ski prefix matches skills exclusively", () => {
    const result = filterCommands("ski")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("skills")
  })

  test("skills is case-insensitive in filter", () => {
    const result = filterCommands("SKILLS")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("skills")
  })

  test("skills command does not require a usage hint", () => {
    const result = filterCommands("skills")
    expect(result.length).toBe(1)
    // /skills opens a picker — no argument syntax needed
    expect(result[0]!.usage).toBeUndefined()
  })
})
