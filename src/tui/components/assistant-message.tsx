// @jsxImportSource @opentui/solid
// AssistantMessage — renders assistant text with markdown
//
// Uses OpenTUI's dedicated <markdown> renderable for proper markdown rendering
// with concealment of syntax markers, streaming support, and syntax highlighting
// for code blocks via TreeSitter (js, ts, markdown, zig).
//
// IMPORTANT: In SolidJS, the component body runs ONCE. Never do early returns
// based on reactive props — use <Show> instead, so the rendering path stays
// reactive and re-evaluates when props change.

import { SyntaxStyle } from "@opentui/core"
import type { Component } from "solid-js"
import { Show } from "solid-js"
import { getTreeSitter } from "../tree-sitter"

interface AssistantMessageProps {
  text: string
  streaming?: boolean
}

const syntaxStyle = SyntaxStyle.create()

export const AssistantMessage: Component<AssistantMessageProps> = (props) => {
  return (
    <Show when={props.text}>
      <box flexDirection="column" width="100%">
        <markdown
          content={props.text}
          syntaxStyle={syntaxStyle}
          conceal={true}
          streaming={props.streaming ?? false}
          treeSitterClient={getTreeSitter()}
        />
      </box>
    </Show>
  )
}
