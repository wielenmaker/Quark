// @jsxImportSource @opentui/solid

import type { Component } from "solid-js"
import { For, Show } from "solid-js"
import type { ShipPhaseSnapshot, ShipUpdate } from "../../session/events"
import { colors } from "../theme"
import { InlineSpinner } from "./inline-spinner"

const labels: Record<ShipPhaseSnapshot["id"], string> = {
  preflight: "Preflight",
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  publish: "Publish",
}

function duration(ms?: number): string {
  if (ms == null) return ""
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function icon(phase: ShipPhaseSnapshot): string {
  if (phase.status === "pass") return "✓"
  if (phase.status === "fail") return "✗"
  if (phase.status === "running") return ""
  return "○"
}

function phaseColor(phase: ShipPhaseSnapshot) {
  if (phase.status === "pass") return colors.success
  if (phase.status === "fail") return colors.error
  if (phase.status === "running") return colors.primary
  return colors.muted
}

export const ShipView: Component<{ run: ShipUpdate }> = (props) => (
  <box
    flexDirection="column"
    borderStyle="rounded"
    borderColor={props.run.status === "failed" ? colors.error : props.run.status === "passed" ? colors.success : colors.borderActive}
    paddingX={1}
    marginBottom={1}
  >
    <text fg={colors.textBold}>Ship · {props.run.request}</text>
    <Show when={props.run.branch}>
      <text fg={colors.textDim}>Branch: {props.run.branch}</text>
    </Show>
    <Show when={props.run.worktreePath}>
      <text fg={colors.textDim}>Worktree: {props.run.worktreePath}</text>
    </Show>

    <For each={props.run.phases}>
      {(phase) => (
        <box flexDirection="row">
          <Show when={phase.status === "running"} fallback={<text fg={phaseColor(phase)}>{icon(phase)} </text>}>
            <InlineSpinner />
          </Show>
          <text fg={phaseColor(phase)}>
            {labels[phase.id]}
            {phase.agent ? ` · ${phase.agent}` : ""}
            {phase.id === "implement" || phase.id === "verify"
              ? ` · attempt ${props.run.attempt}/${props.run.maxAttempts}`
              : ""}
            {phase.durationMs != null ? ` · ${duration(phase.durationMs)}` : ""}
            {phase.sessionId ? ` · ${phase.sessionId}` : ""}
          </text>
        </box>
      )}
    </For>

    <Show when={props.run.reason}>
      <text fg={props.run.status === "failed" ? colors.error : colors.warning} wrap="wrap">
        {props.run.reason}
      </text>
    </Show>
    <Show when={props.run.prUrl}>
      <text fg={colors.success}>PR: {props.run.prUrl}</text>
    </Show>
  </box>
)
