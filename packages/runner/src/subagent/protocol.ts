export const SUBAGENT_EVENT_PREFIX = "QUARK_EVENT:"

export type SubagentErrorKind = "provider" | "process" | "protocol"

export type ChildEvent =
  | { e: "ready"; sessionId: string; profile: string; model?: string; tokenLimit?: number }
  | { e: "tool-start"; t: string; id: string }
  | { e: "tool-input"; t: string; id: string; in: Record<string, unknown> }
  | { e: "tool-running"; id: string }
  | { e: "tool-end"; t: string; id: string; s: "completed" | "error"; err?: string }
  | { e: "step-finish"; tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; tokenLimit?: number; model?: string }
  | { e: "text-delta"; d: string }
  | { e: "error"; kind: SubagentErrorKind; message: string }
  | { e: "loop-end" }
  | { e: "result"; sessionId: string; profile: string; output: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Parse and minimally validate one prefixed child event line. */
export function parseChildEventLine(line: string): ChildEvent | null {
  if (!line.startsWith(SUBAGENT_EVENT_PREFIX)) return null

  const value: unknown = JSON.parse(line.slice(SUBAGENT_EVENT_PREFIX.length))
  if (!isRecord(value) || !isString(value.e)) {
    throw new Error("Subagent event must be an object with an event name")
  }

  switch (value.e) {
    case "ready":
      if (!isString(value.sessionId) || !isString(value.profile)) break
      return value as ChildEvent
    case "tool-start":
      if (!isString(value.t) || !isString(value.id)) break
      return value as ChildEvent
    case "tool-input":
      if (!isString(value.t) || !isString(value.id) || !isRecord(value.in)) break
      return value as ChildEvent
    case "tool-running":
      if (!isString(value.id)) break
      return value as ChildEvent
    case "tool-end":
      if (!isString(value.t) || !isString(value.id) || (value.s !== "completed" && value.s !== "error")) break
      return value as ChildEvent
    case "step-finish":
      return value as ChildEvent
    case "text-delta":
      if (typeof value.d !== "string") break
      return value as ChildEvent
    case "error":
      if (!isString(value.message) || !["provider", "process", "protocol"].includes(String(value.kind))) break
      return value as ChildEvent
    case "result":
      if (!isString(value.sessionId) || !isString(value.profile) || typeof value.output !== "string") break
      return value as ChildEvent
    case "loop-end":
      return value as ChildEvent
  }

  throw new Error(`Invalid subagent event payload for "${value.e}"`)
}
