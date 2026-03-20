// System prompt builder
//
// Assembles the system prompt from:
// 1. Agent prompt (from profile's prompt_file or inline)
// 2. Custom agent rules (from AGENTS.md files)
// 3. L1 skill metadata (name + description for profile-bound skills)
// 4. Environment info (cwd, OS, date)

import * as os from "os"
import { profileSkills } from "../skill/skill"
import { buildAgentRulesBlock } from "../agent-rules"
import type { AgentConfig } from "../agent"

export function buildSystem(agent: AgentConfig): string[] {
  const parts = [agent.prompt]

  // Custom agent rules from AGENTS.md files (global + project)
  const rulesBlock = buildAgentRulesBlock()
  if (rulesBlock) parts.push(rulesBlock)

  // L1 skill metadata — only for profile-bound skills
  const skillBlock = buildSkillBlock(agent.skills)
  if (skillBlock) parts.push(skillBlock)

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

function environmentBlock(): string {
  return [
    `Working directory: ${process.cwd()}`,
    `OS: ${os.platform()} (${os.release()}) on ${os.arch()}`,
    `Today's date: ${new Date().toDateString()}`,
  ].join("\n")
}
