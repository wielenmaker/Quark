// System prompt builder
//
// Assembles the system prompt from:
// 1. Global instructions (from ~/.config/quark/AGENTS.md)
// 2. Project instructions (from ./AGENTS.md)
// 3. Agent prompt (from profile's prompt_file or inline)
// 4. L1 skill metadata (name + description for profile-bound skills)
// 5. Sub-agent list (profile IDs the agent can spawn)
// 6. Environment info (cwd, OS, date)

import * as os from "os"
import * as fs from "fs"
import * as path from "path"
import { profileSkills } from "../skill/skill"
import { loadProfileConfig, readPromptFile } from "../profile/profile"
import type { AgentConfig } from "../agent"

export function buildSystem(agent: AgentConfig): string[] {
  const parts: string[] = []

  // Global agent instructions (from ~/.config/quark/AGENTS.md)
  const globalInstructions = loadGlobalAgentInstructions()
  if (globalInstructions) parts.push(globalInstructions)

  // Project agent instructions (from ./AGENTS.md)
  const projectInstructions = loadProjectAgentInstructions()
  if (projectInstructions) parts.push(projectInstructions)

  // Agent prompt (from profile)
  parts.push(agent.prompt)

  // L1 skill metadata — only for profile-bound skills
  const skillBlock = buildSkillBlock(agent.skills)
  if (skillBlock) parts.push(skillBlock)

  if (agent.runtimeSkills?.length) {
    parts.push(...agent.runtimeSkills)
  }

  // Sub-agent metadata
  const subAgentBlock = buildSubAgentBlock(agent.subAgents)
  if (subAgentBlock) parts.push(subAgentBlock)

  parts.push(environmentBlock())
  return parts
}

function buildSkillBlock(skillNames: string[]): string | null {
  const skills = profileSkills(skillNames)
  if (skills.length === 0) return null

  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`)
  return [
    "# Available Skills",
    "",
    "Use the `skill` tool to load any of these when needed:",
    ...lines,
  ].join("\n")
}

export function buildSubAgentBlock(subAgentIds?: string[]): string | null {
  if (!subAgentIds || subAgentIds.length === 0) return null

  const config = loadProfileConfig()
  const lines = subAgentIds
    .filter((id) => config.profiles[id])
    .map((id) => {
      const prof = config.profiles[id]!
      // Read prompt file to get name and description from frontmatter
      const { name, description } = readPromptFile(prof)
      const displayName = name || prof.name
      if (description) {
        return `- **${displayName}** (\`${id}\`): ${description}`
      }
      return `- **${displayName}** (\`${id}\`)`
    })

  if (lines.length === 0) return null

  return [
    "# Available Sub-Agents",
    "",
    "Use the `subagent` tool with a profile ID and a complete task prompt to delegate to one of these isolated agents:",
    ...lines,
  ].join("\n")
}

function environmentBlock(): string {
  return [
    "# Environment",
    "",
    `Working directory: ${process.cwd()}`,
    `OS: ${os.platform()} (${os.release()}) on ${os.arch()}`,
    `Today's date: ${new Date().toDateString()}`,
  ].join("\n")
}

function loadGlobalAgentInstructions(): string | null {
  const globalPath = path.join(os.homedir(), ".config", "quark", "AGENTS.md")
  try {
    const content = fs.readFileSync(globalPath, "utf-8").trim()
    if (!content) return null
    return `# Global Agent Instructions\n\n${content}`
  } catch {
    return null
  }
}

function loadProjectAgentInstructions(): string | null {
  const projectPath = path.resolve(process.cwd(), "AGENTS.md")
  try {
    const content = fs.readFileSync(projectPath, "utf-8").trim()
    if (!content) return null
    return `# Project Agent Instructions\n\n${content}`
  } catch {
    return null
  }
}
