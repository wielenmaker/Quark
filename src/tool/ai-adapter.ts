import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai"
import { z } from "zod"
import type { AgentConfig } from "../agent"
import {
  ask as askPermission,
  CorrectedError,
  RejectedError,
  type Ruleset,
} from "../permission/permission"
import { extractFilePath, toolPreExecute } from "../commands/undo"
import { fireHook } from "../plugin/registry"
import { bus } from "../session/events"
import { resolveAvailable } from "./registry"
import type { ToolDef } from "./tool"

export function resolveToolSet(
  agent: AgentConfig,
  sessionId: string,
  messageId: string,
  abort: AbortSignal,
): ToolSet {
  const defs = resolveAvailable([...agent.tools])
  const ruleset: Ruleset = (agent.permissions ?? []).map((r) => ({
    tool: r.tool,
    pattern: r.pattern ?? "*",
    action: r.action,
  }))
  const result: ToolSet = {}

  for (const def of defs) {
    result[def.id] = toAITool(def, sessionId, messageId, abort, ruleset)
  }

  return result
}

function abortSignalToPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    )
  }
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(
          Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
        )
      },
      { once: true },
    )
  })
}

function toAITool(
  def: ToolDef,
  sessionId: string,
  messageId: string,
  abort: AbortSignal,
  ruleset: Ruleset,
) {
  const schema = z.toJSONSchema(def.parameters)

  return tool({
    description: def.description,
    inputSchema: jsonSchema(schema as any),
    async execute(args: any, options: ToolExecutionOptions) {
      const callId = options.toolCallId
      const abortSig = options.abortSignal ?? abort

      const parseResult = def.parameters.safeParse(args)
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n")
        return {
          title: `Invalid arguments for ${def.id}`,
          output: `Invalid arguments for tool "${def.id}":\n${msg}`,
          metadata: { error: "invalid_arguments", issues: parseResult.error.issues },
        }
      }
      const validatedArgs = parseResult.data as Record<string, unknown>

      // Derive the resource path for permission evaluation:
      // file-modifying tools use the target file path; everything else uses "*".
      const resourcePath = extractFilePath(def.id, validatedArgs) ?? "*"

      try {
        await askPermission({
          sessionId,
          tool: def.id,
          pattern: resourcePath,
          ruleset,
        })
      } catch (e) {
        if (e instanceof RejectedError || e instanceof CorrectedError) {
          bus.emit("permission-rejected", { sessionId })
        }
        throw e
      }

      try {
        const fp = extractFilePath(def.id, validatedArgs)
        if (fp) await toolPreExecute(sessionId, fp)
      } catch {
        // Snapshot failure is best-effort.
      }

      bus.emit("tool-running", { sessionId, messageId, callId })

      const ctx = {
        sessionId,
        messageId,
        callId,
        abort: abortSig,
        async ask(tool: string, pattern: string) {
          await askPermission({
            sessionId,
            tool,
            pattern,
            ruleset,
          })
        },
      }

      const beforeArgs = await fireHook(
        "tool.execute.before",
        { tool: def.id, args: validatedArgs },
        { args: validatedArgs },
      )
      const toolResult = await Promise.race([
        def.execute(beforeArgs.args as any, ctx),
        abortSignalToPromise(abortSig),
      ])
      await fireHook("tool.execute.after", {
        tool: def.id,
        args: beforeArgs.args,
        result: (toolResult as any).output ?? "",
      })
      return toolResult
    },
    toModelOutput(result: any) {
      if (Array.isArray(result.output)) {
        return {
          type: "content" as const,
          value: result.output,
        }
      }
      return {
        type: "text" as const,
        value: result.output as string,
      }
    },
  })
}
