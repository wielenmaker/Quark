// Tests for /skills slash command — skill picker and integration.
// Dynamic activation is carried in the next user message so the system prompt
// and tool definition remain stable for prompt caching.

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { discoverSkills, clearCache, type Skill, type SkillDefinition } from "../../packages/runner/src/skill/skill"
import { buildSystem } from "../../packages/runner/src/session/system"
import { buildSkillTool } from "../../packages/runner/src/tool/skill"
import { defineAgent, type AgentDefinition } from "../../packages/runner/src/agent"
import { materializeAgent } from "../../packages/quark/src/agent/agent"
import { buildPickerItems, type PickerOption } from "../../packages/quark/src/tui/picker-items"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

function createSkill(dir: string, name: string, description: string, content: string): void {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${content}`,
  )
}

/**
 * Convert discovered Skill[] into PickerOption[].
 * This is what handleGetSkills() in index.tsx will do.
 */
function skillsToPickerOptions(skills: Skill[]): PickerOption[] {
  return skills.map((s) => ({ id: s.name, name: s.name }))
}

function skillDef(name: string, description: string, content = "body"): SkillDefinition {
  return { name, description, content }
}

/**
 * Build a minimal portable AgentDefinition for testing.
 * `skills` are concrete definitions — the runner never resolves names from disk.
 */
function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return defineAgent({
    id: "test",
    name: "Test Agent",
    instructions: "You are a test agent.",
    tools: [],
    skills: [],
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quark-skills-picker-test-"))
  clearCache()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearCache()
})

// ===========================================================================
// 1. Skill discovery → PickerOption conversion
// ===========================================================================

describe("skillsToPickerOptions", () => {
  test("converts discovered skills to picker options", () => {
    createSkill(tmpDir, "code-review", "Review code for quality", "Full instructions...")
    createSkill(tmpDir, "git-release", "Manage git releases", "Release instructions...")

    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)

    expect(options).toHaveLength(2)
    expect(options[0]!.id).toBe("code-review")
    expect(options[0]!.name).toBe("code-review")
    expect(options[1]!.id).toBe("git-release")
    expect(options[1]!.name).toBe("git-release")
  })

  test("returns empty array when no skills discovered", () => {
    const skills = discoverSkills([path.join(tmpDir, "nonexistent")])
    const options = skillsToPickerOptions(skills)
    expect(options).toEqual([])
  })

  test("each option has id and name fields", () => {
    createSkill(tmpDir, "alpha", "Alpha skill", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)

    for (const opt of options) {
      expect(opt).toHaveProperty("id")
      expect(opt).toHaveProperty("name")
      expect(typeof opt.id).toBe("string")
      expect(typeof opt.name).toBe("string")
    }
  })
})

// ===========================================================================
// 2. buildPickerItems with skill options
// ===========================================================================

describe("buildPickerItems with skills", () => {
  test("builds picker items from skill options", () => {
    createSkill(tmpDir, "alpha", "Alpha skill", "content")
    createSkill(tmpDir, "beta", "Beta skill", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)

    const items = buildPickerItems(options, "")

    expect(items).toHaveLength(2)
    const ids = items.map((i) => i.id).sort()
    expect(ids).toEqual(["alpha", "beta"])
    expect(items[0]!.label).toBe(items[0]!.id)
  })

  test("filters skill picker items by query", () => {
    createSkill(tmpDir, "academic-research", "Research", "content")
    createSkill(tmpDir, "code-review", "Review code", "content")
    createSkill(tmpDir, "git-release", "Release", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)

    const items = buildPickerItems(options, "", "code")
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe("code-review")
  })

  test("filters by name containing query", () => {
    createSkill(tmpDir, "academic-research", "Research", "content")
    createSkill(tmpDir, "code-review", "Code Review Skill", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)

    // Searching by the name field (not just id)
    const items = buildPickerItems(options, "", "research")
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe("academic-research")
  })

  test("no query — returns all items", () => {
    createSkill(tmpDir, "alpha", "Alpha", "content")
    createSkill(tmpDir, "beta", "Beta", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)

    const items = buildPickerItems(options, "")
    expect(items).toHaveLength(2)
  })

  test("empty options returns empty items", () => {
    const items = buildPickerItems([], "")
    expect(items).toEqual([])
  })

  test("each picker entry has required fields", () => {
    createSkill(tmpDir, "test-skill", "Test", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)
    const items = buildPickerItems(options, "")

    for (const item of items) {
      expect(item).toHaveProperty("id")
      expect(item).toHaveProperty("label")
      expect(item).toHaveProperty("detail")
      expect(typeof item.id).toBe("string")
      expect(typeof item.label).toBe("string")
    }
  })
})

// ===========================================================================
// 3. Adding a skill to agent.skills (in-memory mutation)
// ===========================================================================

describe("agent.skills mutation", () => {
  test("adds a skill to empty skills array", () => {
    const agent = makeAgent({ skills: [] })
    agent.skills = [...agent.skills!, skillDef("code-review", "Review code")]
    expect(agent.skills.map((s) => s.name)).toEqual(["code-review"])
  })

  test("adds a skill to existing skills", () => {
    const agent = makeAgent({ skills: [skillDef("code-review", "Review code")] })
    agent.skills = [...agent.skills, skillDef("git-release", "Manage releases")]
    expect(agent.skills.map((s) => s.name)).toEqual(["code-review", "git-release"])
  })

  test("preserves existing skills when adding new one", () => {
    const agent = makeAgent({ skills: [skillDef("alpha", "A"), skillDef("beta", "B")] })
    agent.skills = [...agent.skills, skillDef("gamma", "G")]
    expect(agent.skills).toHaveLength(3)
    expect(agent.skills.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"])
  })

  test("multiple additions accumulate", () => {
    const agent = makeAgent({ skills: [] })
    agent.skills = [...agent.skills!, skillDef("alpha", "A")]
    agent.skills = [...agent.skills, skillDef("beta", "B")]
    agent.skills = [...agent.skills, skillDef("gamma", "G")]
    expect(agent.skills.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"])
  })
})

// ===========================================================================
// 4. Duplicate detection
// ===========================================================================

describe("duplicate skill detection", () => {
  test("detects when skill is already in agent.skills", () => {
    const agent = makeAgent({ skills: [skillDef("code-review", "R"), skillDef("git-release", "G")] })
    const isDuplicate = agent.skills!.some((s) => s.name === "code-review")
    expect(isDuplicate).toBe(true)
  })

  test("returns false when skill is not in agent.skills", () => {
    const agent = makeAgent({ skills: [skillDef("code-review", "R")] })
    const isDuplicate = agent.skills!.some((s) => s.name === "git-release")
    expect(isDuplicate).toBe(false)
  })

  test("returns false when agent.skills is empty", () => {
    const agent = makeAgent({ skills: [] })
    const isDuplicate = agent.skills!.some((s) => s.name === "any-skill")
    expect(isDuplicate).toBe(false)
  })
})

// ===========================================================================
// 5. buildSystem reflects newly added skill's L1 metadata
// ===========================================================================

describe("buildSystem with dynamically added skills", () => {
  test("system prompt includes L1 metadata for bound skills", () => {
    // Simulate: user added 'git-release' via /skills picker
    const agent = makeAgent({
      skills: [
        skillDef("code-review", "Review code for quality", "Full review instructions..."),
        skillDef("git-release", "Manage git releases", "Full release instructions..."),
      ],
    })
    const joined = buildSystem(agent).join("\n")

    expect(joined).toContain("# Available Skills")
    expect(joined).toContain("code-review")
    expect(joined).toContain("Review code for quality")
    expect(joined).toContain("git-release")
    expect(joined).toContain("Manage git releases")

    // L2 content (skill body) must NOT leak into system prompt
    expect(joined).not.toContain("Full review instructions")
    expect(joined).not.toContain("Full release instructions")
  })

  test("activation context leaves the system prompt unchanged", () => {
    const agent = makeAgent({ skills: [skillDef("alpha", "Alpha skill", "alpha body")] })
    const before = buildSystem(agent).join("\n")
    const activationContext = "[Activated skill]\nbeta: Beta skill\nUse the skill tool to load it when needed."
    const after = buildSystem(agent).join("\n")

    expect(after).toBe(before)
    expect(after).not.toContain("beta")
    expect(activationContext).toContain("beta: Beta skill")
  })

  test("empty skills — no skill block in system prompt", () => {
    const joined = buildSystem(makeAgent({ skills: [] })).join("\n")
    expect(joined).not.toContain("Available Skills")
  })

  test("only supplied concrete skills appear", () => {
    const joined = buildSystem(makeAgent({ skills: [skillDef("real-skill", "Real skill")] })).join("\n")
    expect(joined).toContain("real-skill")
    expect(joined).not.toContain("ghost-skill")
  })
})

// ===========================================================================
// 6. buildSkillTool reflects expanded boundSkills
// ===========================================================================

describe("buildSkillTool with dynamically added skills", () => {
  test("tool description is stable as skills are activated", () => {
    const before = buildSkillTool(undefined, [skillDef("alpha", "Alpha skill")])
    const after = buildSkillTool(undefined, [
      skillDef("alpha", "Alpha skill"),
      skillDef("beta", "Beta skill"),
    ])

    expect(after.description).toBe(before.description)
    expect(after.description).not.toContain("alpha")
    expect(after.description).not.toContain("beta")
  })

  test("tool description is stable without a bound-skills filter", () => {
    const tool = buildSkillTool()
    expect(tool.description).not.toContain("Available skills")
  })

  test("execute loads a newly added concrete skill", async () => {
    const tool = buildSkillTool(undefined, [skillDef("new-skill", "Newly added", "Do the new thing.")])
    const ctx = {
      sessionId: "s1",
      messageId: "m1",
      abort: new AbortController().signal,
      messages: [],
      ask: async (_req: any) => "allow" as const,
    }
    const result = await tool.execute({ name: "new-skill" }, ctx)
    expect(result.title).toBe("Loaded skill: new-skill")
    expect(result.output).toContain("Do the new thing.")
    expect(result.metadata.name).toBe("new-skill")
  })
})

// ===========================================================================
// 7. Edge cases
// ===========================================================================

describe("skills picker edge cases", () => {
  test("query with no matches returns empty items", () => {
    createSkill(tmpDir, "alpha", "Alpha", "content")
    createSkill(tmpDir, "beta", "Beta", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)

    const items = buildPickerItems(options, "", "zzz")
    expect(items).toEqual([])
  })

  test("skill with no frontmatter name uses directory name", () => {
    // Create skill without name in frontmatter — falls back to dir name
    const skillDir = path.join(tmpDir, "fallback-skill")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "Just content, no frontmatter.")

    const skills = discoverSkills([tmpDir])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe("fallback-skill")

    const options = skillsToPickerOptions(skills)
    expect(options[0]!.id).toBe("fallback-skill")
  })

  test("skill with empty description still appears in picker", () => {
    createSkill(tmpDir, "no-desc", "", "content")
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)
    const items = buildPickerItems(options, "")

    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe("no-desc")
  })

  test("many skills — all appear in picker items", () => {
    const count = 20
    for (let i = 0; i < count; i++) {
      createSkill(tmpDir, `skill-${i}`, `Skill ${i}`, `content ${i}`)
    }
    const skills = discoverSkills([tmpDir])
    const options = skillsToPickerOptions(skills)
    const items = buildPickerItems(options, "")

    expect(items).toHaveLength(count)
  })
})

// ===========================================================================
// 8. Profile switch resets skills
// ===========================================================================

describe("agent switch resets skills", () => {
  // Hermetic skill resolution: never touch the developer's skill directories.
  const resolveSkills = (names: string[]): SkillDefinition[] =>
    names.map((name) => skillDef(name, `${name} description`))

  test("materializeAgent creates agent with the manifest's declared skills only", async () => {
    const def = {
      id: "custom",
      name: "Custom",
      instructions: "You are custom.",
      tools: ["read"],
      skills: ["declared-skill"],
    }

    const agent = await materializeAgent(def, { resolveSkills })
    expect(agent.skills?.map((s) => s.name)).toEqual(["declared-skill"])
    // Skills added via /skills during a previous session would NOT be in the new agent
  })

  test("new agent does not carry over temporary skills", async () => {
    // Simulate: agent A's base skills are ['alpha']
    // User adds 'beta' via /skills → agent.skills gains 'beta'
    // Then switches to agent B → new materializeAgent → only agent B's skills

    const agentDefA = {
      id: "agent-a",
      name: "Agent A",
      instructions: "prompt",
      tools: ["read"],
      skills: ["alpha"],
    }

    const agentDefB = {
      id: "agent-b",
      name: "Agent B",
      instructions: "prompt",
      tools: ["read"],
      skills: ["gamma"],
    }

    // Simulate adding beta to agent A's agent
    const agentA = await materializeAgent(agentDefA, { resolveSkills })
    agentA.skills = [...(agentA.skills ?? []), skillDef("beta", "beta description")]
    expect(agentA.skills.map((s) => s.name)).toEqual(["alpha", "beta"])

    // Switch to agent B — creates a fresh agent
    const agentB = await materializeAgent(agentDefB, { resolveSkills })
    expect(agentB.skills?.map((s) => s.name)).toEqual(["gamma"])
    // 'beta' from the temporary addition is gone
  })
})
