// App-owned single-file profiles resolved into portable agent definitions.
// Profiles live only in <config>/profile/<id>.yaml.

import * as fs from "node:fs"
import * as path from "node:path"
import { parse as parseYAML } from "yaml"
import { buildSkillTool } from "@quark/runner/tool/skill"
import { createSubagentTool } from "@quark/runner/tool/subagent"
import { lookTool } from "@quark/runner/tool/look"
import { readTool } from "@quark/runner/tool/read"
import { questionTool } from "@quark/runner/tool/question"
import { profileSkills, type SkillDefinition } from "@quark/runner/skill/skill"
import { warn as notifyWarn } from "@quark/runner/notification/notification"
import { loadTools } from "../tool-loader"
import { configDir, loadConfig } from "../config/config"
import type { AgentDefinition } from "@quark/runner/agent"
import type { ToolDef } from "@quark/runner/tool/tool"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved single-file profile ready to become a portable agent definition. */
export interface AgentDef {
  /** Unique profile id (file stem) */
  id: string
  name: string
  description?: string
  /** Resolved system prompt, never a file path. */
  instructions: string
  tools: string[]
  skills: string[]
  subAgents?: string[]
  /** Model spec in `provider/model` form. */
  model?: string
  thinkingEffort?: string
  thinkingMode?: string
  /** Optional fast processing; omitted inherits the provider default. */
  fastMode?: boolean
}

export const BUILTIN_TOOLS = ["read", "look", "write", "edit", "bash", "skill", "todo"]

export const BUILTIN_INSTRUCTIONS =
  "You are a coding assistant. Help the user with software engineering tasks."

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

/** Global profile directory, resolved per call for QUARK_CONFIG_DIR. */
export function profilesDir(): string {
  return path.join(configDir(), "profile")
}

/** Read a string array, using a copy of the default when the field is absent. */
function stringArray(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`)
  }
  return value as string[]
}

/** Validate and trim an optional non-empty YAML string. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`)
  return value.trim()
}

/** Parse one self-contained profile; invalid files are rejected rather than partially applied. */
export function parseProfile(raw: unknown, id: string): AgentDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`profile/${id}.yaml must be a mapping.`)
  }
  const profile = raw as Record<string, unknown>
  const model = profile.model
  if (model !== undefined && (!model || typeof model !== "object" || Array.isArray(model))) {
    throw new Error("model must be a mapping with id and thinking_effort.")
  }
  const modelFields = model as Record<string, unknown> | undefined
  const modelId = optionalString(modelFields?.id, "model.id")
  if (modelId && !/^[^/\s]+\/[^\s]+$/.test(modelId)) {
    throw new Error("model.id must use provider/model format.")
  }
  const effort = optionalString(modelFields?.thinking_effort, "model.thinking_effort")
  const mode = optionalString(modelFields?.thinking_mode, "model.thinking_mode")
  const fastMode = modelFields?.fast_mode
  if (fastMode !== undefined && typeof fastMode !== "boolean") throw new Error("model.fast_mode must be a boolean.")
  if ((effort || mode || fastMode !== undefined) && !modelId) throw new Error("model.id is required when thinking or fast mode is configured.")
  if (profile.prompt !== undefined && typeof profile.prompt !== "string") {
    throw new Error("prompt must be a string.")
  }
  return {
    id,
    name: optionalString(profile.name, "name") ?? id,
    ...(optionalString(profile.description, "description") ? { description: optionalString(profile.description, "description") } : {}),
    instructions: (profile.prompt as string | undefined) || BUILTIN_INSTRUCTIONS,
    tools: stringArray(profile.tools, "tools", BUILTIN_TOOLS),
    skills: stringArray(profile.skills, "skills", []),
    ...(profile.subagents !== undefined ? { subAgents: stringArray(profile.subagents, "subagents", []) } : {}),
    ...(modelId ? { model: modelId } : {}),
    ...(effort ? { thinkingEffort: effort } : {}),
    ...(mode ? { thinkingMode: mode } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  }
}

/** Scan YAML files in one directory. Invalid profiles are warned about and skipped. */
export function loadProfileDir(dir: string): Record<string, AgentDef> {
  const profiles: Record<string, AgentDef> = Object.create(null)
  if (!fs.existsSync(dir)) return profiles
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue
    const id = entry.name.slice(0, -5)
    try {
      profiles[id] = parseProfile(parseYAML(fs.readFileSync(path.join(dir, entry.name), "utf-8")), id)
    } catch (error) {
      notifyWarn("Agent", `Skipping profile/${entry.name}: ${error instanceof Error ? error.message : String(error)}`, 8000)
    }
  }
  return profiles
}

/** Load global profiles, allowing an explicit coder.yaml to override the built-in fallback. */
export function loadAgents(): Record<string, AgentDef> {
  const agents: Record<string, AgentDef> = Object.create(null)
  agents[BUILTIN_CODER.id] = { ...BUILTIN_CODER }
  Object.assign(agents, loadProfileDir(profilesDir()))
  return agents
}

/** List available profile IDs, including the built-in coder. */
export function listAgents(): string[] {
  return Object.keys(loadAgents())
}

/** Resolve explicit id, config default, or built-in coder. Unknown subagents are stripped. */
export function resolveAgent(id?: string): AgentDef {
  const agents = loadAgents()
  const defaultId = loadConfig().defaultAgent ?? BUILTIN_CODER.id
  const requested = id ?? defaultId
  let agent = agents[requested] ?? agents[defaultId] ?? { ...BUILTIN_CODER }

  if (agent.subAgents && agent.subAgents.length > 0) {
    const known = Object.keys(agents)
    const valid = agent.subAgents.filter((sub) => Object.hasOwn(agents, sub))
    const invalid = agent.subAgents.filter((sub) => !Object.hasOwn(agents, sub))
    if (invalid.length > 0) {
      notifyWarn("Agent", `Unknown sub-agent${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}. Available agents: ${known.join(", ")}`, 8000)
      agent = { ...agent, subAgents: valid }
    }
  }
  return agent
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
 * Engine-owned tools (`read`, `look`, `skill`, `question`) come from
 * `@quark/runner`; the rest are imported from `<config>/tools/{id}.ts` without
 * registering them globally. Missing/invalid tools are skipped. Bound skills
 * attach to the definition and the synthesized `skill` tool.
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
    } else if (id === "question") {
      tools.push(questionTool)
    } else {
      const def = loaded.get(id)
      if (def) tools.push(def)
    }
  }

  // Sub-agent delegation is an app concern: `subagents` becomes a concrete
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
    ...(agent.fastMode !== undefined ? { fastMode: agent.fastMode } : {}),
  }
}
