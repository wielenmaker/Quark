import { z } from "zod"
import { runSubagent } from "../subagent/supervisor"
import type { SubagentCommand } from "../subagent/executable"
import { defineTool } from "./tool"

export interface SubagentToolOptions {
  /** Host-resolved child executable (auto-detected when omitted). */
  executable?: SubagentCommand
}

export function createSubagentTool(allowedProfiles: string[], options: SubagentToolOptions = {}) {
  const allowed = new Set(allowedProfiles)
  return defineTool({
    id: "subagent",
    description: `Delegate a task to an isolated, memory-only subagent. Available agents: ${allowedProfiles.join(", ")}. Start with profile + prompt, or continue a live conversation with resume + prompt using its returned sa-... ID. Provide exactly one of profile or resume. IDs expire when their process exits.`,
    parameters: z.object({
      profile: z.string().min(1).optional().describe("Available agent profile for a NEW conversation; omit when resuming"),
      resume: z.string().startsWith("sa-").optional().describe("Live subagent session ID to continue; omit profile"),
      prompt: z.string().min(1).describe("Task or follow-up message for the subagent"),
    }).strict(),
    async execute(args, ctx) {
      const result = await runSubagent(args, ctx, options.executable, allowed)
      return {
        title: `Subagent: ${result.profile}`,
        output: result.output,
        metadata: {},
        // No child session metadata is persisted in the main conversation.
      }
    },
  })
}
