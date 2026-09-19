// Agent system — app-owned agent manifests, resolved into portable definitions.
//
// An agent is a directory:
//   agents/<id>/agent.yaml     identity: name, model, tools, skills, sub_agents
//   agents/<id>/instructions.md  system prompt (optional YAML frontmatter)
//
// Agents are app-owned: the loader scans
//   1. <config>/agents/            (global, ~/.config/quark/agents)
//   2. <cwd>/.quark/agents/        (project, overrides global)
// and always keeps the built-in `coder` fallback. This is deliberately NOT part
// of @quark/runner: the engine receives a portable AgentDefinition and never
// reads agent YAML.

import * as fs from "node:fs"
import * as path from "node:path"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"
import { buildSkillTool } from "@quark/runner/tool/skill"
import { createSubagentTool } from "@quark/runner/tool/subagent"
import { lookTool } from "@quark/runner/tool/look"
import { readTool } from "@quark/runner/tool/read"
import { profileSkills, type SkillDefinition } from "@quark/runner/skill/skill"
import { warn as notifyWarn } from "@quark/runner/notification/notification"
import { loadTools } from "../tool-loader"
import { configDir, loadConfig } from "../config/config"
import type { AgentDefinition } from "@quark/runner/agent"
import type { ToolDef } from "@quark/runner/tool/tool"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved agent manifest with its instructions already read from disk. */
export interface AgentDef {
  /** Unique agent id (directory name) */
  id: string
  /** Human-readable display name */
  name: string
  /** Short description from the manifest or instructions frontmatter */
  description?: string
  /** Resolved system-prompt text (never a file path) */
  instructions: string
  /** Tool IDs this agent can use */
  tools: string[]
  /** Skill names bound to this agent */
  skills: string[]
  /** Agent IDs this agent can delegate to */
  subAgents?: string[]
  /** Model spec in `provider/model` form */
  model?: string
  /** Thinking effort for this agent's effective model */
  thinkingEffort?: string
  /** Optional reasoning mode for models that support it */
  thinkingMode?: string
}

export const BUILTIN_TOOLS = ["read", "look", "write", "edit", "bash", "skill", "todo"]

export const BUILTIN_INSTRUCTIONS =
  "You are a coding assistant. Help the user with software engineering tasks."

const AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/
const MANIFEST_KEYS = new Set([
  "version", "id", "name", "description", "instructions", "model",
  "thinking_effort", "thinking_mode", "tools", "skills", "sub_agents",
])

const BUILTIN_CODER: AgentDef = {
  id: "coder",
  name: "Coder",
  instructions: BUILTIN_INSTRUCTIONS,
  tools: [...BUILTIN_TOOLS],
  skills: [],
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** Global agents directory, resolved per call so QUARK_CONFIG_DIR stays authoritative. */
export function agentsDir(): string {
  return path.join(configDir(), "agents")
}

/** Project-level agents directory (overrides the global one per id). */
export function projectAgentsDir(): string {
  return path.resolve(process.cwd(), ".quark", "agents")
}

// ---------------------------------------------------------------------------
// instructions.md
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { data: Record<string, string>; content: string } {
  const data: Record<string, string> = {}
  if (!raw.startsWith("---")) return { data, content: raw }

  const end = raw.indexOf("\n---", 3)
  if (end === -1) return { data, content: raw }

  const front = raw.substring(4, end)
  const content = raw.substring(end + 4).trim()

  for (const line of front.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    data[line.substring(0, colon).trim()] = line.substring(colon + 1).trim()
  }

  return { data, content }
}

interface Instructions {
  content: string
  name?: string
  description?: string
}

function readInstructions(file: string): Instructions {
  try {
    const { data, content } = parseFrontmatter(fs.readFileSync(file, "utf-8"))
    return {
      content: content || BUILTIN_INSTRUCTIONS,
      ...(data.name ? { name: data.name } : {}),
      ...(data.description ? { description: data.description } : {}),
    }
  } catch {
    return { content: BUILTIN_INSTRUCTIONS }
  }
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

function stringArray(value: unknown, field: string, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of non-empty strings.`)
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field} must contain non-empty strings.`)
    return item.trim()
  })
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates.`)
  return result
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function validateModel(value: unknown): string | undefined {
  const model = nonEmptyString(value)
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) throw new Error("model must use provider/model form.")
  return `${model.slice(0, slash).toLowerCase()}/${model.slice(slash + 1)}`
}

function resolveInstructionsPath(dir: string, value: unknown): string {
  const relative = value === undefined ? "instructions.md" : nonEmptyString(value)
  if (!relative) throw new Error("instructions must be a non-empty relative path.")
  if (path.isAbsolute(relative)) throw new Error("instructions must be relative to the agent directory.")
  const root = path.resolve(dir)
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("instructions must not escape the agent directory.")
  }
  return resolved
}

/** Parse and validate one `agent.yaml`. */
export function parseAgentManifest(raw: unknown, directoryId: string, dir: string): AgentDef {
  if (!AGENT_ID.test(directoryId)) throw new Error(`Invalid agent directory id "${directoryId}".`)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`agents/${directoryId}/agent.yaml must be a mapping.`)
  }
  const manifest = raw as Record<string, unknown>
  if (manifest.version !== 1) throw new Error("agent.yaml requires version: 1.")
  const id = nonEmptyString(manifest.id)
  if (!id || !AGENT_ID.test(id)) throw new Error("agent.yaml requires a valid lowercase id.")
  if (id !== directoryId) throw new Error(`agent id "${id}" must match directory "${directoryId}".`)
  const unsupported = Object.keys(manifest).find((key) => !MANIFEST_KEYS.has(key))
  if (unsupported) throw new Error(`Unsupported agent field "${unsupported}".`)

  const instructions = readInstructions(resolveInstructionsPath(dir, manifest.instructions))
  const tools = stringArray(manifest.tools, "tools", true)!
  const skills = stringArray(manifest.skills, "skills") ?? []
  const subAgents = stringArray(manifest.sub_agents, "sub_agents")
  const model = validateModel(manifest.model)
  const thinkingEffort = nonEmptyString(manifest.thinking_effort)
  const thinkingMode = nonEmptyString(manifest.thinking_mode)
  const description = nonEmptyString(manifest.description) ?? instructions.description

  return {
    id,
    name: nonEmptyString(manifest.name) ?? instructions.name ?? id,
    ...(description ? { description } : {}),
    instructions: instructions.content,
    tools,
    skills,
    ...(subAgents ? { subAgents } : {}),
    ...(model ? { model } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
    ...(thinkingMode ? { thinkingMode } : {}),
  }
}

/** Scan one agents directory. Unreadable manifests are reported and skipped. */
export function loadAgentDir(dir: string): Record<string, AgentDef> {
  const agents: Record<string, AgentDef> = {}
  if (!fs.existsSync(dir)) return agents

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(dir, entry.name, "agent.yaml")
    if (!fs.existsSync(manifestPath)) continue
    try {
      const raw = parseYAML(fs.readFileSync(manifestPath, "utf-8"))
      agents[entry.name] = parseAgentManifest(raw, entry.name, path.join(dir, entry.name))
    } catch (error) {
      notifyWarn(
        "Agent",
        `Skipping agents/${entry.name}/agent.yaml: ${error instanceof Error ? error.message : String(error)}`,
        8000,
      )
    }
  }

  return agents
}

interface ProjectAgentSettings {
  defaultAgent?: string
  overrides: Record<string, { skillsAdd: string[]; toolsAdd: string[] }>
}

function projectAgentSettings(): ProjectAgentSettings {
  const file = path.resolve(process.cwd(), ".quark", "config.yaml")
  if (!fs.existsSync(file)) return { overrides: {} }
  const parsed = parseYAML(fs.readFileSync(file, "utf-8")) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must be a YAML mapping.`)
  const raw = parsed as Record<string, unknown>
  if (raw.version !== 3) throw new Error(`${file} requires version: 3.`)
  const overrides: ProjectAgentSettings["overrides"] = {}
  if (raw.agent_overrides !== undefined) {
    if (!raw.agent_overrides || typeof raw.agent_overrides !== "object" || Array.isArray(raw.agent_overrides)) {
      throw new Error("agent_overrides must be a mapping.")
    }
    for (const [id, value] of Object.entries(raw.agent_overrides as Record<string, unknown>)) {
      if (!AGENT_ID.test(id) || !value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`agent_overrides.${id} must be a mapping for a valid agent id.`)
      }
      const entry = value as Record<string, unknown>
      const unsupported = Object.keys(entry).find((key) => key !== "skills_add" && key !== "tools_add")
      if (unsupported) throw new Error(`agent_overrides.${id}.${unsupported} is not supported.`)
      overrides[id] = {
        skillsAdd: stringArray(entry.skills_add, `agent_overrides.${id}.skills_add`) ?? [],
        toolsAdd: stringArray(entry.tools_add, `agent_overrides.${id}.tools_add`) ?? [],
      }
    }
  }
  const defaultAgent = nonEmptyString(raw.default_agent)
  if (defaultAgent && !AGENT_ID.test(defaultAgent)) throw new Error("default_agent must be a valid agent id.")
  return { ...(defaultAgent ? { defaultAgent } : {}), overrides }
}

/** All agents: built-in coder, then global, then project (later wins). */
export function loadAgents(): Record<string, AgentDef> {
  const agents: Record<string, AgentDef> = { [BUILTIN_CODER.id]: { ...BUILTIN_CODER } }
  const dirs = [agentsDir(), projectAgentsDir()]
  for (const dir of new Set(dirs)) {
    for (const [id, def] of Object.entries(loadAgentDir(dir))) agents[id] = def
  }
  const { overrides } = projectAgentSettings()
  for (const [id, override] of Object.entries(overrides)) {
    const agent = agents[id]
    if (!agent) throw new Error(`agent_overrides.${id} references an unknown agent.`)
    agents[id] = {
      ...agent,
      skills: [...new Set([...agent.skills, ...override.skillsAdd])],
      tools: [...new Set([...agent.tools, ...override.toolsAdd])],
    }
  }
  return agents
}

/** List every available agent id, including the built-in fallback. */
export function listAgents(): string[] {
  return Object.keys(loadAgents())
}

/**
 * Resolve an agent by id.
 *
 * Order: explicit id → config `default_agent` → built-in `coder`.
 * Unknown `sub_agents` ids are warned about and stripped.
 */
export function resolveAgent(id?: string): AgentDef {
  const agents = loadAgents()
  const defaultId = projectAgentSettings().defaultAgent ?? loadConfig().defaultAgent
  const requested = id ?? defaultId
  let agent = agents[requested] ?? agents[defaultId] ?? { ...BUILTIN_CODER }

  if (agent.subAgents && agent.subAgents.length > 0) {
    const known = Object.keys(agents)
    const valid = agent.subAgents.filter((sub) => known.includes(sub))
    const invalid = agent.subAgents.filter((sub) => !known.includes(sub))
    if (invalid.length > 0) {
      notifyWarn(
        "Agent",
        `Unknown sub-agent${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}. Available agents: ${known.join(", ")}`,
        8000,
      )
      agent = { ...agent, subAgents: valid }
    }
  }

  return agent
}

/** Atomically persist an agent's thinking settings in its global manifest. */
export function setAgentThinking(id: string, thinking: { effort: string; mode?: string }): void {
  if (!AGENT_ID.test(id)) throw new Error(`Invalid agent id "${id}".`)
  const file = path.join(agentsDir(), id, "agent.yaml")
  if (!fs.existsSync(file)) throw new Error(`Agent "${id}" has no global manifest to update.`)
  const parsed = parseYAML(fs.readFileSync(file, "utf-8")) as unknown
  // Validation also prevents rewriting a malformed or mismatched manifest.
  parseAgentManifest(parsed, id, path.dirname(file))
  const manifest = { ...(parsed as Record<string, unknown>), thinking_effort: thinking.effort }
  if (thinking.mode) manifest.thinking_mode = thinking.mode
  else delete manifest.thinking_mode
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(temporary, stringifyYAML(manifest), { encoding: "utf-8", mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
}

// ---------------------------------------------------------------------------
// Materialization — resolved agent → portable AgentDefinition
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link materializeAgent}.
 *
 * `resolveSkills` exists because skill discovery is a process-global cache;
 * tests use it to stay hermetic instead of mutating cwd/HOME.
 */
export interface MaterializeDeps {
  /** Resolve bound skill names to concrete definitions. Defaults to global discovery. */
  resolveSkills?: (names: string[]) => SkillDefinition[]
}

/**
 * Materialize a portable {@link AgentDefinition} from a resolved agent.
 *
 * Built-in tools (`read`, `look`, `skill`) come from the engine; the rest are
 * imported from `<config>/tools/{id}.ts` without registering them globally.
 * Missing/invalid tools are skipped. Bound skills attach to the definition and
 * the synthesized `skill` tool.
 */
export async function materializeAgent(
  agent: AgentDef,
  deps: MaterializeDeps = {},
): Promise<AgentDefinition> {
  const skills: SkillDefinition[] = (deps.resolveSkills ?? profileSkills)(agent.skills)
  const { defs } = await loadTools(agent.tools, { register: false })
  const loaded = new Map(defs.map((def) => [def.id, def]))

  const tools: ToolDef[] = []
  for (const id of agent.tools) {
    if (id === "read") {
      tools.push(readTool)
    } else if (id === "look") {
      tools.push(lookTool)
    } else if (id === "skill") {
      tools.push(buildSkillTool(undefined, skills))
    } else {
      const def = loaded.get(id)
      if (def) tools.push(def)
    }
  }

  // Sub-agent delegation is an app concern: `sub_agents` becomes a concrete
  // tool carrying the allowed ids, so the engine never reads agent YAML and
  // the child process resolves its own agent.
  if (agent.subAgents && agent.subAgents.length > 0) {
    tools.push(createSubagentTool(agent.subAgents))
  }

  return {
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    tools,
    skills,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.thinkingEffort ? { thinkingEffort: agent.thinkingEffort } : {}),
    ...(agent.thinkingMode ? { thinkingMode: agent.thinkingMode } : {}),
  }
}

/** Exported for testing only. */
export const _internal = { BUILTIN_CODER, parseFrontmatter, readInstructions }
