// Agent rules loader — loads custom instructions from AGENTS.md
//
// Rules are loaded from two locations:
//   1. Global: ~/.config/atom/AGENTS.md
//   2. Per-project: <project-root>/AGENTS.md
//
// Both files are optional. If they don't exist, they default to empty.
// Rules are injected into the agent's system prompt.

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

/**
 * Load agent rules from both global and project-level AGENTS.md files.
 * Returns an object with global and project rules (empty strings if files don't exist).
 */
export function loadAgentRules(): { global: string; project: string } {
  const globalPath = path.join(os.homedir(), ".config", "atom", "AGENTS.md")
  const projectPath = path.join(process.cwd(), "AGENTS.md")

  const global = loadRulesFile(globalPath)
  const project = loadRulesFile(projectPath)

  return { global, project }
}

function loadRulesFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return ""
    return fs.readFileSync(filePath, "utf-8").trim()
  } catch {
    return ""
  }
}

/**
 * Build the rules section for the system prompt.
 * Returns null if no rules are defined.
 */
export function buildAgentRulesBlock(): string | null {
  const { global, project } = loadAgentRules()

  if (!global && !project) return null

  const parts: string[] = ["# Custom Agent Rules", ""]

  if (global) {
    parts.push("## Global Rules (from ~/.config/atom/AGENTS.md)", "", global, "")
  }

  if (project) {
    parts.push("## Project Rules (from ./AGENTS.md)", "", project, "")
  }

  return parts.join("\n").trim()
}
