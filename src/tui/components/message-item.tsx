// @jsxImportSource @opentui/solid
// MessageItem — renders a single message (user or assistant) with all its parts
//
// Dispatches to the appropriate sub-component based on part type:
// - text → AssistantMessage (or UserMessage for user role)
// - tool → ToolResultView (completed/error) or ToolInvocationBlock (running)
// - thinking → ThinkingIndicator

import type { Component } from "solid-js"
import { Show, Switch, Match, For } from "solid-js"
import { RGBA } from "@opentui/core"
import { UserMessage } from "./user-message"
import { AssistantMessage } from "./assistant-message"
import { ToolResultView } from "./tool-result"
import { ToolInvocationBlock } from "./tool-invocation"
import { ThinkingIndicator } from "./thinking"
import { SubAgentView } from "./sub-agent-view"
import { InlineSpinner } from "./inline-spinner"
import { colors } from "../theme"
import type { TuiMessage, TuiPart } from "../state"

interface MessageItemProps {
  message: TuiMessage
}

// Extract a description for tool invocation display
function getToolDescription(tool: string, input: Record<string, unknown>): string {
  if (tool === "bash") {
    const cmd = input.command ?? input.cmd
    if (typeof cmd === "string") return cmd
  }

  if (tool === "skill") {
    const desc = input.description
    if (typeof desc === "string") return desc
  }

  return JSON.stringify(input, null, 2)
}

const PartView: Component<{ part: TuiPart; isStreaming: boolean }> = (props) => {
  // Helper to cast tool parts
  const asTool = () => props.part as Extract<TuiPart, { type: "tool" }>

  return (
    <Switch>
      <Match when={props.part.type === "text" && props.part}>
        {(part) => (
          <box marginBottom={1}>
            <AssistantMessage
              text={(part() as Extract<TuiPart, { type: "text" }>).text}
              streaming={(part() as Extract<TuiPart, { type: "text" }>).streaming}
            />
          </box>
        )}
      </Match>

      <Match when={props.part.type === "tool" && (props.part as Extract<TuiPart, { type: "tool" }>).status === "running" && (props.part as Extract<TuiPart, { type: "tool" }>).tool === "skill"}>
        <box marginBottom={1}>
          <ToolInvocationBlock
            tool={asTool().tool}
            description={getToolDescription(asTool().tool, asTool().input)}
          />
        </box>
      </Match>

      {/* Sub-agent: bash tool with subAgent state (running or completed) */}
      <Match when={props.part.type === "tool" && asTool().subAgent}>
        <box marginBottom={1} flexDirection="column">
          {/* Use ToolResultView for consistent rendering with all other tools */}
          <ToolResultView
            tool={asTool().tool}
            input={asTool().input}
            status={asTool().status}
            output={asTool().output}
            error={asTool().error}
            diff={asTool().diff}
            streamingContent={asTool().streamingContent}
            inputPreview={asTool().inputPreview}
          />
          {/* Nested sub-agent view with tree connector */}
          <box flexDirection="row">
            <text fg={colors.muted}>└─ </text>
            <box flexDirection="column" flexGrow={1}>
              <SubAgentView subAgent={asTool().subAgent!} parentStatus={asTool().status} />
            </box>
          </box>
        </box>
      </Match>

      {/* Regular bash tool (running, no sub-agent) */}
      <Match when={props.part.type === "tool" && asTool().status === "running" && asTool().tool === "bash"}>
        <box marginBottom={1}>
          <ToolInvocationBlock
            tool={asTool().tool}
            description={getToolDescription(asTool().tool, asTool().input)}
          />
        </box>
      </Match>

      <Match when={props.part.type === "tool"}>
        <box marginBottom={1}>
          <ToolResultView
            tool={asTool().tool}
            input={asTool().input}
            status={asTool().status}
            output={asTool().output}
            error={asTool().error}
            diff={asTool().diff}
            streamingContent={asTool().streamingContent}
            inputPreview={asTool().inputPreview}
          />
        </box>
      </Match>

      <Match when={props.part.type === "thinking"}>
        <box marginBottom={1}>
          <ThinkingIndicator
            done={(props.part as Extract<TuiPart, { type: "thinking" }>).done}
            text={(props.part as Extract<TuiPart, { type: "thinking" }>).text}
          />
        </box>
      </Match>
    </Switch>
  )
}

export const MessageItem: Component<MessageItemProps> = (props) => {
  return (
    <Show
      when={props.message.role === "assistant"}
      fallback={
        // User messages: text + optional image parts
        <Show when={props.message.parts.find((p) => p.type === "text") as Extract<TuiPart, { type: "text" }> | undefined}>
          {(textPart) => {
            const images = () => props.message.parts
              .filter((p): p is Extract<TuiPart, { type: "image" }> => p.type === "image")
              .map((p) => ({ label: p.label }))
            return (
              <box marginBottom={1}>
                <UserMessage text={textPart().text} images={images()} />
              </box>
            )
          }}
        </Show>
      }
    >
      {/* Assistant message — render all parts */}
      <box flexDirection="column" width="100%">
        <For each={props.message.parts}>
          {(part) => (
            <PartView part={part} isStreaming={!!props.message.streaming} />
          )}
        </For>
      </box>
    </Show>
  )
}
