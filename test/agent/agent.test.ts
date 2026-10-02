// Agent system tests — manifest loading and materialization.
//
// QUARK_CONFIG_DIR pins the global agents directory to a temp dir so nothing
// touches the developer's real ~/.config/quark.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { stringify } from "yaml"
import {
  resolveAgent,
  listAgents,
  parseProfile,
  materializeAgent,
  BUILTIN_INSTRUCTIONS,
  BUILTIN_TOOLS,
} from "../../packages/quark/src/agent/agent"
import { resetConfigCache } from "../../packages/quark/src/config/config"
import { getActive, dismiss } from "../../packages/runner/src/notification/notification"
import { readTool } from "../../packages/runner/src/tool/read"
import { lookTool } from "../../packages/runner/src/tool/look"
import { list as listRegistered } from "../../packages/runner/src/tool/registry"
import type { AgentDef } from "../../packages/quark/src/agent/agent"

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "quark-agent-test-"))
const originalConfigDir = process.env.QUARK_CONFIG_DIR
const originalCwd = process.cwd()

beforeEach(() => {
  process.env.QUARK_CONFIG_DIR = configDir
  resetConfigCache()
  for (const n of getActive()) dismiss(n.id)
  fs.rmSync(path.join(configDir, "profile"), { recursive: true, force: true })
  fs.rmSync(path.join(configDir, "config.yaml"), { force: true })
})

afterEach(() => {
  fs.rmSync(path.join(configDir, "profile"), { recursive: true, force: true })
  for (const n of getActive()) dismiss(n.id)
})

afterAll(() => {
  process.chdir(originalCwd)
  if (originalConfigDir === undefined) delete process.env.QUARK_CONFIG_DIR
  else process.env.QUARK_CONFIG_DIR = originalConfigDir
  fs.rmSync(configDir, { recursive: true, force: true })
})

function writeAgent(id: string, manifest: Record<string, unknown>): string {
  const dir = path.join(configDir, "profile")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.yaml`)
  fs.writeFileSync(file, stringify(manifest), "utf-8")
  return file
}

function writeConfig(manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(configDir, "config.yaml"), stringify(manifest), "utf-8")
  resetConfigCache()
}

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "compat",
    name: "Compat",
    instructions: "SYSTEM PROMPT",
    tools: [],
    skills: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// resolveAgent
// ---------------------------------------------------------------------------

describe("profile fast mode", () => {
  test("preserves true, false and omitted through materialization", async () => {
    for (const fastMode of [true, false, undefined]) {
      const agent = parseProfile({ model: { id: "openai/gpt-5.5", ...(fastMode !== undefined ? { fast_mode: fastMode } : {}) }, tools: [], skills: [] }, "speed")
      expect(agent.fastMode).toBe(fastMode)
      expect((await materializeAgent(agent)).fastMode).toBe(fastMode)
    }
  })
  test("rejects non-booleans and speed without a model id", () => {
    for (const value of ["true", 1, null]) {
      expect(() => parseProfile({ model: { id: "openai/gpt-5.5", fast_mode: value } }, "speed")).toThrow("boolean")
    }
    expect(() => parseProfile({ model: { fast_mode: false } }, "speed")).toThrow("model.id")
  })
})

describe("resolveAgent", () => {
  test("returns built-in coder when no config or agents exist", () => {
    const def = resolveAgent("coder")
    expect(def.id).toBe("coder")
    expect(def.tools).toContain("read")
    expect(def.tools).toContain("bash")
    expect(def.tools).toContain("skill")
    expect(def.skills).toEqual([])
  })

  test("falls back to coder when an unknown agent is requested", () => {
    expect(resolveAgent("nonexistent").id).toBe("coder")
  })

  test("reads one self-contained profile including nested model and prompt", () => {
    writeAgent("researcher", {
      name: "Researcher", description: "Research", model: { id: "openai/gpt-5", thinking_effort: "high", thinking_mode: "pro" },
      tools: ["read", "skill"], skills: ["focus"], prompt: "# Research\n\nDig deep.",
    })
    const def = resolveAgent("researcher")
    expect(def.name).toBe("Researcher")
    expect(def.description).toBe("Research")
    expect(def.instructions).toContain("Dig deep.")
    expect(def.tools).toEqual(["read", "skill"])
    expect(def.skills).toEqual(["focus"])
    expect(def.model).toBe("openai/gpt-5")
    expect(def.thinkingEffort).toBe("high")
    expect(def.thinkingMode).toBe("pro")
  })

  test("falls back to the built-in prompt when prompt is missing", () => {
    writeAgent("bare", {})
    expect(resolveAgent("bare").instructions).toBe(BUILTIN_INSTRUCTIONS)
  })

  test("defaults tools to the built-in set and skills to empty", () => {
    writeAgent("minimal", {})
    const def = resolveAgent("minimal")
    expect(def.tools).toEqual(BUILTIN_TOOLS)
    expect(def.skills).toEqual([])
  })

  test("honors config.default_agent", () => {
    writeAgent("researcher", { name: "Researcher" })
    writeConfig({ version: 3, default_agent: "researcher", models: { small: "openai/gpt-5-mini" } })

    expect(resolveAgent().id).toBe("researcher")
    expect(resolveAgent().name).toBe("Researcher")
  })

  test("skips malformed profile YAML with a warning and falls back", () => {
    const dir = path.join(configDir, "profile")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "broken.yaml"), ": : : not yaml {{{", "utf-8")

    expect(resolveAgent("broken").id).toBe("coder")
    expect(getActive()).toContainEqual(expect.objectContaining({
      type: "warn",
      title: "Agent",
      message: expect.stringContaining("broken"),
    }))
  })

  test("strips unknown subagents and keeps valid ones", () => {
    writeAgent("orchestrator", { subagents: ["worker", "ghost"] })
    writeAgent("worker", {})

    const def = resolveAgent("orchestrator")
    expect(def.subAgents).toEqual(["worker"])
    expect(getActive()).toContainEqual(expect.objectContaining({
      type: "warn",
      title: "Agent",
      message: expect.stringContaining("ghost"),
    }))
  })

  test("ignores project-local profiles even when they share a global ID", () => {
    writeAgent("shared", { name: "Global" })
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "quark-agent-project-"))
    try {
      const dir = path.join(projectDir, ".quark", "profile")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "shared.yaml"), stringify({ name: "Project" }), "utf-8")
      fs.writeFileSync(path.join(dir, "local.yaml"), stringify({ name: "Local" }), "utf-8")
      process.chdir(projectDir)

      expect(resolveAgent("shared").name).toBe("Global")
      expect(listAgents()).not.toContain("local")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("listAgents includes built-in coder and discovered agents", () => {
    writeAgent("researcher", {})
    expect(listAgents()).toContain("coder")
    expect(listAgents()).toContain("researcher")
  })

  test("rejects malformed fields without replacing the built-in agent", () => {
    writeAgent("coder", { model: "openai/gpt-5", prompt: 12 })
    expect(resolveAgent("coder").instructions).toBe(BUILTIN_INSTRUCTIONS)
    expect(getActive()).toContainEqual(expect.objectContaining({ type: "warn", message: expect.stringContaining("coder.yaml") }))
  })

  test("does not load old two-file agent directories", () => {
    const dir = path.join(configDir, "agents", "old")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "agent.yaml"), stringify({ name: "Old" }))
    expect(listAgents()).not.toContain("old")
    fs.rmSync(path.join(configDir, "agents"), { recursive: true, force: true })
  })

  test("parseProfile rejects non-mapping profiles", () => {
    expect(() => parseProfile("nope", "bad")).toThrow(/must be a mapping/)
  })
})

// ---------------------------------------------------------------------------
// materializeAgent
// ---------------------------------------------------------------------------

describe("materializeAgent — tools", () => {
  test("built-ins become concrete ToolDefs without global registration", async () => {
    const before = listRegistered().length

    const def = await materializeAgent(agent({ tools: ["read", "look", "skill"], model: "openai/x", thinkingEffort: "high" }))

    expect(def.id).toBe("compat")
    expect(def.name).toBe("Compat")
    expect(def.instructions).toBe("SYSTEM PROMPT")
    expect(def.model).toBe("openai/x")
    expect(def.thinkingEffort).toBe("high")
    expect(def.tools.map((t) => t.id)).toEqual(["read", "look", "skill"])
    expect(def.tools[0]).toBe(readTool)
    expect(def.tools[1]).toBe(lookTool)

    expect(listRegistered().length).toBe(before)
  })

  test("missing tools are skipped and declared order is preserved", async () => {
    const def = await materializeAgent(agent({ tools: ["read", "definitely-not-a-real-tool", "look"] }))
    expect(def.tools.map((t) => t.id)).toEqual(["read", "look"])
  })

  test("sub_agents become a concrete subagent tool", async () => {
    const def = await materializeAgent(agent({ subAgents: ["researcher", "worker"] }))
    const tool = def.tools.find((t) => t.id === "subagent")
    expect(tool).toBeDefined()
    expect(tool!.description).toContain("researcher")
    expect(tool!.description).toContain("worker")
    // Agent definitions stay portable — no subAgents field leaks through.
    expect("subAgents" in def).toBe(false)
  })
})

describe("materializeAgent — skills", () => {
  test("resolved skills attach to the definition and the skill tool serves them", async () => {
    const before = listRegistered().length

    const def = await materializeAgent(
      agent({ tools: ["skill"], skills: ["focus"] }),
      {
        resolveSkills: (names) => [
          { name: names[0]!, description: "Focus mode", content: "Do the focused thing." },
        ],
      },
    )

    expect(def.skills?.map((s) => s.name)).toEqual(["focus"])
    expect(def.skills?.[0]?.content).toContain("Do the focused thing.")

    const skillTool = def.tools.find((t) => t.id === "skill")!
    const result = await skillTool.execute(
      { name: "focus" },
      { sessionId: "s", messageId: "m", callId: "c", abort: new AbortController().signal },
    )
    expect(result.output).toContain("Do the focused thing.")

    expect(listRegistered().length).toBe(before)
  })
})
