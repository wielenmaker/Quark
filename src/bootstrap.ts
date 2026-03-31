// Bootstrap — initialize the agent with profile-declared tools
//
// Built-in tools: read, skill (always available)
// Profile tools: loaded from ~/.config/quark/tools/{id}.ts
//
// Call this once at startup before using the agent loop.

import { register } from "./tool/registry"
import { readTool } from "./tool/read"
import { compactTool } from "./tool/compact"
import { buildSkillTool } from "./tool/skill"
import { getDB } from "./storage/db"
import { loadProfileTools } from "./tool/loader"
import { loadPlugins } from "./plugin/loader"
import { registerMethod, setDefaultMethod } from "./session/compact-resolver"
import { anchored } from "./session/methods/anchored"
import { general } from "./session/methods/general"
import { loadConfig } from "./config/config"

let initialized = false

/**
 * Options for {@link bootstrap}.
 */
export interface BootstrapOptions {
  /** Tool IDs declared in the active profile's `tools[]` array. Only these tools are loaded from `~/.config/quark/tools/`. */
  profileTools?: string[]
  /** Skill names bound to the active profile. Used to filter L1 skill metadata injected into the system prompt. */
  boundSkills?: string[]
  /**
   * When true, opens an in-memory SQLite database instead of the shared quark.db file.
   * Used for sub-agents to avoid WAL write contention with the parent process.
   * Sub-agent activity is streamed to the parent via stderr NDJSON events, so persistence is not needed.
   */
  subAgent?: boolean
}

/**
 * Initialize the Quark agent runtime.
 *
 * Must be called **once** before using {@link prompt} or any session APIs.
 * Subsequent calls are no-ops (idempotent).
 *
 * Responsibilities:
 * - Opens the SQLite database (`quark.db`)
 * - Registers built-in tools: `read`, `compact`, `skill`
 * - Registers and sets the default compaction method from config
 * - Loads profile-declared external tools from `~/.config/quark/tools/{id}.ts`
 * - Loads plugins from `~/.config/quark/plugins/*.ts`
 *
 * @param opts - Optional bootstrap configuration
 *
 * @example
 * ```ts
 * import { bootstrap, prompt } from '@quark/sdk'
 *
 * await bootstrap({ profileTools: ['bash', 'write'] })
 * await prompt({ parts: [{ type: 'text', text: 'Hello!' }] })
 * ```
 */
export async function bootstrap(opts?: BootstrapOptions): Promise<void> {
  if (initialized) return
  initialized = true

  // Initialize SQLite database (lazy — creates tables on first access).
  // Sub-agents use an in-memory DB to avoid WAL write contention with the parent process.
  getDB(opts?.subAgent ? ":memory:" : undefined)

  // Register built-in tools (always available)
  register(readTool)
  register(compactTool)
  register(buildSkillTool(opts?.boundSkills))

  // Register compaction methods and set default from config
  registerMethod(anchored)
  registerMethod(general)
  setDefaultMethod(loadConfig().compact.method)

  // Load profile-declared tools from ~/.config/quark/tools/
  // Missing or invalid tools are shown as notifications (non-blocking)
  if (opts?.profileTools && opts.profileTools.length > 0) {
    await loadProfileTools(opts.profileTools)
  }

  // Load plugins from ~/.config/quark/plugins/*.ts (non-blocking, errors notified)
  await loadPlugins()
}

/**
 * Reset bootstrap state.
 * @internal Use in tests only — allows re-running bootstrap in a fresh state.
 */
export function resetBootstrap(): void {
  initialized = false
}
