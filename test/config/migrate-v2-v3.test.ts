// V2 → V3 migration tests — dry-run, backups, and agent manifest output.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse, stringify } from "yaml"
import { migrateConfigV2ToV3, profileToManifest } from "../../scripts/migrate-config-v2-to-v3"
import { parseConfigV3 } from "../../packages/quark/src/config/config"

let dir: string
let configPath: string
let agentsDir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quark-migrate-"))
  configPath = path.join(dir, "config.yaml")
  agentsDir = path.join(dir, "agents")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeV2(extra: Record<string, unknown> = {}, promptFiles: Record<string, string> = {}) {
  const config = {
    version: 2,
    models: { small: "openai/gpt-5-mini" },
    max_steps: 42,
    default_profile: "researcher",
    profiles: {
      researcher: {
        name: "Researcher",
        prompt_file: "prompts/researcher.md",
        tools: ["read", "write"],
        skills: ["focus"],
        model: "openai/gpt-5",
        thinking_effort: "high",
      },
      ...(extra.profiles as Record<string, unknown> | undefined),
    },
    profile_overrides: { researcher: { skills_add: ["extra-skill"], tools_add: ["edit"] } },
    providers: { "quark-go": { base_url: "https://example.test/v1", api_key: "env:QUARK_GO_KEY" } },
    ...extra,
  }
  fs.writeFileSync(configPath, stringify(config), "utf-8")
  for (const [file, content] of Object.entries(promptFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content, "utf-8")
  }
  return config
}

describe("migrateConfigV2ToV3", () => {
  test("dry-run plans the migration and writes nothing", () => {
    const original = writeV2({}, { "prompts/researcher.md": "You are a researcher." })
    const before = fs.readFileSync(configPath, "utf-8")

    const report = migrateConfigV2ToV3({ configPath, agentsDir, dryRun: true })

    expect(report.changed).toBe(true)
    expect(report.wroteConfig).toBe(false)
    expect(report.defaultAgent).toBe("researcher")
    expect(report.agents.map((a) => a.id)).toEqual(["researcher"])
    expect(report.agents[0]!.action).toBe("create")
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before)
    expect(fs.existsSync(agentsDir)).toBe(false)
    expect(original.version).toBe(2)
  })

  test("writes agent manifests, copies instructions, and rewrites the config", () => {
    writeV2({}, { "prompts/researcher.md": "You are a researcher." })

    const report = migrateConfigV2ToV3({ configPath, agentsDir })

    expect(report.wroteConfig).toBe(true)
    const manifest = parse(fs.readFileSync(path.join(agentsDir, "researcher", "agent.yaml"), "utf-8"))
    expect(manifest).toEqual({
      name: "Researcher",
      model: "openai/gpt-5",
      thinking_effort: "high",
      tools: ["read", "write", "edit"],
      skills: ["focus", "extra-skill"],
    })
    expect(fs.readFileSync(path.join(agentsDir, "researcher", "instructions.md"), "utf-8"))
      .toContain("You are a researcher.")

    const config = parseConfigV3(parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>)
    expect(config.version).toBe(3)
    expect(config.defaultAgent).toBe("researcher")
    expect(config.maxSteps).toBe(42)
    expect(config.providers["quark-go"]!.base_url).toBe("https://example.test/v1")
    const rewritten = parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
    expect(rewritten.profiles).toBeUndefined()
    expect(rewritten.default_profile).toBeUndefined()
  })

  test("backs up the original config and verifies the copy", () => {
    const config = writeV2()
    const original = fs.readFileSync(configPath, "utf-8")

    const report = migrateConfigV2ToV3({ configPath, agentsDir })

    expect(report.backupPath).toBeDefined()
    expect(fs.readFileSync(report.backupPath!, "utf-8")).toBe(original)
    expect(parse(original)).toEqual(config)
  })

  test("flattens the deprecated nested model/thinking format", () => {
    expect(profileToManifest({
      model: { id: "codex/gpt-5.6-luna", thinking: { effort: "low", mode: "standard" } },
    })).toMatchObject({ model: "codex/gpt-5.6-luna", thinking_effort: "low", thinking_mode: "standard" })
  })

  test("skips existing agent directories unless --force", () => {
    writeV2()
    fs.mkdirSync(path.join(agentsDir, "researcher"), { recursive: true })
    fs.writeFileSync(path.join(agentsDir, "researcher", "agent.yaml"), "name: Existing\n", "utf-8")

    const skipped = migrateConfigV2ToV3({ configPath, agentsDir })
    expect(skipped.agents[0]!.action).toBe("skip")
    expect(fs.readFileSync(path.join(agentsDir, "researcher", "agent.yaml"), "utf-8")).toBe("name: Existing\n")

    // A second run needs a fresh V2 config (the first run rewrote it to V3).
    writeV2()
    const forced = migrateConfigV2ToV3({ configPath, agentsDir, force: true })
    expect(forced.agents[0]!.action).toBe("overwrite")
  })

  test("warns and skips invalid agent ids", () => {
    writeV2({ profiles: { "Bad Id": { tools: ["read"] } } })
    const report = migrateConfigV2ToV3({ configPath, agentsDir, dryRun: true })
    expect(report.agents.map((a) => a.id)).not.toContain("Bad Id")
    expect(report.warnings.some((w) => w.includes("Bad Id"))).toBe(true)
  })

  test("is a no-op on an already V3 config", () => {
    fs.writeFileSync(configPath, stringify({ version: 3, default_agent: "coder" }), "utf-8")
    const report = migrateConfigV2ToV3({ configPath, agentsDir, dryRun: true })
    expect(report.changed).toBe(false)
    expect(report.agents).toEqual([])
  })

  test("refuses configs that are not V2", () => {
    fs.writeFileSync(configPath, stringify({ version: 1 }), "utf-8")
    expect(() => migrateConfigV2ToV3({ configPath, agentsDir })).toThrow(/Only V2 configs/)
  })

  test("throws when the config file is missing", () => {
    expect(() => migrateConfigV2ToV3({ configPath, agentsDir })).toThrow(/No config file/)
  })
})
