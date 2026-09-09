import { describe, expect, test } from "bun:test"
import { buildSystem } from "../../src/session/system"

const agent = {
  id: "coder",
  name: "Coder",
  prompt: "Base prompt",
  tools: [],
  skills: [],
}

describe("buildSystem", () => {
  test("includes runtime skill instructions without changing installed skills", () => {
    const runtimeSkill = "# Skill: candidate\n\nCandidate-only instructions"
    const system = buildSystem({ ...agent, runtimeSkills: [runtimeSkill] })

    expect(system).toContain(runtimeSkill)
    expect(system).not.toContain("# Available Skills")
  })
})
