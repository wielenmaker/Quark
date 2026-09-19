// Tests for filterCommands — slash command filtering logic

import { describe, test, expect } from "bun:test"
import { filterCommands, commands } from "../../packages/quark/src/tui/commands"

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

  test("c prefix matches compact and connect", () => {
    const result = filterCommands("c")
    expect(result.map((command) => command.id)).toEqual(["compact", "connect"])
  })

  test("connect command opens provider authentication", () => {
    expect(filterCommands("connect")).toEqual([
      { id: "connect", description: "Connect a model provider" },
    ])
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

  test("compact command has an optional goal", () => {
    expect(filterCommands("compact")[0]!.usage).toBe("[goal]")
  })

  test("steer command has no usage hint", () => {
    expect(filterCommands("steer")[0]!.usage).toBeUndefined()
  })

  test("model command has usage hint", () => {
    const result = filterCommands("model")
    expect(result.length).toBe(1)
    expect(result[0]!.usage).toBe("<model-name>")
  })

  test("agent command has usage hint", () => {
    const result = filterCommands("agent")
    expect(result.length).toBe(1)
    expect(result[0]!.usage).toBe("<agent-name>")
  })

  test("profile command remains as a compatibility alias", () => {
    const result = filterCommands("profile")
    expect(result.length).toBe(1)
    expect(result[0]!.description).toMatch(/alias/i)
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
    expect(result[0]!.usage).toBeUndefined()
  })
})
