import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { SearchIcon } from "../icons"

export interface PaletteEntry {
  id: string
  icon: string
  label: string
  detail: string
  shortcut?: string
  run: () => void
}

interface CommandPaletteProps {
  title: string
  placeholder: string
  entries: PaletteEntry[]
  onClose: () => void
}

/** The model catalogue alone holds thousands of entries, so cap what we render. */
const RENDER_LIMIT = 60

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("")
  const [index, setIndex] = createSignal(0)
  let input: HTMLInputElement | undefined

  const matches = createMemo(() => {
    const needle = query().toLowerCase()
    return props.entries.filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(needle))
  })
  const filtered = createMemo(() => matches().slice(0, RENDER_LIMIT))
  const truncated = createMemo(() => matches().length - filtered().length)

  createEffect(() => {
    query()
    setIndex(0)
  })

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return props.onClose()
    entry.run()
    props.onClose()
  }

  const keydown = (event: KeyboardEvent) => {
    const list = filtered()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setIndex((value) => list.length ? (value + 1) % list.length : 0)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setIndex((value) => list.length ? (value - 1 + list.length) % list.length : 0)
    } else if (event.key === "Escape") {
      props.onClose()
    } else if (event.key === "Enter") {
      event.preventDefault()
      run(list[Math.min(index(), list.length - 1)])
    }
  }

  onMount(() => document.addEventListener("keydown", keydown))
  onCleanup(() => document.removeEventListener("keydown", keydown))
  createEffect(() => { props.title; queueMicrotask(() => input?.focus()) })

  return (
    <div class="palette-backdrop" onClick={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <section class="command-palette" role="dialog" aria-modal="true" aria-labelledby="palette-title">
        <div class="palette-search">
          <SearchIcon />
          <input
            ref={input}
            aria-label={props.placeholder}
            placeholder={props.placeholder}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <kbd>esc</kbd>
        </div>
        <h2 id="palette-title">
          {props.title}
          <Show when={truncated() > 0}><span class="palette-count">{filtered().length} of {matches().length}</span></Show>
        </h2>
        <div class="palette-list">
          <For each={filtered()} fallback={<p class="palette-empty">No matching entries</p>}>
            {(entry, position) => (
              <button
                type="button"
                classList={{ active: position() === index() }}
                onMouseMove={() => setIndex(position())}
                onClick={() => run(entry)}
              >
                <span class="palette-icon">{entry.icon}</span>
                <span><strong>{entry.label}</strong><small>{entry.detail}</small></span>
                <Show when={entry.shortcut}><kbd>{entry.shortcut}</kbd></Show>
              </button>
            )}
          </For>
        </div>
        <div class="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span></div>
      </section>
    </div>
  )
}
