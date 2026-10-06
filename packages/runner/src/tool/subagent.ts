import { z } from "zod"
import { runSubagent } from "../subagent/supervisor"
import type { SubagentCommand } from "../subagent/executable"
import { defineTool } from "./tool"

/** Host-supplied overrides for the subagent tool. */
export interface SubagentToolOptions {
  /**
   * Explicit child command. The app computes this once from its own location
   * (see the app's app-paths module); the engine falls back to argv-based
   * auto-detection when omitted.
   */
  executable?: SubagentCommand
}

/**
 * Delegate tool for a fixed set of child agent IDs.
 *
 * The allowed list is supplied by the caller (the app resolves it from its
 * profile config and bakes the tool into the AgentDefinition). The engine
 * never reads profile config here; the child validates its own id.
 */
export function createSubagentTool(allowedProfiles: string[], options: SubagentToolOptions = {}) {
  const allowed = new Set(allowedProfiles)
  return defineTool({
    id: "subagent",
    description: `Delegate a focused task to an isolated subagent. Available agents: ${allowedProfiles.join(", ")}. The child resolves its own tools, skills, and model.`,
    parameters: z.object({
      profile: z.string().min(1).describe("An available subagent ID"),
      prompt: z.string().min(1).describe("A complete, self-contained task for the subagent"),
    }).strict(),
    async execute(args, ctx) {
      if (!allowed.has(args.profile)) {
        throw new Error(`Subagent "${args.profile}" is not allowed. Available agents: ${allowedProfiles.join(", ")}`)
      }

      const result = await runSubagent(args, ctx, options.executable)
      return {
        title: `Subagent: ${args.profile}`,
        output: result.output,
        metadata: {
          subAgent: {
            profile: args.profile,
            prompt: args.prompt,
            childSessionId: result.childSessionId,
            modelName: result.modelName,
            tokenLimit: result.tokenLimit,
          },
        },
      }
    },
  })
}
