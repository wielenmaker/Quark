// Skill discovery and parsing — find and parse SKILL.md files
//
// Searches two locations:
// 1. .quark/skills/*/SKILL.md  (project-level)
// 2. ~/.config/quark/skills/*/SKILL.md (global)
//
// SKILL.md format:
// ---
// name: my-skill
// description: What this skill does
// ---
// <markdown body with instructions>

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export interface Skill {
  name: string
  description: string
  content: string
  location: string
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

// ---------------------------------------------------------------------------
// Scan a directory for SKILL.md files in subdirectories
// ---------------------------------------------------------------------------
function scanDir(dir: string): Skill[] {
  const skills: Skill[] = []
  if (!fs.existsSync(dir)) return skills

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    const skillFile = path.join(dir, entry, "SKILL.md")
    if (!fs.existsSync(skillFile)) continue

    try {
      const raw = fs.readFileSync(skillFile, "utf-8")
      const { data, content } = parseFrontmatter(raw)

      skills.push({
        name: data.name ?? entry,
        description: data.description ?? "",
        content,
        location: skillFile,
      })
    } catch {
      // skip unreadable files
    }
  }

  return skills
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cache: Skill[] | null = null

export function discoverSkills(dirs?: string[]): Skill[] {
  if (cache) return cache

  const searchDirs = dirs ?? [
    path.join(os.homedir(), ".config", "quark", "skills"),
    path.resolve(process.cwd(), ".quark", "skills"),
  ]

  const seen = new Map<string, Skill>()
  for (const dir of searchDirs) {
    for (const skill of scanDir(dir)) {
      // Project-level overrides global (last wins)
      seen.set(skill.name, skill)
    }
  }

  cache = Array.from(seen.values())
  return cache
}

/**
 * Get only the skills bound to the given profile skill names.
 * Returns L1 metadata (name + description) for system prompt injection.
 */
export function profileSkills(skillNames: string[]): Skill[] {
  if (skillNames.length === 0) return []
  const all = discoverSkills()
  const nameSet = new Set(skillNames)
  return all.filter((s) => nameSet.has(s.name))
}

export function loadSkill(name: string): Skill | undefined {
  const skills = discoverSkills()
  return skills.find((s) => s.name === name)
}

export function clearCache() {
  cache = null
}
