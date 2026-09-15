import { For, Show } from "solid-js"
import type { SlashCommand } from "../slash"

interface SlashPaletteProps {
  entries: SlashCommand[]
  index: number
  onHover: (index: number) => void
  onRun: (command: SlashCommand) => void
}

export function SlashPalette(props: SlashPaletteProps) {
  return (
    <section class="slash-palette" role="listbox" aria-label="Slash commands">
      <div class="slash-head"><span>Commands</span><kbd>/</kbd></div>
      <div class="slash-list">
        <For each={props.entries} fallback={<p class="slash-empty">No matching command</p>}>
          {(command, position) => (
            <button
              type="button"
              role="option"
              aria-selected={position() === props.index}
              classList={{ "slash-item": true, active: position() === props.index }}
              onMouseMove={() => props.onHover(position())}
              onClick={() => props.onRun(command)}
            >
              <span class="slash-name">/{command.id}</span>
              <Show when={command.usage}><span class="slash-usage">{command.usage}</span></Show>
              <span class="slash-detail">{command.description}</span>
            </button>
          )}
        </For>
      </div>
      <div class="slash-foot"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Run</span><span><kbd>esc</kbd> Dismiss</span></div>
    </section>
  )
}
