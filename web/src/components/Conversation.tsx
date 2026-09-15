import { For, Show, createEffect } from "solid-js"
import { Message } from "./Message"
import type { Message as MessageType } from "../types"

export function Conversation(props: { messages: MessageType[] }) {
  let viewport: HTMLElement | undefined

  createEffect(() => {
    const last = props.messages[props.messages.length - 1]
    const part = last?.parts[last.parts.length - 1]
    if (part?.type === "text" || part?.type === "thinking") part.text.length
    if (part?.type === "tool") `${part.status}:${part.output?.length ?? 0}`
    queueMicrotask(() => {
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
  })

  return (
    <main class="conversation" classList={{ empty: !props.messages.length }} ref={viewport}>
      <div class="conversation-inner">
        <Show when={props.messages.length} fallback={
          <div class="empty-state"><h1>What should we work on?</h1></div>
        }>
          <div class="day-divider"><span>Today</span></div>
          <For each={props.messages}>{(message) => <Message message={message} />}</For>
        </Show>
      </div>
    </main>
  )
}
