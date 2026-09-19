// Bootstrap — initialize the legacy global agent registry.
//
// App-side orchestration: the engine exports the built-in ToolDefs and the
// global registry; this module wires them together and loads the filesystem
// adapters (agent tools from <config>/tools/, plugins from <config>/plugins/).
//
// Built-in tools: read, look, skill (always available)
// Agent tools: loaded from <config>/tools/{id}.ts
//
// Call this once at startup before using the legacy `prompt()`/AgentConfig path.

import { register } from "@quark/runner";
import { readTool } from "@quark/runner/tool/read";
import { lookTool } from "@quark/runner/tool/look";
import { buildSkillTool } from "@quark/runner/tool/skill";
import { ensureStorageRoot } from "@quark/runner/storage/session-jsonl";
import { loadTools } from "./tool-loader";
import { loadPlugins } from "./plugin-loader";

let initialized = false;

/**
 * Options for {@link bootstrap}.
 */
export interface BootstrapOptions {
  /** Tool IDs declared in the active agent's `tools[]` array. Only these tools are loaded from `<config>/tools/`. */
  agentTools?: string[];
  /** Skill names bound to the active agent. Used to filter L1 skill metadata injected into the system prompt. */
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
 * - Registers built-in tools: `read`, `look`, `skill`
 * - Loads agent-declared external tools from `~/.config/quark/tools/{id}.ts`
 * - Loads plugins from `~/.config/quark/plugins/*.ts`
 *
 * @param opts - Optional bootstrap configuration
 *
 * @example
 * ```ts
 * import { bootstrap } from "./bootstrap"
 * import { prompt } from "@quark/runner"
 *
 * await bootstrap({ agentTools: ['bash', 'write'] })
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
  register(buildSkillTool(opts?.boundSkills));

  // Load agent-declared tools from ~/.config/quark/tools/
  // Missing or invalid tools are shown as notifications (non-blocking)
  if (opts?.agentTools && opts.agentTools.length > 0) {
    await loadTools(opts.agentTools);
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
