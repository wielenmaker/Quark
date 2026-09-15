import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { ChevronIcon } from "../icons"
import { formatTokens, tokenPercentage } from "../subagent-view"
import type { MessagePart, SubAgentState } from "../types"
import { ToolRow } from "./ToolActivity"

type ToolPart = Extract<MessagePart, { type: "tool" }>

function formatSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1_000))}s`
}

function fallbackState(part: ToolPart): SubAgentState {
  return {
    profile: typeof part.input.profile === "string" ? part.input.profile : "sub-agent",
    prompt: typeof part.input.prompt === "string" ? part.input.prompt : undefined,
    tools: [],
    tokensUsed: 0,
    tokenLimit: 0,
    done: part.status === "completed" || part.status === "error",
  }
}

export function SubAgentCard(props: { part: ToolPart; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false)
  const [liveMs, setLiveMs] = createSignal(0)
  const subAgent = createMemo(() => props.part.subAgent ?? fallbackState(props.part))

  createEffect(() => {
    if (subAgent().done) setExpanded(false)
  })

  createEffect(() => {
    const state = subAgent()
    if (state.done || state.startedAt == null) {
      setLiveMs(0)
      return
    }
    const tick = () => setLiveMs(Date.now() - state.startedAt!)
    tick()
    const timer = window.setInterval(tick, 1_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const profileName = () => {
    const profile = subAgent().profile
    return profile.charAt(0).toUpperCase() + profile.slice(1)
  }
  const isError = () => props.part.status === "error" || !!subAgent().error
  const isDone = () => subAgent().done || props.part.status === "completed"
  const hasDetails = () => !!subAgent().prompt || subAgent().tools.length > 0 || !!subAgent().textPreview || !!subAgent().error
  const percentage = () => tokenPercentage(subAgent().tokensUsed, subAgent().tokenLimit)
  const percentageLabel = () => {
    if (subAgent().tokensUsed <= 0) return "0%"
    return percentage() < 1 ? `${percentage().toFixed(1)}%` : `${Math.round(percentage())}%`
  }
  const tokenLabel = () => {
    const limit = subAgent().tokenLimit > 0 ? ` / ${formatTokens(subAgent().tokenLimit)}` : ""
    return `${formatTokens(subAgent().tokensUsed)}${limit} tokens (${percentageLabel()})`
  }
  const duration = () => {
    const ms = subAgent().durationMs ?? (!isDone() && !isError() ? liveMs() : 0)
    return ms > 0 ? ` (${formatSeconds(ms)})` : ""
  }
  const header = () => isError()
    ? `${profileName()} failed`
    : isDone() ? `${profileName()} responded` : `Summoning ${profileName()}`
  const detailsId = () => `subagent-${props.part.callId.replace(/[^a-zA-Z0-9_-]/g, "-")}`

  return (
    <section classList={{ "subagent-card": true, error: isError(), done: isDone(), running: !isDone() && !isError() }}>
      <button
        class="subagent-header"
        type="button"
        aria-expanded={hasDetails() ? expanded() : undefined}
        aria-controls={hasDetails() ? detailsId() : undefined}
        disabled={!hasDetails()}
        onClick={() => hasDetails() && setExpanded((value) => !value)}
      >
        <span class="subagent-status" aria-hidden="true" />
        <span class="subagent-title">{header()}{duration()}</span>
        <span class="subagent-model">{subAgent().modelName ?? profileName()}</span>
        <Show when={hasDetails()}><ChevronIcon class="subagent-chevron" /></Show>
      </button>

      <div class="subagent-meter-row" aria-label={tokenLabel()}>
        <span class="subagent-meter" aria-hidden="true">
          <span style={{ width: `${percentage()}%` }} />
        </span>
        <span class="subagent-token-label">{tokenLabel()}</span>
      </div>

      <Show when={hasDetails() && expanded()}>
        <div class="subagent-details" id={detailsId()}>
          <Show when={subAgent().prompt}>
            <p class="subagent-task">Task: “{subAgent().prompt}”</p>
          </Show>
          <Show when={subAgent().tools.length}>
            <div class="subagent-tools">
              <For each={subAgent().tools}>{(tool) => <ToolRow part={tool} />}</For>
            </div>
          </Show>
          <Show when={!isDone() && subAgent().textPreview}>
            <p class="subagent-thinking"><span aria-hidden="true" />Thinking…</p>
          </Show>
          <Show when={subAgent().error}>
            <p class="subagent-error">{subAgent().error!.kind}: {subAgent().error!.message}</p>
          </Show>
        </div>
      </Show>
    </section>
  )
}
