// @jsxImportSource @opentui/solid
// AssistantMessage — renders assistant text as formatted markdown
//
// Uses OpenTUI's MarkdownRenderable with concealment so headings, inline
// delimiters, links, and code fences render without their source markers while
// list/quote markers stay visible. Tables render as structured TextTables.
//
// IMPORTANT: In SolidJS, the component body runs ONCE. Never do early returns
// based on reactive props — use <Show> instead, so the rendering path stays
// reactive and re-evaluates when props change.

import type { Component } from "solid-js"
import { Show } from "solid-js"
import { syntaxStyle } from "../syntax-theme"

const DEBUG_LOG = Bun.env.QUARK_MD_DEBUG === "1"
const DEBUG_LOG_PATH = "/tmp/quark-md-debug.log"

function logDebug(label: string, text: string) {
  const timestamp = new Date().toISOString()
  const separator = "═".repeat(80)
  const entry = `\n${separator}\n${timestamp} [${label}]\n${separator}\n${text}\n${separator}\n`
  // Use synchronous append via shell to avoid async issues in reactive context
  try {
    Bun.spawnSync({
      cmd: ["sh", "-c", `printf '%s' ${JSON.stringify(entry)} >> ${DEBUG_LOG_PATH}`],
      stdout: "ignore",
      stderr: "ignore",
    })
  } catch {
    // silently ignore write errors
  }
}

interface AssistantMessageProps {
  text: string
  streaming?: boolean
}

/**
 * Prepares markdown content for rendering. Called as a reactive expression so
 * it fires on every text change (streaming deltas).
 */
function prepareContent(text: string): string {
  if (DEBUG_LOG) {
    logDebug("MARKDOWN (sent to <markdown>)", text)
  }
  return text
}

export const AssistantMessage: Component<AssistantMessageProps> = (props) => {
  return (
    <Show when={props.text}>
      <box flexDirection="column" width="100%">
        <markdown
          content={prepareContent(props.text)}
          syntaxStyle={syntaxStyle}
          conceal={true}
          streaming={props.streaming ?? false}
          width="100%"
        />
      </box>
    </Show>
  )
}
