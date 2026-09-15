import { For, createMemo } from "solid-js"
import { BoltIcon, ChevronIcon, ResetIcon } from "../icons"
import { KNOB_SIZE, thinkingFill, thinkingLabel } from "../thinking"
import type { AppStatus } from "../types"

interface ThinkingPopoverProps {
  status: AppStatus
  onSelect: (effort: string | null) => void
  onClose: () => void
}

export function ThinkingPopover(props: ThinkingPopoverProps) {
  const levels = () => props.status.thinkingLevels
  const last = createMemo(() => Math.max(1, levels().length - 1))
  const index = createMemo(() => Math.max(0, levels().indexOf(props.status.thinkingEffort)))

  return (
    <section class="thinking-popover" role="dialog" aria-label="Thinking effort">
      <header class="thinking-head">
        <span class="thinking-bolt" aria-hidden="true"><BoltIcon /></span>
        <span class="thinking-value">
          {thinkingLabel(props.status.thinkingEffort)}
          <ChevronIcon />
        </span>
        <button
          class="thinking-reset"
          type="button"
          title="Reset to the profile default"
          aria-label="Reset thinking effort"
          onClick={() => { props.onSelect(null); props.onClose() }}
        >
          <ResetIcon />
        </button>
      </header>

      <p class="thinking-model">{props.status.modelLabel}</p>

      <div class="thinking-slider" style={{ "--knob": `${KNOB_SIZE}px` }}>
        <div class="thinking-track" aria-hidden="true">
          <span style={{ width: thinkingFill(props.status) }} />
        </div>
        <div class="thinking-dots" aria-hidden="true">
          <For each={levels()}>{(level, position) => (
            <span
              classList={{ "thinking-dot": true, active: position() <= index() }}
              style={{ left: `${position() / last() * 100}%` }}
              title={thinkingLabel(level)}
            />
          )}</For>
        </div>
        <input
          type="range"
          min={0}
          max={last()}
          step={1}
          value={index()}
          aria-label="Thinking effort"
          aria-valuetext={thinkingLabel(props.status.thinkingEffort)}
          onInput={(event) => {
            const level = levels()[Number(event.currentTarget.value)]
            if (level) props.onSelect(level)
          }}
        />
      </div>
    </section>
  )
}
