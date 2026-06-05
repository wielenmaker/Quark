// Bootstrap — initialize the agent with profile-declared tools
//
// Built-in tools: read, skill (always available)
// Profile tools: loaded from ~/.config/quark/tools/{id}.ts
//
// Call this once at startup before using the agent loop.

import { register } from "./tool/registry";
import { readTool } from "./tool/read";
import { lookTool } from "./tool/look";
import { questionTool } from "./tool/question";
import { findSessionTool } from "./tool/find_session";
import { buildSkillTool } from "./tool/skill";
import { ensureStorageRoot } from "./storage/session-jsonl";
import { loadProfileTools } from "./tool/loader";
import { loadPlugins } from "./plugin/loader";
import { loadConfig } from "./config/config";

let initialized = false;

/**
 * Options for {@link bootstrap}.
 */
export interface BootstrapOptions {
  /** Tool IDs declared in the active profile's `tools[]` array. Only these tools are loaded from `~/.config/quark/tools/`. */
  profileTools?: string[];
  /** Skill names bound to the active profile. Used to filter L1 skill metadata injected into the system prompt. */
  boundSkills?: string[];
}

/**
 * Initialize the Quark agent runtime.
 *
 * Must be called **once** before using {@link prompt} or any session APIs.
 * Subsequent calls are no-ops (idempotent).
 *
 * Responsibilities:
 * - Ensures the session storage directory exists (`~/.config/quark/session/`)
 * - Registers built-in tools: `read`, `skill`, `find_session`, `read_session`
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
  if (initialized) return;
  initialized = true;

  // Ensure session storage directory exists
  ensureStorageRoot();

  // Register built-in tools (always available)
  register(readTool);
  register(lookTool);
  register(findSessionTool);
  register(questionTool);
  register(buildSkillTool(opts?.boundSkills));

  // Load profile-declared tools from ~/.config/quark/tools/
  // Missing or invalid tools are shown as notifications (non-blocking)
  if (opts?.profileTools && opts.profileTools.length > 0) {
    await loadProfileTools(opts.profileTools);
  }

  // Load plugins from ~/.config/quark/plugins/*.ts (non-blocking, errors notified)
  await loadPlugins();
}

/**
 * Reset bootstrap state.
 * @internal Use in tests only — allows re-running bootstrap in a fresh state.
 */
export function resetBootstrap(): void {
  initialized = false;
}
