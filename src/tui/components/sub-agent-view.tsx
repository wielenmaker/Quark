// @jsxImportSource @opentui/solid
// SubAgentView — renders sub-agent tool activity as a nested tree
//
// Shows:
//   ⠋ Finder                        12.4k tokens (8%)
//   ├── ✓ WebSearch "what is AI"
//   ├── ⠋ Read https://en.wikipedia...
//   └── Streaming: "AI stands for..."
//
// When done:
//   ✓ Finder                        24.1k tokens (16%)
//   ├── ✓ WebSearch "what is AI"
//   ├── ✓ Read https://en.wikipedia...
//   └── ✓ WebSearch "AI techniques"

import type { Component } from "solid-js"
import { Show, For, Switch, Match } from "solid-js"
import { colors, icons } from "../theme"
import { RGBA } from "@opentui/core"
import { InlineSpinner } from "./inline-spinner"
import type { SubAgentState, SubAgentToolPart } from "../state"

interface SubAgentViewProps {
  subAgent: SubAgentState
}

// Map tool IDs to display names (same as tool-result.tsx)
function getToolDisplayName(tool: string): string {
  const names: Record<string, string> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    bash: "Bash",
    skill: "Skill",
    todo: "Todo",
    grep: "Grep",
    glob: "Glob",
    websearch: "WebSearch",
  }
  return names[tool] ?? tool.charAt(0).toUpperCase() + tool.slice(1)
}

// Extract a short label from tool input
function getToolLabel(tool: string, input: Record<string, unknown>): string {
  const path = input.filePath ?? input.file_path ?? input.path
  if (typeof path === "string") {
    return path.replace(/^\/Users\/[^/]+\//, "~/")
  }

  const cmd = input.command ?? input.cmd
  if (typeof cmd === "string") {
    return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd
  }

  const pattern = input.pattern
  if (typeof pattern === "string") {
    return pattern.length > 50 ? pattern.slice(0, 47) + "..." : pattern
  }

  const query = input.query
  if (typeof query === "string") {
    return query.length > 50 ? query.slice(0, 47) + "..." : query
  }

  const url = input.url
  if (typeof url === "string") {
    return url.length > 50 ? url.slice(0, 47) + "..." : url
  }

  const name = input.name ?? input.skill
  if (typeof name === "string") return name

  return ""
}

// Format token count: 1234 → "1.2k", 123456 → "123.5k"
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + "k"
  return (n / 1000).toFixed(1) + "k"
}

const ChildToolLine: Component<{ tool: SubAgentToolPart; isLast: boolean }> = (props) => {
  const displayName = getToolDisplayName(props.tool.tool)
  const label = () => getToolLabel(props.tool.tool, props.tool.input)
  const connector = () => props.isLast ? icons.treeCorner : icons.treeTee
  const isRunning = () => props.tool.status === "running"
  const isPending = () => props.tool.status === "pending"
  const isError = () => props.tool.status === "error"

  return (
    <box flexDirection="row">
      <text fg={colors.muted}>{connector()} </text>
      <Switch>
        <Match when={isRunning()}>
          <InlineSpinner />
          <text> </text>
        </Match>
        <Match when={isPending()}>
          <text fg={colors.muted}>… </text>
        </Match>
        <Match when={isError()}>
          <text fg={colors.error}>{icons.cross} </text>
        </Match>
        <Match when={true}>
          <text fg={RGBA.fromHex("#98C379")}>{icons.checkmark} </text>
        </Match>
      </Switch>
      <text>{displayName}</text>
      <Show when={label()}>
        <text> </text>
        <text fg={RGBA.fromHex("#365A61")} underline>{label()}</text>
      </Show>
      <Show when={props.tool.error}>
        <text> </text>
        <text fg={colors.error}>({props.tool.error})</text>
      </Show>
    </box>
  )
}

export const SubAgentView: Component<SubAgentViewProps> = (props) => {
  const profileName = () => {
    const p = props.subAgent.profile
    return p.charAt(0).toUpperCase() + p.slice(1)
  }
  const isDone = () => props.subAgent.done
  const tokensUsed = () => props.subAgent.tokensUsed
  const tokenLimit = () => props.subAgent.tokenLimit
  const tokenPct = () => {
    if (tokenLimit() <= 0 || tokensUsed() <= 0) return ""
    const pct = Math.round((tokensUsed() / tokenLimit()) * 100)
    return ` (${pct}%)`
  }
  const hasTokens = () => tokensUsed() > 0
  const hasTextPreview = () => !isDone() && !!props.subAgent.textPreview
  const hasChildren = () => props.subAgent.tools.length > 0 || hasTextPreview()

  return (
    <box flexDirection="column">
      {/* Header: spinner/check + profile name + token usage */}
      <box flexDirection="row">
        <Switch>
          <Match when={!isDone()}>
            <InlineSpinner />
            <text> </text>
          </Match>
          <Match when={true}>
            <text fg={RGBA.fromHex("#98C379")}>{icons.checkmark} </text>
          </Match>
        </Switch>
        <text fg={colors.text}>{profileName()}</text>
        <Show when={hasTokens()}>
          <text fg={colors.muted}>  {formatTokens(tokensUsed())} tokens{tokenPct()}</text>
        </Show>
      </box>

      {/* Child tool list */}
      <Show when={hasChildren()}>
        <box flexDirection="column">
          <For each={props.subAgent.tools}>
            {(tool, i) => (
              <ChildToolLine
                tool={tool}
                isLast={!hasTextPreview() && i() === props.subAgent.tools.length - 1}
              />
            )}
          </For>
          {/* Streaming text preview */}
          <Show when={hasTextPreview()}>
            <box flexDirection="row">
              <text fg={colors.muted}>{icons.treeCorner} </text>
              <text fg={colors.muted} dimColor>{props.subAgent.textPreview}</text>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}
