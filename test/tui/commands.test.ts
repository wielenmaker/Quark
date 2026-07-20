// Tests for filterCommands — slash command filtering logic

import { describe, test, expect } from "bun:test"
import { filterCommands, commands } from "../../src/tui/commands"

describe("filterCommands", () => {
  test("returns all commands when query is empty", () => {
    const result = filterCommands("")
    expect(result).toEqual(commands)
  })

  test("returns all commands when query is empty with an explicit full limit", () => {
    const result = filterCommands("", commands.length)
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

  test("s prefix includes ship with the other s commands", () => {
    const result = filterCommands("s")
    expect(result.length).toBe(6)
    expect(result.map((c) => c.id)).toContain("sessions")
    expect(result.map((c) => c.id)).toContain("settings")
    expect(result.map((c) => c.id)).toContain("skills")
    expect(result.map((c) => c.id)).toContain("steer")
    expect(result.map((c) => c.id)).toContain("ship")
    expect(result.map((c) => c.id)).toContain("statistics")
  })

  test("ship command has a feature request usage hint", () => {
    const result = filterCommands("ship")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: "ship", usage: "<feature-request>" })
  })

  test("r prefix matches reload-config only", () => {
    const result = filterCommands("r")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("reload-config")
  })

  test("e prefix matches export and exit", () => {
    const result = filterCommands("e")
    expect(result.map((c) => c.id)).toEqual(["export", "exit"])
  })

  test("export command exists in commands list", () => {
    const cmd = commands.find((c) => c.id === "export")
    expect(cmd).toBeDefined()
    expect(cmd!.description).toMatch(/export|markdown/i)
  })

  test("export prefix matches export exclusively", () => {
    const result = filterCommands("export")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("export")
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

// --- /async-msg slash command ---

describe("async-msg command", () => {
  test("async-msg command exists in commands list", () => {
    const cmd = commands.find((c) => c.id === "async-msg")
    expect(cmd).toBeDefined()
    expect(cmd!.description).toMatch(/side|parallel|panel/i)
  })

  test("a prefix matches async-msg", () => {
    const result = filterCommands("a")
    const ids = result.map((c) => c.id)
    expect(ids).toContain("async-msg")
  })

  test("async prefix matches async-msg exclusively", () => {
    const result = filterCommands("async")
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("async-msg")
  })

  test("async-msg has no usage hint", () => {
    const result = filterCommands("async-msg")
    expect(result.length).toBe(1)
    expect(result[0]!.usage).toBeUndefined()
  })
})
