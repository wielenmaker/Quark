import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Token, Tokens } from "marked"
import { CodeBlock } from "./CodeBlock"
import { alignStyle, codeLanguage, parseMarkdown, safeHref } from "../markdown"

type Generic = Tokens.Generic

function InlineTokens(props: { tokens?: Token[] }): JSX.Element {
  return <For each={props.tokens ?? []}>{(token) => <InlineToken token={token} />}</For>
}

function InlineToken(props: { token: Token }): JSX.Element {
  const token = props.token as Generic
  switch (token.type) {
    case "strong":
      return <strong><InlineTokens tokens={token.tokens} /></strong>
    case "em":
      return <em><InlineTokens tokens={token.tokens} /></em>
    case "del":
      return <del><InlineTokens tokens={token.tokens} /></del>
    case "codespan":
      return <code>{token.text}</code>
    case "br":
      return <br />
    case "link":
      return <Link token={token as Tokens.Link} />
    case "image":
      return <Image token={token as Tokens.Image} />
    case "html":
      return <Html text={token.text ?? ""} />
    default:
      return <>{token.text ?? ""}</>
  }
}

/** Raw HTML stays escaped, except for line breaks models emit inline. */
function Html(props: { text: string }): JSX.Element {
  return <Show when={/^<br\s*\/?>$/i.test(props.text.trim())} fallback={<>{props.text}</>}>
    <br />
  </Show>
}

function LinkText(props: { token: Tokens.Link }): JSX.Element {
  return (
    <Show when={props.token.tokens?.length} fallback={props.token.text}>
      <InlineTokens tokens={props.token.tokens} />
    </Show>
  )
}

/** Link text stays inline, but only safe hrefs become anchors. */
function Link(props: { token: Tokens.Link }): JSX.Element {
  const href = () => safeHref(props.token.href)
  return (
    <Show when={href()} fallback={<LinkText token={props.token} />}>
      <a href={href()!} target="_blank" rel="noopener noreferrer"><LinkText token={props.token} /></a>
    </Show>
  )
}

function Image(props: { token: Tokens.Image }): JSX.Element {
  const src = () => safeHref(props.token.href)
  return (
    <Show when={src()} fallback={<span>{props.token.text}</span>}>
      <img src={src()!} alt={props.token.text} loading="lazy" referrerpolicy="no-referrer" />
    </Show>
  )
}

function Heading(props: { depth: number; tokens?: Token[] }): JSX.Element {
  return (
    <Dynamic component={`h${Math.min(Math.max(props.depth, 1), 6)}`}>
      <InlineTokens tokens={props.tokens} />
    </Dynamic>
  )
}

function ListItem(props: { item: Tokens.ListItem }): JSX.Element {
  return (
    <li classList={{ "task-item": props.item.task }}>
      <Show when={props.item.task}>
        <input type="checkbox" checked={Boolean(props.item.checked)} disabled />
      </Show>
      <BlockTokens tokens={props.item.tokens} />
    </li>
  )
}

function Table(props: { token: Tokens.Table }): JSX.Element {
  const align = (index: number) => alignStyle(props.token.align?.[index])
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <For each={props.token.header}>{(cell, index) => (
              <th style={align(index())}><InlineTokens tokens={cell.tokens} /></th>
            )}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.token.rows}>{(row) => (
            <tr>
              <For each={row}>{(cell, index) => (
                <td style={align(index())}><InlineTokens tokens={cell.tokens} /></td>
              )}</For>
            </tr>
          )}</For>
        </tbody>
      </table>
    </div>
  )
}

function BlockToken(props: { token: Token }): JSX.Element {
  const token = props.token as Generic
  switch (token.type) {
    case "space":
    case "def":
      return null
    case "hr":
      return <hr />
    case "heading":
      return <Heading depth={(token as Tokens.Heading).depth} tokens={token.tokens} />
    case "paragraph":
      return <p><InlineTokens tokens={token.tokens} /></p>
    case "code":
      return <CodeBlock code={token.text ?? ""} lang={codeLanguage(props.token)} />
    case "blockquote":
      return <blockquote><BlockTokens tokens={token.tokens ?? []} /></blockquote>
    case "list":
      return <List token={token as Tokens.List} />
    case "table":
      return <Table token={token as Tokens.Table} />
    case "text":
      return <InlineTokens tokens={token.tokens} />
    case "html":
      return <>{token.text ?? ""}</>
    default:
      return <InlineTokens tokens={token.tokens} />
  }
}

function List(props: { token: Tokens.List }): JSX.Element {
  const ordered = () => props.token.ordered
  return (
    <Dynamic component={ordered() ? "ol" : "ul"} start={ordered() ? props.token.start || 1 : undefined}>
      <For each={props.token.items}>{(item) => <ListItem item={item} />}</For>
    </Dynamic>
  )
}

function BlockTokens(props: { tokens: Token[] }): JSX.Element {
  return <For each={props.tokens}>{(token) => <BlockToken token={token} />}</For>
}

/**
 * Reparse at most once per animation frame while a message streams, so long
 * answers do not re-tokenize on every incoming chunk.
 */
function useTokens(text: () => string, streaming: () => boolean): () => Token[] {
  const [tokens, setTokens] = createSignal<Token[]>(parseMarkdown(text()), { equals: false })
  let frame: number | undefined

  createEffect(() => {
    const streamingNow = streaming()
    void text()
    if (!streamingNow) {
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
        frame = undefined
      }
      setTokens(parseMarkdown(text()))
      return
    }
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      setTokens(parseMarkdown(text()))
    })
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return tokens
}

export function Markdown(props: { text: string; streaming?: boolean }) {
  const tokens = useTokens(() => props.text, () => Boolean(props.streaming))
  return <BlockTokens tokens={tokens()} />
}
