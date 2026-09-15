import { For, Show, createSignal, onCleanup } from "solid-js"
import { Markdown } from "./Markdown"
import { SubAgentCard } from "./SubAgentCard"
import { ToolActivity } from "./ToolActivity"
import { groupMessageParts } from "../message-parts"
import { CopyIcon, CheckIcon } from "../icons"
import type { Message as MessageType, MessagePart } from "../types"

function Thinking(props: { part: Extract<MessagePart, { type: "thinking" }> }) {
  return (
    <details class="thinking">
      <summary>{props.part.done ? "Thought" : "Thinking…"}</summary>
      <p>{props.part.text}</p>
    </details>
  )
}

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: number | undefined

  const copy = async () => {
    try { await navigator.clipboard.writeText(props.text) } catch {}
    setCopied(true)
    window.clearTimeout(timer)
    timer = window.setTimeout(() => setCopied(false), 1600)
  }

  onCleanup(() => window.clearTimeout(timer))

  return (
    <div class="message-actions">
      <button
        class="message-action"
        type="button"
        aria-label={copied() ? "Copied" : "Copy message"}
        title={copied() ? "Copied" : "Copy"}
        onClick={copy}
      >
        <Show when={copied()} fallback={<CopyIcon />}><CheckIcon /></Show>
      </button>
    </div>
  )
}

export function Message(props: { message: MessageType }) {
  const userText = () => props.message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  const assistantText = () => props.message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n").trim()

  return (
    <article class={`message ${props.message.role}-message`} data-status={props.message.status}>
      <Show when={props.message.role === "user"} fallback={
        <>
          <For each={groupMessageParts(props.message.parts)}>{(item) => {
            if (item.type === "tools") return <ToolActivity parts={item.parts} />
            const part = item.part
            if (part.type === "text") return <Markdown text={part.text} streaming={props.message.streaming} />
            if (part.type === "thinking") return <Thinking part={part} />
            if (part.type === "tool") return <SubAgentCard part={part} />
            return null
          }}</For>
          <Show when={props.message.streaming && props.message.parts.length === 0}>
            <div class="working-row" aria-label="Quark is working"><span /><span /><span /></div>
          </Show>
          <Show when={!props.message.streaming && assistantText()}>
            <CopyButton text={assistantText()} />
          </Show>
        </>
      }><p>{userText()}</p></Show>
    </article>
  )
}
