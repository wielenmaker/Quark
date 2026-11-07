import { randomUUID } from "node:crypto"
import type { ToolContext } from "../tool/tool"
import { SubagentChild } from "./child"
import { abortError } from "./errors"
import { resolveSubagentCommand, type SubagentCommand } from "./executable"

export { SubagentExecutionError } from "./errors"
export type { SubagentRunResult } from "./child"

// Process-owned, deliberately outside session storage and tool metadata.
const children = new Map<string, SubagentChild>()
let cleanupInstalled = false

export interface SubagentInput {
  profile?: string
  resume?: string
  prompt: string
}

export function closeSubagents(): void {
  for (const child of children.values()) child.close()
  children.clear()
}

export async function runSubagent(input: SubagentInput, ctx: ToolContext, executable?: SubagentCommand, allowedProfiles?: ReadonlySet<string>) {
  if (ctx.abort.aborted) throw abortError()
  if (Boolean(input.profile) === Boolean(input.resume)) throw new Error("Provide exactly one of profile or resume")
  let child: SubagentChild
  if (input.resume) {
    const existing = children.get(input.resume)
    if (!existing) throw new Error(`Subagent session expired or unknown: ${input.resume}`)
    if (existing.owner !== ctx.sessionId) throw new Error("Subagent session belongs to another main session")
    if (allowedProfiles && !allowedProfiles.has(existing.profile)) throw new Error(`Subagent "${existing.profile}" is not allowed`)
    child = existing
  } else {
    const profile = input.profile!
    if (allowedProfiles && !allowedProfiles.has(profile)) throw new Error(`Subagent "${profile}" is not allowed. Available agents: ${[...allowedProfiles].join(", ")}`)
    const id = `sa-${randomUUID()}`
    child = new SubagentChild(id, profile, ctx.sessionId, ctx.workspace ?? process.cwd(), executable ?? resolveSubagentCommand(), () => children.delete(id))
    children.set(id, child)
    if (!cleanupInstalled) {
      process.once("exit", closeSubagents)
      cleanupInstalled = true
    }
  }
  return child.run(input.prompt, ctx)
}
