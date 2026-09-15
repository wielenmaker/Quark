import { For, Show, createSignal } from "solid-js"
import { ChevronIcon } from "../icons"
import type { MessagePart } from "../types"

type ToolPart = Extract<MessagePart, { type: "tool" }>

export type ToolDisplayPart = Pick<ToolPart, "tool" | "status" | "input" | "error">

function toolLabel(input: Record<string, unknown>): string {
  const value = input.filePath ?? input.file_path ?? input.path ?? input.command ?? input.cmd ?? input.pattern ?? input.query
  return typeof value === "string" ? value : ""
}

export function ToolRow(props: { part: ToolDisplayPart }) {
  const name = () => props.part.tool.slice(0, 1).toUpperCase() + props.part.tool.slice(1)
  return (
    <div class="tool-row" title={props.part.error}>
      <span class="tool-icon">{props.part.tool.slice(0, 1).toUpperCase()}</span>
      <span class="tool-name">{name()}</span>
      <code>{toolLabel(props.part.input)}</code>
      <span class={`tool-result ${props.part.status}`}>{props.part.status === "completed" ? "Done" : props.part.status}</span>
    </div>
  )
}

export function ToolActivity(props: { parts: ToolPart[] }) {
  const [expanded, setExpanded] = createSignal(true)
  const active = () => props.parts.some((part) => part.status === "pending" || part.status === "running")
  const failed = () => props.parts.some((part) => part.status === "error")

  return (
    <section classList={{ "tool-activity": true, expanded: expanded() }}>
      <button class="activity-summary" type="button" aria-expanded={expanded()} onClick={() => setExpanded((value) => !value)}>
        <span class={`status-dot ${failed() ? "error" : active() ? "active" : "success"}`} aria-hidden="true" />
        <span class="activity-title">{active() ? "Using tools…" : "Used tools"}</span>
        <span class="activity-count">{props.parts.length} operation{props.parts.length === 1 ? "" : "s"}</span>
        <ChevronIcon class="activity-chevron" />
      </button>
      <Show when={expanded()}>
        <div class="tool-list"><For each={props.parts}>{(part) => <ToolRow part={part} />}</For></div>
      </Show>
    </section>
  )
}
