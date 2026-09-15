import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import { highlightCode } from "../highlight"
import { codeLabel } from "../markdown"
import { CheckIcon, CopyIcon } from "../icons"

/**
 * Fenced code block with a language label, collapse toggle, and copy button —
 * the same affordances the reference UI puts in its code block header.
 */
export function CodeBlock(props: { code: string; lang: string }) {
  const [copied, setCopied] = createSignal(false)
  const [collapsed, setCollapsed] = createSignal(false)
  const html = createMemo(() => highlightCode(props.code, props.lang))
  const lines = createMemo(() => props.code.split("\n").length)
  let timer: number | undefined

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.code)
    } catch {}
    setCopied(true)
    window.clearTimeout(timer)
    timer = window.setTimeout(() => setCopied(false), 1600)
  }

  onCleanup(() => window.clearTimeout(timer))

  return (
    <div class="code-block">
      <div class="code-head">
        <span class="code-lang">{codeLabel(props.lang)}</span>
        <div class="code-actions">
          <button class="code-action" type="button" onClick={() => setCollapsed((value) => !value)}>
            {collapsed() ? "Expand" : "Collapse"}
          </button>
          <button
            class="code-action"
            type="button"
            aria-label={copied() ? "Copied" : "Copy code"}
            onClick={copy}
          >
            <Show when={copied()} fallback={<CopyIcon />}><CheckIcon /></Show>
            <span>{copied() ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      <Show
        when={!collapsed()}
        fallback={<div class="code-collapsed">{lines()} hidden lines</div>}
      >
        <Show
          when={html()}
          fallback={<pre class="code-body hljs"><code>{props.code}</code></pre>}
        >
          <pre class="code-body hljs">
            <code class={`language-${props.lang}`} innerHTML={html()!} />
          </pre>
        </Show>
      </Show>
    </div>
  )
}
