// Migrate a Quark V2 config.yaml to V3.
//
// V2 kept agents inline under `profiles:`; V3 keeps app settings in config.yaml
// and moves each agent to `agents/<id>/agent.yaml` + `instructions.md`.
//
// Safety:
//   - `--dry-run` prints the plan and writes nothing.
//   - The original config is backed up to `config.yaml.v2.<timestamp>.bak` and
//     verified before the new config is written (atomically).
//   - Existing agent directories are left untouched unless `--force`.
//
// Usage:
//   bun scripts/migrate-config-v2-to-v3.ts [--dry-run] [--force] \
//       [--config <path>] [--agents-dir <path>]

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"

export interface MigrateOptions {
  configPath: string
  agentsDir: string
  dryRun?: boolean
  force?: boolean
}

export interface AgentPlan {
  id: string
  manifestPath: string
  instructionsPath?: string
  action: "create" | "overwrite" | "skip"
}

export interface MigrateReport {
  configPath: string
  agentsDir: string
  dryRun: boolean
  changed: boolean
  wroteConfig: boolean
  fromVersion: number
  defaultAgent: string
  backupPath?: string
  agents: AgentPlan[]
  warnings: string[]
}

export function defaultConfigPath(): string {
  const dir = process.env.QUARK_CONFIG_DIR ?? path.join(os.homedir(), ".config", "quark")
  return path.join(dir, "config.yaml")
}

const AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/** Flatten a V2 profile (including the deprecated nested model) into a V3 manifest. */
export function profileToManifest(profile: Record<string, unknown>, id = "agent"): Record<string, unknown> {
  const legacyModel = profile.model && typeof profile.model === "object" && !Array.isArray(profile.model)
    ? profile.model as Record<string, unknown>
    : undefined
  const legacyThinking = legacyModel?.thinking && typeof legacyModel.thinking === "object"
    ? legacyModel.thinking as Record<string, unknown>
    : undefined

  const model = stringField(profile.model) ?? stringField(legacyModel?.id)
  const effort = stringField(profile.thinking_effort) ?? stringField(legacyThinking?.effort)
  const mode = stringField(profile.thinking_mode)
    ?? (effort ? stringField(legacyThinking?.mode) : undefined)

  const manifest: Record<string, unknown> = { version: 1, id, instructions: "instructions.md" }
  const name = stringField(profile.name)
  const description = stringField(profile.description)
  if (name) manifest.name = name
  if (description) manifest.description = description
  if (model) manifest.model = model
  if (effort) manifest.thinking_effort = effort
  if (mode) manifest.thinking_mode = mode
  manifest.tools = asStringArray(profile.tools) ?? []
  manifest.skills = asStringArray(profile.skills) ?? []
  const subAgents = asStringArray(profile.sub_agents)
  if (subAgents) manifest.sub_agents = subAgents
  return manifest
}

function applyOverrides(
  manifest: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
  warnings: string[],
  id: string,
): void {
  if (!override) return
  const skillsAdd = asStringArray(override.skills_add)
  const toolsAdd = asStringArray(override.tools_add)
  if (skillsAdd) {
    manifest.skills = [...new Set([...(manifest.skills as string[]), ...skillsAdd])]
    warnings.push(`agents/${id}: applied profile_overrides.skills_add (${skillsAdd.join(", ")})`)
  }
  if (toolsAdd) {
    manifest.tools = [...new Set([...(manifest.tools as string[]), ...toolsAdd])]
    warnings.push(`agents/${id}: applied profile_overrides.tools_add (${toolsAdd.join(", ")})`)
  }
}

function readProfileInstructions(
  profile: Record<string, unknown>,
  configDir: string,
  warnings: string[],
  id: string,
): string | undefined {
  const promptFile = stringField(profile.prompt_file)
  if (!promptFile) return undefined
  const resolved = path.isAbsolute(promptFile) ? promptFile : path.resolve(configDir, promptFile)
  try {
    return fs.readFileSync(resolved, "utf-8")
  } catch {
    warnings.push(`agents/${id}: prompt_file not found (${resolved}); no instructions.md written`)
    return undefined
  }
}

/** Plan and (unless dry-run) perform the migration. Pure planning is side-effect free. */
export function migrateConfigV2ToV3(options: MigrateOptions): MigrateReport {
  const { configPath, agentsDir } = options
  const dryRun = options.dryRun ?? false
  const force = options.force ?? false

  if (!fs.existsSync(configPath)) throw new Error(`No config file at ${configPath}`)
  const original = fs.readFileSync(configPath, "utf-8")
  const raw = parseYAML(original) as unknown
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath} is not a YAML mapping.`)
  }
  const config = raw as Record<string, unknown>
  const fromVersion = typeof config.version === "number" ? config.version : 0

  if (fromVersion === 3) {
    return {
      configPath, agentsDir, dryRun, changed: false, wroteConfig: false,
      fromVersion, defaultAgent: stringField(config.default_agent) ?? "coder",
      agents: [], warnings: ["config is already version 3; nothing to migrate"],
    }
  }
  if (fromVersion !== 2) {
    throw new Error(`Unsupported config version "${String(config.version)}". Only V2 configs can be migrated.`)
  }

  const warnings: string[] = []
  const configDir = path.dirname(configPath)
  const profiles = config.profiles && typeof config.profiles === "object" && !Array.isArray(config.profiles)
    ? config.profiles as Record<string, unknown>
    : {}
  const overrides = config.profile_overrides && typeof config.profile_overrides === "object" && !Array.isArray(config.profile_overrides)
    ? config.profile_overrides as Record<string, unknown>
    : {}

  const conflicts = Object.keys(profiles).filter((id) => fs.existsSync(path.join(agentsDir, id, "agent.yaml")))
  if (conflicts.length > 0 && !force) {
    throw new Error(`Refusing to migrate because agent manifests already exist: ${conflicts.join(", ")}. Re-run with --force after reviewing them.`)
  }

  const agents: AgentPlan[] = []
  for (const [id, value] of Object.entries(profiles)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      warnings.push(`profile "${id}" is not a mapping; skipped`)
      continue
    }
    if (!AGENT_ID.test(id)) {
      warnings.push(`profile "${id}" is not a valid agent id (lowercase letters, digits, . _ -); skipped`)
      continue
    }

    const dir = path.join(agentsDir, id)
    const manifestPath = path.join(dir, "agent.yaml")
    const exists = fs.existsSync(manifestPath)
    const action: AgentPlan["action"] = exists ? "overwrite" : "create"

    const manifest = profileToManifest(value as Record<string, unknown>, id)
    applyOverrides(manifest, overrides[id] as Record<string, unknown> | undefined, warnings, id)
    const instructions = readProfileInstructions(value as Record<string, unknown>, configDir, warnings, id)
    const instructionsPath = instructions === undefined ? undefined : path.join(dir, "instructions.md")

    if (!dryRun && action !== "skip") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(manifestPath, stringifyYAML(manifest), { encoding: "utf8", mode: 0o600 })
      if (instructionsPath && instructions !== undefined) {
        fs.writeFileSync(instructionsPath, instructions, { encoding: "utf8", mode: 0o600 })
      }
    }

    agents.push({ id, manifestPath, ...(instructionsPath ? { instructionsPath } : {}), action })
  }

  for (const id of Object.keys(overrides)) {
    if (!(id in profiles)) warnings.push(`profile_overrides.${id} has no matching profile; ignored`)
  }

  const defaultAgent = stringField(config.default_profile) ?? "coder"
  const v3: Record<string, unknown> = { version: 3, default_agent: defaultAgent }
  for (const key of ["models", "max_steps", "branching", "providers", "hide_readonly_tools", "editor"]) {
    if (config[key] !== undefined) v3[key] = config[key]
  }

  const report: MigrateReport = {
    configPath, agentsDir, dryRun, changed: true, wroteConfig: false,
    fromVersion, defaultAgent, agents, warnings,
  }
  if (dryRun) return report

  // Backup first, verify it round-trips, then write the new config atomically.
  if (original.length > 0) {
    const backupPath = `${configPath}.v2.${Date.now()}.bak`
    fs.writeFileSync(backupPath, original, { encoding: "utf8", mode: 0o600 })
    if (fs.readFileSync(backupPath, "utf-8") !== original) {
      throw new Error(`Backup verification failed for ${backupPath}; config left untouched.`)
    }
    report.backupPath = backupPath
  }

  const content = stringifyYAML(v3)
  parseYAML(content) // sanity-check before clobbering the original
  const temporary = `${configPath}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 })
    fs.renameSync(temporary, configPath)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
  report.wroteConfig = true

  return report
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): { options: MigrateOptions; help: boolean } {
  let configPath = defaultConfigPath()
  let agentsDir: string | undefined
  let dryRun = false
  let force = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") dryRun = true
    else if (arg === "--force") force = true
    else if (arg === "--help" || arg === "-h") help = true
    else if (arg === "--config") configPath = argv[++i] ?? configPath
    else if (arg === "--agents-dir") agentsDir = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return {
    options: { configPath, agentsDir: agentsDir ?? path.join(path.dirname(configPath), "agents"), dryRun, force },
    help,
  }
}

function printReport(report: MigrateReport): void {
  const prefix = report.dryRun ? "[dry-run] " : ""
  console.log(`${prefix}config: ${report.configPath}`)
  console.log(`${prefix}agents: ${report.agentsDir}`)
  if (!report.changed) {
    console.log(`${prefix}already version 3 — nothing to do`)
    return
  }
  console.log(`${prefix}default_agent: ${report.defaultAgent}`)
  for (const agent of report.agents) {
    console.log(`${prefix}  ${agent.action.padEnd(9)} agents/${agent.id}/agent.yaml`)
  }
  for (const warning of report.warnings) console.log(`${prefix}  ! ${warning}`)
  if (report.backupPath) console.log(`${prefix}backup: ${report.backupPath}`)
  if (report.dryRun) console.log(`${prefix}no files written`)
}

if (import.meta.main) {
  const { options, help } = parseCliArgs(process.argv.slice(2))
  if (help) {
    console.log("Usage: bun scripts/migrate-config-v2-to-v3.ts [--dry-run] [--force] [--config <path>] [--agents-dir <path>]")
  } else {
    try {
      printReport(migrateConfigV2ToV3(options))
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
}
