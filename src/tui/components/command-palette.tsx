// @jsxImportSource @opentui/solid

import type { Component } from "solid-js"
import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { colors } from "../theme"
import type { PaletteEntry } from "../palette-index"
import type { SessionTreeRow } from "../session-tree-picker"
import { sessionControls, type SessionAction } from "../session-controls"
import type { ConnectProviderRow } from "../connect-provider"
import type { WorktreePickerRow } from "../worktree-picker"

const MAX_VISIBLE = 5
const MAX_VISIBLE_SESSIONS = 8

export type PaletteMode =
  | "search"
  | "sessions"
  | "skills"
  | "models"
  | "worktrees"
  | "worktree-create"
  | "connect-providers"
  | "connect-api-key"
  | "connect-codex-method"
  | "connect-authorizing"
  | "connect-result"

export interface ConnectPaletteView {
  providers: ConnectProviderRow[]
  providerName?: string
  environmentCredentialActive?: boolean
  apiKeyLength?: number
  codexMethod?: "browser" | "device"
  deviceCode?: { verificationUri: string; userCode: string }
  browserUrl?: string
  awaitingBrowserInput?: boolean
  result?: { kind: "success" | "info" | "error"; message: string }
}

export interface SessionActionMenu {
  query: string
  actions: { id: "pin" | "rename"; label: string }[]
  selectedIndex: number
  onInput: () => void
  onRef?: (ref: TextareaRenderable) => void
}

export interface CommandPaletteProps {
  active: boolean
  query: string
  entries: PaletteEntry[]
  selectedIndex: number
  onInput: () => void
  onRef?: (ref: TextareaRenderable) => void
  mode?: PaletteMode
  sessionRows?: SessionTreeRow[]
  sessionAction?: SessionAction
  sessionActionMenu?: SessionActionMenu
  worktreeRows?: WorktreePickerRow[]
  worktreeError?: string
  connect?: ConnectPaletteView
}

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const dims = useTerminalDimensions()
  const sessionMode = () => props.mode === "sessions"
  const worktreeMode = () => props.mode === "worktrees"
  const worktreeCreateMode = () => props.mode === "worktree-create"
  const entityMode = () => props.mode === "skills" || props.mode === "models" || props.mode === "connect-providers"
  const connectMode = () => props.mode?.startsWith("connect-") && props.mode !== "connect-providers"
  const sessionActionMenuOpen = () => Boolean(props.sessionActionMenu)
  const width = () => Math.min(60, Math.max(12, dims().width - 4))
  const left = () => Math.max(0, Math.floor((dims().width - width()) / 2))
  const maxVisibleSessions = () => Math.max(1, Math.min(MAX_VISIBLE_SESSIONS, dims().height - 8))
  const visible = () => {
    const entries = props.entries
    if (entries.length <= MAX_VISIBLE) return entries
    const start = Math.min(Math.max(0, props.selectedIndex - MAX_VISIBLE + 1), entries.length - MAX_VISIBLE)
    return entries.slice(start, start + MAX_VISIBLE)
  }
  const visibleStart = () => props.entries.length <= MAX_VISIBLE ? 0 : Math.min(Math.max(0, props.selectedIndex - MAX_VISIBLE + 1), props.entries.length - MAX_VISIBLE)
  const visibleSessions = () => {
    const rows = props.sessionRows ?? []
    const maximum = maxVisibleSessions()
    if (rows.length <= maximum) return rows
    const start = Math.min(Math.max(0, props.selectedIndex - maximum + 1), rows.length - maximum)
    return rows.slice(start, start + maximum)
  }
  const visibleSessionStart = () => {
    const rows = props.sessionRows ?? []
    const maximum = maxVisibleSessions()
    return rows.length <= maximum ? 0 : Math.min(Math.max(0, props.selectedIndex - maximum + 1), rows.length - maximum)
  }
  const visibleWorktrees = () => {
    const rows = props.worktreeRows ?? []
    if (rows.length <= MAX_VISIBLE) return rows
    const start = Math.min(Math.max(0, props.selectedIndex - MAX_VISIBLE + 1), rows.length - MAX_VISIBLE)
    return rows.slice(start, start + MAX_VISIBLE)
  }
  const visibleWorktreeStart = () => {
    const rows = props.worktreeRows ?? []
    return rows.length <= MAX_VISIBLE ? 0 : Math.min(Math.max(0, props.selectedIndex - MAX_VISIBLE + 1), rows.length - MAX_VISIBLE)
  }
  const hasQuery = () => entityMode() || worktreeMode() || Boolean(props.query.trim())
  const rows = () => worktreeMode()
    ? Math.max(1, visibleWorktrees().length)
    : hasQuery() && props.entries.length === 0 ? 1 : visible().length
  const sessionRowCount = () => Math.max(1, visibleSessions().length)
  const connectHeight = () => {
    // Every connect view has a title and divider, its content, a footer, and the
    // palette's two border rows. Keep this in the same sizing contract as the
    // standard palette modes so the footer stays inside the frame.
    if (props.mode === "connect-api-key") return 8
    if (props.mode === "connect-codex-method") return 7
    if (props.mode === "connect-authorizing") {
      return 6 + (props.connect?.browserUrl ? 1 : 0) + (props.connect?.deviceCode ? 2 : 0) + (props.connect?.awaitingBrowserInput ? 1 : 0)
    }
    return 6
  }
  const height = () => connectMode()
    ? connectHeight()
    : worktreeCreateMode()
      ? props.worktreeError ? 9 : 8
        : sessionMode()
          ? sessionRowCount() + 6
        : hasQuery() ? 4 + MAX_VISIBLE + (entityMode() || worktreeMode() ? 1 : 0) : 3
  const top = () => Math.max(0, Math.floor((dims().height - 6 - height()) / 2))
  const actionMenuWidth = () => Math.min(36, Math.max(20, dims().width - 6))
  const actionMenuHeight = () => (props.sessionActionMenu?.actions.length ?? 0) + 5
  const actionMenuLeft = () => Math.max(0, left() + width() - actionMenuWidth() - 2)
  const actionMenuTop = () => Math.max(0, top() + height() - actionMenuHeight() - 1)
  const truncate = (value: string, maximum: number) => {
    const chars = Array.from(value)
    if (chars.length <= maximum) return value
    return maximum <= 1 ? "…" : `${chars.slice(0, maximum - 1).join("")}…`
  }
  const footer = () => props.mode === "connect-api-key"
      ? "Enter connect · Esc back"
      : props.mode === "connect-codex-method"
        ? "↑↓ select · Enter continue · Esc back"
        : props.mode === "connect-authorizing" ? "Esc cancel" : "Enter close · Esc close"

  return (
    <Show when={props.active}>
      <>
      <box position="absolute" left={left()} top={top()} width={width()} height={height()} flexDirection="column" borderStyle="rounded" borderColor={colors.outline} backgroundColor={colors.commandCardBg} opacity={sessionActionMenuOpen() ? 0.45 : 1}>
        <Show when={connectMode()}>
          <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}>
            <text fg={colors.text} bg={colors.commandCardBg} bold>
              {props.mode === "connect-result" ? props.connect?.result?.message : `Connect ${props.connect?.providerName ?? "provider"}`}
            </text>
          </box>
          <box height={1} backgroundColor={colors.commandCardBg}><text fg={colors.outline} bg={colors.commandCardBg}>{"─".repeat(Math.max(0, width() - 2))}</text></box>
          <Show when={props.mode === "connect-api-key"}>
            <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>API key</text></box>
            <box height={1} paddingX={1} flexDirection="row" backgroundColor={colors.commandCardBg}>
              <text fg={colors.statusModel} bg={colors.commandCardBg}>{"> "}</text>
              <text fg={colors.text} bg={colors.commandCardBg}>{"•".repeat(props.connect?.apiKeyLength ?? 0)}</text>
              <textarea ref={(ref: TextareaRenderable) => props.onRef?.(ref)} focused width={1} height={1} opacity={0} value={props.query} showCursor={false} textColor={colors.commandCardBg} focusedTextColor={colors.commandCardBg} backgroundColor={colors.commandCardBg} focusedBackgroundColor={colors.commandCardBg} onContentChange={() => props.onInput()} />
            </box>
            <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>{props.connect?.environmentCredentialActive ? "Environment credential remains active after saving" : "Saved using Quark's configured credential store"}</text></box>
          </Show>
          <Show when={props.mode === "connect-codex-method"}>
            <For each={["Browser login", "Device code login"]}>{(method, index) => <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={index() === props.selectedIndex ? colors.statusModel : colors.text} bg={colors.commandCardBg} bold={index() === props.selectedIndex}>{index() === props.selectedIndex ? "❯ " : "  "}{method}</text></box>}</For>
          </Show>
          <Show when={props.mode === "connect-authorizing"}>
            <Show when={props.connect?.browserUrl}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.text} bg={colors.commandCardBg}>Open: {truncate(props.connect?.browserUrl ?? "", width() - 9)}</text></box></Show>
            <Show when={props.connect?.deviceCode}><box height={2} paddingX={1} flexDirection="column" backgroundColor={colors.commandCardBg}><text fg={colors.text} bg={colors.commandCardBg}>Open: {truncate(props.connect?.deviceCode?.verificationUri ?? "", width() - 9)}</text><text fg={colors.text} bg={colors.commandCardBg}>Enter code: {props.connect?.deviceCode?.userCode}</text></box></Show>
            <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>{props.connect?.awaitingBrowserInput ? "Paste an authorization code or redirect URL (optional)" : "Waiting for authorization…"}</text></box>
            <Show when={props.connect?.awaitingBrowserInput}><box height={1} paddingX={1} flexDirection="row" backgroundColor={colors.commandCardBg}><text fg={colors.statusModel} bg={colors.commandCardBg}>{"> "}</text><textarea ref={(ref: TextareaRenderable) => props.onRef?.(ref)} focused height={1} flexGrow={1} value={props.query} textColor={colors.text} focusedTextColor={colors.text} cursorColor={colors.cursorColor} onContentChange={() => props.onInput()} /></box></Show>
          </Show>
          <Show when={props.mode === "connect-result"}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={props.connect?.result?.kind === "error" ? colors.error : props.connect?.result?.kind === "info" ? colors.info : colors.success} bg={colors.commandCardBg}>{props.connect?.result?.kind === "error" ? "Authentication was not completed" : props.connect?.result?.kind === "info" ? "Update the environment variable outside Quark" : "Authentication is ready"}</text></box></Show>
          <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>{footer()}</text></box>
        </Show>

        <Show when={!connectMode()}>
          <Show when={worktreeCreateMode()}>
            <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.text} bg={colors.commandCardBg} bold>Create worktree</text></box>
            <box height={1} backgroundColor={colors.commandCardBg}><text fg={colors.outline} bg={colors.commandCardBg}>{"─".repeat(Math.max(0, width() - 2))}</text></box>
            <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>Branch name</text></box>
            <box height={1} paddingX={1} flexDirection="row" backgroundColor={colors.commandCardBg}><text fg={colors.statusModel} bg={colors.commandCardBg}>{"> "}</text><textarea ref={(ref: TextareaRenderable) => props.onRef?.(ref)} focused height={1} flexGrow={1} value={props.query} placeholder="feature/my-branch" placeholderColor={colors.muted} textColor={colors.text} focusedTextColor={colors.text} cursorColor={colors.cursorColor} cursorStyle={{ style: "block", blinking: true }} onContentChange={() => props.onInput()} /></box>
            <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>Starts from current HEAD</text></box>
            <Show when={props.worktreeError}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.error} bg={colors.commandCardBg}>✕ {truncate(props.worktreeError ?? "", width() - 6)}</text></box></Show>
            <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>Enter create · Esc back</text></box>
          </Show>
          <Show when={!worktreeCreateMode()}>
          <Show when={sessionMode() || worktreeMode() || entityMode()}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.text} bg={colors.commandCardBg} bold>{sessionMode() ? props.sessionAction === "rename" ? "Rename session" : "Sessions" : worktreeMode() ? "Worktrees" : props.mode === "models" ? "Models" : props.mode === "connect-providers" ? "Connect a provider" : "Skills"}</text></box></Show>
          <box height={1} paddingX={1} flexDirection="row" backgroundColor={colors.commandCardBg}><text fg={colors.statusModel} bg={colors.commandCardBg}>{"> "}</text><textarea ref={(ref: TextareaRenderable) => props.onRef?.(ref)} focused={!sessionActionMenuOpen()} height={1} flexGrow={1} value={props.query} placeholder={sessionMode() ? "Search sessions" : worktreeMode() ? "Search worktrees" : props.mode === "skills" ? "Search skills" : props.mode === "models" ? "Search models" : props.mode === "connect-providers" ? "Search providers" : "Search anything in Quark"} placeholderColor={colors.muted} textColor={colors.text} focusedTextColor={colors.text} cursorColor={colors.cursorColor} cursorStyle={{ style: "block", blinking: true }} onContentChange={() => props.onInput()} /></box>
          <Show when={sessionMode() || rows() > 0}><box height={1} backgroundColor={colors.commandCardBg}><text fg={colors.outline} bg={colors.commandCardBg}>{"─".repeat(Math.max(0, width() - 2))}</text></box></Show>
          <Show when={!sessionMode() && !worktreeMode() && props.query.trim() && props.entries.length === 0}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>No results</text></box></Show>
          <Show when={sessionMode() && (props.sessionRows?.length ?? 0) === 0}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>No sessions found</text></box></Show>
          <Show when={worktreeMode() && (props.worktreeRows?.length ?? 0) === 0}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>No worktrees found</text></box></Show>
          <Show when={sessionMode()}><For each={visibleSessions()}>{(row, index) => {
            if (row.type === "spacer") return <box height={1} backgroundColor={colors.commandCardBg} />
            if (row.type === "divider") return <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>{`── ${row.label} ${"─".repeat(Math.max(0, width() - row.label.length - 7))}`}</text></box>
            const selected = () => visibleSessionStart() + index() === props.selectedIndex
            const tree = row.type === "orphan" || row.connector === "plain" || row.connector === "root" ? "" : `${row.guides.map((guide) => guide ? "│  " : "   ").join("")}${row.connector === "last" ? "└─" : "├─"} `
            return <box height={1} paddingX={1} flexDirection="row" backgroundColor={colors.commandCardBg}><text fg={selected() ? colors.statusModel : row.running ? colors.success : colors.text} bg={colors.commandCardBg} bold={selected()}>{selected() ? "❯ " : "  "}{tree}{truncate(row.label, Math.max(3, width() - row.detail.length - 8))}</text><box flexGrow={1} backgroundColor={colors.commandCardBg} /><text fg={colors.muted} bg={colors.commandCardBg}>{truncate(row.detail, Math.floor(width() * 0.4))}</text></box>
          }}</For></Show>
          <Show when={worktreeMode()}><For each={visibleWorktrees()}>{(row, index) => {
            const selected = () => visibleWorktreeStart() + index() === props.selectedIndex && (row.type === "create" || row.type === "worktree")
            const marker = () => row.type === "worktree" ? row.current ? " ← current" : row.root ? " (root)" : "" : ""
            return <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={row.type === "disabled" ? colors.muted : selected() ? colors.statusModel : colors.text} bg={colors.commandCardBg} bold={selected()}>{selected() ? "❯ " : "  "}{truncate(row.label, Math.max(3, width() - marker().length - 6))}{marker()}</text></box>
          }}</For></Show>
          <Show when={!sessionMode() && !worktreeMode()}><For each={visible()}>{(entry, index) => {
            const selected = () => visibleStart() + index() === props.selectedIndex
            const type = () => entry.type === "provider" ? "Provider" : entry.type[0]!.toUpperCase() + entry.type.slice(1)
            const state = () => entry.isCurrent ? " · current" : entry.isUnavailable ? " · unavailable" : ""
            const available = () => Math.max(4, width() - 16)
            const suffix = () => truncate((entry.detail ?? "") + state(), Math.floor(available() * 0.45))
            const label = () => truncate(entry.label, Math.max(3, available() - suffix().length - 1))
            return <box height={1} paddingX={1} flexDirection="row" backgroundColor={colors.commandCardBg}><text fg={selected() ? colors.statusModel : colors.muted} bg={colors.commandCardBg} bold={selected()}>{selected() ? "❯ " : "  "}{type().padEnd(9)}</text><text fg={selected() ? colors.statusModel : colors.text} bg={colors.commandCardBg} bold={selected()}>{label()}</text><box flexGrow={1} backgroundColor={colors.commandCardBg} /><text fg={colors.muted} bg={colors.commandCardBg}>{suffix()}</text></box>
          }}</For></Show>
          <Show when={sessionMode()}><box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.muted} bg={colors.commandCardBg}>{sessionControls(width(), props.sessionAction ?? "browse")}</text></box></Show>
          </Show>
        </Show>
      </box>
      <Show when={props.sessionActionMenu}>{(menu) => (
        <box position="absolute" left={actionMenuLeft()} top={actionMenuTop()} width={actionMenuWidth()} height={actionMenuHeight()} flexDirection="column" borderStyle="rounded" borderColor={colors.outline} backgroundColor={colors.commandCardBg}>
          <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={colors.text} bg={colors.commandCardBg} bold>Session actions</text></box>
          <For each={menu().actions}>{(action, index) => <box height={1} paddingX={1} backgroundColor={colors.commandCardBg}><text fg={index() === menu().selectedIndex ? colors.statusModel : colors.text} bg={colors.commandCardBg} bold={index() === menu().selectedIndex}>{index() === menu().selectedIndex ? "❯ " : "  "}{action.label}</text></box>}</For>
          <box height={1} backgroundColor={colors.commandCardBg}><text fg={colors.outline} bg={colors.commandCardBg}>{"─".repeat(Math.max(0, actionMenuWidth() - 2))}</text></box>
          <box height={1} paddingX={1} flexDirection="row" backgroundColor={colors.commandCardBg}><text fg={colors.statusModel} bg={colors.commandCardBg}>{"> "}</text><textarea ref={(ref: TextareaRenderable) => menu().onRef?.(ref)} focused height={1} flexGrow={1} value={menu().query} placeholder="Search actions" placeholderColor={colors.muted} textColor={colors.text} focusedTextColor={colors.text} cursorColor={colors.cursorColor} onContentChange={() => menu().onInput()} /></box>
        </box>
      )}</Show>
      </>
    </Show>
  )
}
