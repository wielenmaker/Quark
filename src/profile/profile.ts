// Profile system — profile-driven agent identity
//
// A profile defines an agent's identity:
//   - A system prompt (read from a .md file)
//   - A strict set of tools
//   - A strict set of skills
//
// Profiles are configured in YAML config files:
//   - .quark/config.yaml  (project-level, overrides global)
//   - ~/.quark/config.yaml (global)
//
// Profile resolution order:
//   1. Explicit --profile flag / SDK parameter (deterministic)
//   2. Default profile from config
//   3. Built-in "coder" fallback

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"
import { warn as notifyWarn } from "../notification/notification"
import { type Action } from "../permission/permission"
import { loadConfig } from "../config/config"
import {
  getDefaultThinkingEffort,
  getThinkingModes,
  validateThinkingEffort,
} from "../provider/thinking"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A resolved profile definition with all paths expanded and overrides applied.
 */
export interface ProfileDef {
  /** Unique profile id (e.g. `"coder"`, `"researcher"`) */
  id: string
  /** Human-readable display name */
  name: string
  /** Description of what this profile does (from prompt file frontmatter) */
  description?: string
  /** Absolute path to the system prompt `.md` file */
  promptFile: string
  /** Tool IDs this profile can use */
  tools: string[]
  /** Skill names this profile has access to (L1 metadata loaded at activation) */
  skills: string[]
  /** Profile IDs of sub-agents this profile can spawn */
  subAgents?: string[]
  /** Model string for this profile. Falls back to config `main_model` if omitted. */
  model?: string
  /** Thinking effort for this profile's effective model. */
  thinkingEffort?: string
  /** Optional reasoning mode for models that support it. */
  thinkingMode?: string
  /** Permission rules for this profile's tools.
   *  Each rule matches a tool ID and specifies whether to allow, deny, or ask.
   *  Rules are evaluated with last-match-wins semantics.
   *
   *  TODO: later support argument-level permission via a `pattern` field. */
  permissions?: Array<{ tool: string; action: Action }>
}

/**
 * Merged profile configuration from global and project config files.
 */
export interface ProfileConfig {
  /** Default profile to activate when none specified */
  defaultProfile: string
  /** All available profile definitions keyed by ID */
  profiles: Record<string, ProfileDef>
}

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

const BUILTIN_CODER: ProfileDef = {
  id: "coder",
  name: "Coder",
  promptFile: "",
  tools: ["read", "look", "write", "edit", "bash", "skill", "todo"],
  skills: [],
}

const BUILTIN_PROMPT =
  "You are a coding assistant. Help the user with software engineering tasks."

// ---------------------------------------------------------------------------
// Config file locations
// ---------------------------------------------------------------------------

function projectConfigDir(): string {
  return path.resolve(process.cwd(), ".quark")
}

function globalConfigDir(): string {
  return path.join(os.homedir(), ".config", "quark")
}

function configPaths(): string[] {
  return [
    path.join(globalConfigDir(), "config.yaml"),
    path.join(projectConfigDir(), "config.yaml"),
  ]
}

// ---------------------------------------------------------------------------
// YAML config parsing
// ---------------------------------------------------------------------------

function parsePermissions(raw: unknown): Array<{ tool: string; action: Action }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const result: Array<{ tool: string; action: Action }> = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    if (typeof r.tool !== "string" || !r.tool) continue
    if (r.action !== "allow" && r.action !== "deny" && r.action !== "ask") continue
    result.push({ tool: r.tool, action: r.action as Action })
  }
  return result.length > 0 ? result : undefined
}

function parseProfilesFromYAML(
  raw: Record<string, unknown>,
  configDir: string,
  fallbackModel?: string,
): Record<string, ProfileDef> {
  const profiles: Record<string, ProfileDef> = {}

  const rawProfiles = raw.profiles as Record<string, unknown> | undefined
  if (!rawProfiles || typeof rawProfiles !== "object") return profiles

  for (const [id, val] of Object.entries(rawProfiles)) {
    if (!val || typeof val !== "object") continue
    const p = val as Record<string, unknown>
    const parsedModel = parseModel(p.model, id)
    const thinking = parseThinking(
      p,
      parsedModel.legacyThinking,
      parsedModel.model,
      id,
      fallbackModel,
    )

    profiles[id] = {
      id,
      name: typeof p.name === "string" ? p.name : id,
      promptFile: typeof p.prompt_file === "string" ? resolvePromptPath(p.prompt_file, configDir) : "",
      tools: Array.isArray(p.tools) ? (p.tools as string[]) : BUILTIN_CODER.tools,
      skills: Array.isArray(p.skills) ? (p.skills as string[]) : [],
      subAgents: Array.isArray(p.sub_agents) ? (p.sub_agents as string[]) : undefined,
      ...(parsedModel.model ? { model: parsedModel.model } : {}),
      ...thinking,
      permissions: parsePermissions(p.permissions),
    }
  }

  return profiles
}

function parseModel(
  raw: unknown,
  profileId: string,
): { model?: string; legacyThinking?: Record<string, unknown> } {
  if (typeof raw === "string" && raw) return { model: raw }
  if (!raw || typeof raw !== "object") return {}

  const value = raw as Record<string, unknown>
  notifyWarn(
    "Profile configuration",
    `profiles.${profileId}.model uses the deprecated nested format. Use model, thinking_effort, and thinking_mode as sibling profile fields.`,
    0,
  )

  return {
    ...(typeof value.id === "string" && value.id ? { model: value.id } : {}),
    ...(value.thinking && typeof value.thinking === "object"
      ? { legacyThinking: value.thinking as Record<string, unknown> }
      : {}),
  }
}

function parseThinking(
  profile: Record<string, unknown>,
  legacy: Record<string, unknown> | undefined,
  modelId: string | undefined,
  profileId: string,
  fallbackModel?: string,
): Pick<ProfileDef, "thinkingEffort" | "thinkingMode"> {
  const flatEffort = typeof profile.thinking_effort === "string" && profile.thinking_effort
    ? profile.thinking_effort
    : undefined
  const legacyEffort = typeof legacy?.effort === "string" && legacy.effort
    ? legacy.effort
    : undefined
  const effort = flatEffort ?? legacyEffort

  const flatMode = typeof profile.thinking_mode === "string" && profile.thinking_mode
    ? profile.thinking_mode
    : undefined
  const legacyMode = legacyEffort && typeof legacy?.mode === "string" && legacy.mode
    ? legacy.mode
    : undefined
  const mode = flatMode ?? legacyMode

  if (!effort && !mode) return {}

  const effectiveModel = modelId ?? fallbackModel ?? loadConfig().main_model
  const result: Pick<ProfileDef, "thinkingEffort" | "thinkingMode"> = {}

  if (effort) {
    try {
      validateThinkingEffort(effectiveModel, effort)
      result.thinkingEffort = effort
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const fallback = getDefaultThinkingEffort(effectiveModel)
      notifyWarn(
        "Thinking configuration",
        `profiles.${profileId}.thinking_effort "${effort}" is invalid for "${effectiveModel}". Using default "${fallback}". ${message}`,
        0,
      )
      result.thinkingEffort = fallback
    }
  }

  if (mode) {
    const modes = getThinkingModes(effectiveModel)
    if (!modes) {
      notifyWarn(
        "Thinking configuration",
        `profiles.${profileId}.thinking_mode "${mode}" is not supported by "${effectiveModel}". Ignoring it.`,
        0,
      )
    } else if (!modes.includes(mode)) {
      notifyWarn(
        "Thinking configuration",
        `profiles.${profileId}.thinking_mode "${mode}" is invalid for "${effectiveModel}". Supported modes: ${modes.join(", ")}. Ignoring it.`,
        0,
      )
    } else {
      result.thinkingMode = mode
    }
  }

  return result
}

function resolvePromptPath(promptFile: string, configDir: string): string {
  if (path.isAbsolute(promptFile)) return promptFile
  return path.resolve(configDir, promptFile)
}

// ---------------------------------------------------------------------------
// Project-level overrides (skills_add, tools_add)
// ---------------------------------------------------------------------------

interface ProjectOverrides {
  skillsAdd: string[]
  toolsAdd: string[]
}

function parseProjectOverrides(raw: Record<string, unknown>, profileId: string): ProjectOverrides {
  const result: ProjectOverrides = { skillsAdd: [], toolsAdd: [] }

  const overrides = raw.profile_overrides as Record<string, unknown> | undefined
  if (!overrides || typeof overrides !== "object") return result

  const profileOverride = overrides[profileId] as Record<string, unknown> | undefined
  if (!profileOverride || typeof profileOverride !== "object") return result

  if (Array.isArray(profileOverride.skills_add)) {
    result.skillsAdd = profileOverride.skills_add as string[]
  }
  if (Array.isArray(profileOverride.tools_add)) {
    result.toolsAdd = profileOverride.tools_add as string[]
  }

  return result
}

// ---------------------------------------------------------------------------
// Load and merge configs
// ---------------------------------------------------------------------------

let configCache: ProfileConfig | null = null

export function loadProfileConfig(): ProfileConfig {
  if (configCache) return configCache

  let defaultProfile = "coder"
  const merged: Record<string, ProfileDef> = {}

  // Always include builtin coder as fallback
  merged[BUILTIN_CODER.id] = { ...BUILTIN_CODER }

  for (const configPath of configPaths()) {
    if (!fs.existsSync(configPath)) continue

    try {
      const content = fs.readFileSync(configPath, "utf-8")
      const raw = parseYAML(content) as Record<string, unknown>
      if (!raw || typeof raw !== "object") continue

      if (typeof raw.default_profile === "string") {
        defaultProfile = raw.default_profile
      }

      const configDir = path.dirname(configPath)
      const profiles = parseProfilesFromYAML(raw, configDir)

      // Later configs (project) override earlier ones (global)
      for (const [id, prof] of Object.entries(profiles)) {
        merged[id] = prof
      }
    } catch {
      // Skip invalid config files
    }
  }

  configCache = { defaultProfile, profiles: merged }
  return configCache
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a list of sub-agent IDs against the set of known profile IDs.
 * Returns the valid IDs and the unknown/invalid IDs separately.
 * Pure function — no side effects, safe to call from tests directly.
 */
export function validateSubAgents(
  subAgents: string[],
  knownProfileIds: string[],
): { valid: string[]; invalid: string[] } {
  const valid = subAgents.filter((id) => knownProfileIds.includes(id))
  const invalid = subAgents.filter((id) => !knownProfileIds.includes(id))
  return { valid, invalid }
}

/**
 * Resolve a profile by ID.
 *
 * Resolution order:
 * 1. The profile matching `profileId` in merged config
 * 2. The configured `default_profile`
 * 3. The built-in `coder` fallback
 *
 * Applies project-level `profile_overrides` (`skills_add`, `tools_add`) after resolution.
 * Warns and strips unknown `sub_agents` IDs.
 *
 * @param profileId - Optional explicit profile ID. If omitted, the default profile is used.
 * @returns The fully resolved and override-applied {@link ProfileDef}
 */
export function resolveProfile(profileId?: string): ProfileDef {
  const config = loadProfileConfig()
  const id = profileId ?? config.defaultProfile

  let profile = config.profiles[id]
  if (!profile) {
    profile = config.profiles[config.defaultProfile] ?? { ...BUILTIN_CODER }
  }

  // Apply project-level overrides
  const projectConfig = projectConfigDir()
  const projectYamlPath = path.join(projectConfig, "config.yaml")
  if (fs.existsSync(projectYamlPath)) {
    try {
      const content = fs.readFileSync(projectYamlPath, "utf-8")
      const raw = parseYAML(content) as Record<string, unknown>
      if (raw && typeof raw === "object") {
        const overrides = parseProjectOverrides(raw, profile.id)
        if (overrides.skillsAdd.length > 0 || overrides.toolsAdd.length > 0) {
          profile = {
            ...profile,
            skills: [...profile.skills, ...overrides.skillsAdd],
            tools: [...profile.tools, ...overrides.toolsAdd],
          }
        }
      }
    } catch {
      // Skip invalid overrides
    }
  }

  // Validate sub_agents — warn about IDs that don't match any known profile
  if (profile.subAgents && profile.subAgents.length > 0) {
    const knownIds = Object.keys(config.profiles)
    const { valid, invalid } = validateSubAgents(profile.subAgents, knownIds)
    if (invalid.length > 0) {
      notifyWarn(
        "Profile",
        `Unknown sub-agent${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}. Available profiles: ${knownIds.join(", ")}`,
        8000,
      )
      profile = { ...profile, subAgents: valid }
    }
  }

  return profile
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (minimal YAML — just `key: value` lines)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { data: Record<string, string>; content: string } {
  const data: Record<string, string> = {}
  if (!raw.startsWith("---")) return { data, content: raw }

  const end = raw.indexOf("\n---", 3)
  if (end === -1) return { data, content: raw }

  const front = raw.substring(4, end) // skip "---\n"
  const content = raw.substring(end + 4).trim() // skip "\n---\n"

  for (const line of front.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.substring(0, colon).trim()
    const val = line.substring(colon + 1).trim()
    data[key] = val
  }

  return { data, content }
}

/**
 * The result of reading a profile's prompt file.
 */
export interface PromptFileResult {
  /** The system prompt text (body of the `.md` file, after frontmatter) */
  content: string
  /** `name` field from YAML frontmatter, if present */
  name?: string
  /** `description` field from YAML frontmatter, if present */
  description?: string
}

/**
 * Read the system prompt content from a profile's prompt file.
 *
 * Parses YAML frontmatter (`---`) for `name` and `description` metadata.
 * Returns the built-in default prompt if:
 * - `profile.promptFile` is empty
 * - The file does not exist or cannot be read
 *
 * @param profile - The resolved profile whose `promptFile` to read
 */
export function readPromptFile(profile: ProfileDef): PromptFileResult {
  if (!profile.promptFile) return { content: BUILTIN_PROMPT }

  try {
    const raw = fs.readFileSync(profile.promptFile, "utf-8")
    const { data, content } = parseFrontmatter(raw)
    return {
      content: content.trim() || BUILTIN_PROMPT,
      name: data.name,
      description: data.description,
    }
  } catch {
    return { content: BUILTIN_PROMPT }
  }
}

/**
 * List all available profile IDs from the merged config.
 * Always includes the built-in `"coder"` profile.
 */
export function listProfiles(): string[] {
  const config = loadProfileConfig()
  return Object.keys(config.profiles)
}

/**
 * Clear the cached profile config.
 * Call after the `/profile` switch command or when config files change at runtime.
 */
type ProfileThinking = { effort: string; mode?: string }

function updateProfileThinking(
  profile: Record<string, unknown>,
  thinking: ProfileThinking,
): Record<string, unknown> {
  const updated = { ...profile }
  if (updated.model && typeof updated.model === "object") {
    const legacyModel = updated.model as Record<string, unknown>
    if (typeof legacyModel.id === "string" && legacyModel.id) {
      updated.model = legacyModel.id
    } else {
      delete updated.model
    }
  }

  updated.thinking_effort = thinking.effort
  if (thinking.mode) {
    updated.thinking_mode = thinking.mode
  } else {
    delete updated.thinking_mode
  }
  return updated
}

export function setProfileThinking(profileId: string, thinking: ProfileThinking): void {
  const configPath = path.join(globalConfigDir(), "config.yaml")
  let raw: Record<string, unknown> = {}
  try {
    const content = fs.readFileSync(configPath, "utf-8")
    const parsed = parseYAML(content)
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>
  } catch {}

  const profiles = raw.profiles && typeof raw.profiles === "object"
    ? raw.profiles as Record<string, unknown>
    : {}
  const profile = profiles[profileId] && typeof profiles[profileId] === "object"
    ? profiles[profileId] as Record<string, unknown>
    : {}
  profiles[profileId] = updateProfileThinking(profile, thinking)
  raw.profiles = profiles

  fs.mkdirSync(globalConfigDir(), { recursive: true })
  fs.writeFileSync(configPath, stringifyYAML(raw), "utf-8")
  resetProfileCache()
}

export function resetProfileCache(): void {
  configCache = null
}

// ---------------------------------------------------------------------------
// Exported for testing only
// ---------------------------------------------------------------------------
export const _internal = {
  parseProfilesFromYAML,
  parseProjectOverrides,
  parsePermissions,
  parseModel,
  parseThinking,
  updateProfileThinking,
  validateSubAgents,
  BUILTIN_CODER,
  BUILTIN_PROMPT,
}
