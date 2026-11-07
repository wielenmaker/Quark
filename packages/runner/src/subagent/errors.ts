import type { SubagentErrorKind } from "./protocol"

export class SubagentExecutionError extends Error {
  constructor(public readonly kind: SubagentErrorKind, message: string) {
    super(message)
    this.name = "SubagentExecutionError"
  }
}

export function abortError(): Error {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
}
