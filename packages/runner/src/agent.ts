// Portable agent definition — the engine's only agent input.
//
// An AgentDefinition is self-contained: resolved instructions, concrete tool
// implementations, and concrete skill content. It can be handed to
// `createRunner` without any global registry, config file, or profile lookup.

import type { SkillDefinition } from "./skill/skill"
import type { ToolDef } from "./tool/tool"

/**
 * A self-contained, portable agent definition.
 *
 * Unlike a profile-config reference (tool ID, skill name, prompt file path),
 * an AgentDefinition carries everything the engine needs.
 */
export interface AgentDefinition {
  /** Unique agent identifier */
  id: string
  /** Optional definition version, for callers that version their agents */
  version?: string
  /** Optional human-readable display name */
  name?: string
  /** Optional short persona/role line rendered into the system prompt */
  persona?: string
  /** Model spec in `provider/model` form */
  model?: string
  /** Thinking effort for this agent's effective model */
  thinkingEffort?: string
  /** Optional reasoning mode for models that support it */
  thinkingMode?: string
  /** Fast processing (may cost extra); false requests standard, omitted inherits provider defaults. */
  fastMode?: boolean
  /** Resolved system-prompt text (never a config path) */
  instructions: string
  /** Concrete tool definitions, scoped to the agent instance */
  tools: ToolDef[]
  /** Concrete skill definitions (metadata + content) */
  skills?: SkillDefinition[]
}

/**
 * Identity helper that returns an {@link AgentDefinition} unchanged.
 *
 * @example
 * ```ts
 * const reviewer = defineAgent({
 *   id: 'reviewer',
 *   persona: 'A meticulous code reviewer',
 *   instructions: 'Review the diff and report concrete issues.',
 *   tools: [readTool],
 * })
 * ```
 */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def
}
