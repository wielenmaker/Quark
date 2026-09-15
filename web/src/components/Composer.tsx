import { Portal } from "solid-js/web"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { ChevronIcon, SendIcon } from "../icons"
import { SlashPalette } from "./SlashPalette"
import { ThinkingPopover } from "./ThinkingPopover"
import { thinkingEnabled, thinkingTriggerLabel } from "../thinking"
import { filterSlashCommands, slashParts } from "../slash"
import type { AppStatus } from "../types"

interface ComposerProps {
  running: boolean
  tokensUsed: number
  status: AppStatus
  onSubmit: (text: string) => Promise<void>
  onCancel: () => Promise<void>
  onThinking: (effort: string | null) => void
}

export function Composer(props: ComposerProps) {
  const [text, setText] = createSignal("")
  const [index, setIndex] = createSignal(0)
  const [thinking, setThinking] = createSignal(false)
  const [anchor, setAnchor] = createSignal<{ right: number; bottom: number }>({ right: 0, bottom: 0 })
  let input: HTMLTextAreaElement | undefined
  let trigger: HTMLButtonElement | undefined
  let layer: HTMLDivElement | undefined

  const parts = createMemo(() => slashParts(text()))
  const menuOpen = createMemo(() => parts() !== null && !parts()!.hasArgs)
  const entries = createMemo(() => menuOpen() ? filterSlashCommands(parts()!.id) : [])
  const percent = createMemo(() => props.status.tokenLimit
    ? Math.min(100, Math.round(props.tokensUsed / props.status.tokenLimit * 1_000) / 10)
    : 0)

  createEffect(() => {
    parts()?.id
    setIndex(0)
  })

  // The composer clips its own corners, so the popover is portalled and
  // positioned against the trigger's viewport rect.
  const measure = () => {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    setAnchor({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 10 })
  }

  const outside = (event: MouseEvent) => {
    const target = event.target as Node
    if (layer?.contains(target) || trigger?.contains(target)) return
    setThinking(false)
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") setThinking(false)
  }
  onMount(() => {
    document.addEventListener("mousedown", outside)
    document.addEventListener("keydown", escape)
  })
  onCleanup(() => {
    document.removeEventListener("mousedown", outside)
    document.removeEventListener("keydown", escape)
  })

  // The popover is only meaningful for models that expose reasoning levels.
  createEffect(() => {
    if (!thinkingEnabled(props.status)) setThinking(false)
  })

  createEffect(() => {
    if (!thinking()) return
    measure()
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    onCleanup(() => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    })
  })

  const resize = () => {
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }

  const reset = () => {
    setText("")
    queueMicrotask(resize)
  }

  const submit = async () => {
    if (props.running) return props.onCancel()
    const value = text().trim()
    if (!value) return
    reset()
    await props.onSubmit(value)
  }

  const keydown = (event: KeyboardEvent) => {
    if (!menuOpen()) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void submit()
      }
      return
    }

    const list = entries()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setIndex((value) => list.length ? (value + 1) % list.length : 0)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setIndex((value) => list.length ? (value - 1 + list.length) % list.length : 0)
    } else if (event.key === "Escape") {
      event.preventDefault()
      reset()
    } else if (event.key === "Enter" || event.key === "Tab") {
      const command = list[Math.min(index(), list.length - 1)]
      if (!command) return
      event.preventDefault()
      // Commands that take arguments stay in the composer so they can be typed.
      if (command.usage) setText(`/${command.id} `)
      else reset()
      queueMicrotask(() => { input?.focus(); resize() })
      if (!command.usage) void props.onSubmit(`/${command.id}`)
    }
  }

  return (
    <form classList={{ composer: true, running: props.running }} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <Show when={menuOpen()}>
        <SlashPalette
          entries={entries()}
          index={index()}
          onHover={setIndex}
          onRun={(command) => {
            if (command.usage) {
              setText(`/${command.id} `)
              queueMicrotask(() => { input?.focus(); resize() })
              return
            }
            reset()
            void props.onSubmit(`/${command.id}`)
          }}
        />
      </Show>
      <textarea
        ref={input}
        rows="1"
        aria-label="Message Quark"
        placeholder={props.running ? "Quark is working…" : "Ask Quark to build, inspect, or explain…"}
        disabled={props.running}
        value={text()}
        onInput={(event) => { setText(event.currentTarget.value); resize() }}
        onKeyDown={keydown}
      />
      <div class="composer-actions">
        <div class="input-tools">
          <div class="context-status" title="Context window used">
            <span class="context-ring" aria-hidden="true" style={{ background: `conic-gradient(var(--green) 0 ${percent()}%, var(--line) ${percent()}%)` }}><span /></span>
            <strong>{percent()}%</strong>
          </div>
        </div>
        <div class="composer-controls">
          <div class="model-info" title={props.status.modelName}>
            <span>{props.status.modelLabel}</span>
          </div>
          <div class="thinking-anchor">
            <Show when={thinking()}>
              <Portal>
                <div class="thinking-layer" ref={layer} style={{ right: `${anchor().right}px`, bottom: `${anchor().bottom}px` }}>
                  <ThinkingPopover
                    status={props.status}
                    onSelect={props.onThinking}
                    onClose={() => setThinking(false)}
                  />
                </div>
              </Portal>
            </Show>
            <button
              ref={trigger}
              class="thinking-trigger"
              type="button"
              disabled={!thinkingEnabled(props.status)}
              aria-haspopup="dialog"
              aria-expanded={thinking()}
              title={thinkingEnabled(props.status) ? "Thinking effort" : "This model does not support thinking"}
              onClick={() => setThinking((open) => !open)}
            >
              <span>{thinkingTriggerLabel(props.status)}</span>
              <ChevronIcon />
            </button>
          </div>
          <button class="send-button" type="submit" aria-label={props.running ? "Stop response" : "Send message"}>
            <SendIcon />
            <span class="stop-icon" aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  )
}
