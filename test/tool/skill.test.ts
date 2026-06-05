// Tests for skill discovery and loading

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { discoverSkills, loadSkill, clearCache } from "../../src/skill/skill"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-skill-test-"))
  clearCache()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearCache()
})

function writeSkill(dir: string, name: string, description: string, content: string) {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${content}`,
  )
}

describe("discoverSkills", () => {
  test("returns empty array when no skills exist", () => {
    const skills = discoverSkills([path.join(tmpDir, "nonexistent")])
    expect(skills).toEqual([])
  })

  test("discovers skills in a directory", () => {
    writeSkill(tmpDir, "test-skill", "A test skill", "Do the test thing.")
    const skills = discoverSkills([tmpDir])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe("test-skill")
    expect(skills[0]!.description).toBe("A test skill")
    expect(skills[0]!.content).toBe("Do the test thing.")
  })

  test("discovers multiple skills", () => {
    writeSkill(tmpDir, "alpha", "Alpha skill", "Alpha content")
    writeSkill(tmpDir, "beta", "Beta skill", "Beta content")
    const skills = discoverSkills([tmpDir])
    expect(skills).toHaveLength(2)
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(["alpha", "beta"])
  })

  test("later directories override earlier ones (project > global)", () => {
    const globalDir = path.join(tmpDir, "global")
    const projectDir = path.join(tmpDir, "project")
    writeSkill(globalDir, "shared", "Global version", "global content")
    writeSkill(projectDir, "shared", "Project version", "project content")

    const skills = discoverSkills([globalDir, projectDir])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.description).toBe("Project version")
    expect(skills[0]!.content).toBe("project content")
  })

  test("project skills override global skills by default", () => {
    const originalCwd = process.cwd()
    const originalHome = process.env.HOME
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-skill-project-"))
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-skill-home-"))

    try {
      process.chdir(projectDir)
      process.env.HOME = homeDir
      clearCache()

      writeSkill(path.join(homeDir, ".config", "quark", "skills"), "shared", "Global version", "global content")
      writeSkill(path.join(projectDir, ".quark", "skills"), "shared", "Project version", "project content")

      const skill = discoverSkills().find((s) => s.name === "shared")

      expect(skill).toBeDefined()
      expect(skill!.description).toBe("Project version")
      expect(skill!.content).toBe("project content")
      expect(skill!.location).toContain(path.join(projectDir, ".quark", "skills"))
    } finally {
      process.chdir(originalCwd)
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      fs.rmSync(projectDir, { recursive: true, force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
      clearCache()
    }
  })

  test("falls back to directory name when no name in frontmatter", () => {
    const skillDir = path.join(tmpDir, "my-skill")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "Just content, no frontmatter.")

    const skills = discoverSkills([tmpDir])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe("my-skill")
    expect(skills[0]!.content).toBe("Just content, no frontmatter.")
  })
})

describe("loadSkill", () => {
  test("loads a specific skill by name", () => {
    writeSkill(tmpDir, "target", "Target skill", "Target content")
    // Must discover first to populate cache
    discoverSkills([tmpDir])

    const skill = loadSkill("target")
    expect(skill).toBeDefined()
    expect(skill!.name).toBe("target")
    expect(skill!.content).toBe("Target content")
  })

  test("returns undefined for non-existent skill", () => {
    discoverSkills([tmpDir])
    const skill = loadSkill("nonexistent")
    expect(skill).toBeUndefined()
  })
})
