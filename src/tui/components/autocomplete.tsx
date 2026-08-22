// @jsxImportSource @opentui/solid
// Autocomplete — dropdown for @ file mentions, / slash commands, and pickers
//
// Renders above the Prompt component. Controlled entirely by App.tsx.
// Replaces both FileDropdown and CommandDropdown from the React TUI.

import type { Component } from "solid-js"
import { For, createEffect } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { ColorInput, ScrollBoxRenderable } from "@opentui/core"
import { colors } from "../theme"
import type { SlashCommand } from "../commands"
import { sessionQuickSwitchNumber, type SessionScope, type SessionTreeRow } from "../session-tree-picker"
import type { WorktreePickerRow } from "../worktree-picker"
import { CommandCard } from "./command-card"
import { scrollTopForSelection } from "./autocomplete-scroll"
import { sessionControls, type SessionAction } from "../session-controls"

/** Maximum visible rows in the dropdown */
const MAX_VISIBLE_ROWS = 5
const MAX_SESSION_VISIBLE_ROWS = 8
const SESSION_CARD_INSET = 2

export interface PickerItem {
  id: string
  label: string
  detail: string
  isCurrent?: boolean
}

export type AutocompleteMode =
  | { type: "files"; items: string[]; selectedIndex: number; query: string }
  | { type: "commands"; items: SlashCommand[]; selectedIndex: number; query: string }
  | {
    type: "sessions"
    rows: SessionTreeRow[]
    selectedIndex: number
    query: string
    action: SessionAction
    scope: SessionScope
  }
  | { type: "worktrees"; rows: WorktreePickerRow[]; selectedIndex: number }
  | { type: "models"; items: PickerItem[]; selectedIndex: number }
  | { type: "profiles"; items: PickerItem[]; selectedIndex: number }
  | { type: "skills"; items: PickerItem[]; selectedIndex: number }
  | { type: "tools"; items: PickerItem[]; selectedIndex: number }

export interface AutocompleteProps {
  mode: AutocompleteMode | null
}

// Height of Prompt (status line 1 + input box minHeight 4) + FooterBar (1)
// Used to anchor the absolutely-positioned dropdown above the prompt.
const BOTTOM_OFFSET = 6

export const Autocomplete: Component<AutocompleteProps> = (props) => {
  // Absolutely positioned overlay — does NOT participate in flex flow,
  // so the scrollbox keeps its full height when the dropdown appears.
  // Anchored to bottom={BOTTOM_OFFSET} to sit right above the prompt.
  //
  // When mode is null, rows() returns [] and height={0}, rendering nothing.

  return <AutocompleteContent mode={props.mode} />
}

/** Row type for the unified list — title, empty text, and data rows all in one array */
interface DropdownRow {
  label: string
  fg: ColorInput
  bg: ColorInput
  bold: boolean
}

/**
 * Renders the dropdown content — single <For>, ZERO <Show> blocks.
 *
 * Title text, empty-state text, and selectable items are all folded into
 * one computed `rows()` array. This avoids multiple LayoutSlotRenderables
 * (created by <Show>) which cause Yoga height miscalculation and row overlap.
 *
 * Uses scrollbox when items exceed MAX_VISIBLE_ROWS to enable scrolling.
 */
const AutocompleteContent: Component<{ mode: AutocompleteMode | null }> = (props) => {
  const dims = useTerminalDimensions()
  const m = () => props.mode
  const sessionMode = () => {
    const mode = m()
    return mode?.type === "sessions" ? mode : null
  }
  let scrollRef: ScrollBoxRenderable | undefined
  const maxVisibleRows = () => {
    const isSession = m()?.type === "sessions"
    const isCard = isSession || m()?.type === "worktrees"
    const chromeRows = (isCard ? 2 : 0) + (isSession ? 2 : 0)
    const available = Math.max(1, dims().height - BOTTOM_OFFSET - chromeRows)
    return Math.min(isSession ? MAX_SESSION_VISIBLE_ROWS : MAX_VISIBLE_ROWS, available)
  }

  // Scroll to keep the selected item anchored at a fixed visual row.
  // The cursor stays put; the list slides past it (vim `scrolloff` style).
  createEffect(() => {
    const mode = m()
    if (!mode || !scrollRef) return
    const totalRows = rows().length
    const viewportHeight = Math.min(totalRows, maxVisibleRows())
    const newScrollTop = scrollTopForSelection(
      mode,
      mode.selectedIndex,
      totalRows,
      viewportHeight,
    )
    if (newScrollTop !== scrollRef.scrollTop) {
      scrollRef.scrollTo(newScrollTop)
    }
  })

  const rows = (): DropdownRow[] => {
    const mode = m()
    if (!mode) return []
    const result: DropdownRow[] = []

    // Optional title row (sessions / choice pickers)
    if (mode.type === "sessions") {
      // The sessions picker is a task tree; task headers are rendered below.
    } else if (mode.type === "models") {
      result.push({ label: "Models — select and press Enter to switch", fg: colors.primary, bg: colors.dropdownBg, bold: true })
    } else if (mode.type === "profiles") {
      result.push({ label: "Profiles — select and press Enter to switch", fg: colors.primary, bg: colors.dropdownBg, bold: true })
    } else if (mode.type === "skills") {
      result.push({ label: "Skills — select and press Enter to add", fg: colors.primary, bg: colors.dropdownBg, bold: true })
    } else if (mode.type === "tools") {
      result.push({ label: "User tools — select and press Enter to add", fg: colors.primary, bg: colors.dropdownBg, bold: true })
    }

    // Empty-state row OR data rows (mutually exclusive)
    if (mode.type === "files" && mode.items.length === 0) {
      result.push({ label: `No files or directories matching @${mode.query}`, fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "commands" && mode.items.length === 0) {
      result.push({ label: `No commands matching /${mode.query}`, fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "sessions" && mode.rows.length === 0) {
      result.push({ label: "No sessions found", fg: colors.muted, bg: colors.commandCardBg, bold: false })
    } else if (mode.type === "worktrees" && mode.rows.length === 0) {
      result.push({ label: "No worktrees found", fg: colors.muted, bg: colors.commandCardBg, bold: false })
    } else if (mode.type === "models" && mode.items.length === 0) {
      result.push({ label: "No models available", fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "profiles" && mode.items.length === 0) {
      result.push({ label: "No profiles available", fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "skills" && mode.items.length === 0) {
      result.push({ label: "No skills found", fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "tools" && mode.items.length === 0) {
      result.push({ label: "No user tools in ~/.config/quark/tools/", fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "commands") {
      for (let i = 0; i < mode.items.length; i++) {
        const cmd = mode.items[i]!
        const sel = i === mode.selectedIndex
        const prefix = sel ? "❯" : " "
        const usage = cmd.usage ? ` ${cmd.usage}` : ""
        result.push({
          label: `${prefix} /${cmd.id}${usage} — ${cmd.description}`,
          fg: sel ? colors.primary : colors.textDim,
          bg: colors.dropdownBg,
          bold: sel,
        })
      }
    } else if (mode.type === "files") {
      for (let i = 0; i < mode.items.length; i++) {
        const item = mode.items[i]!
        const sel = i === mode.selectedIndex
        result.push({
          label: `${sel ? "❯ " : "  "}${item}`,
          fg: sel ? colors.primary : colors.textDim,
          bg: colors.dropdownBg,
          bold: sel,
        })
      }
    } else if (mode.type === "sessions") {
      for (let i = 0; i < mode.rows.length; i++) {
        const item = mode.rows[i]!
        if (item.type === "spacer") {
          result.push({ label: "", fg: colors.textDim, bg: colors.commandCardBg, bold: false })
          continue
        }

        const sel = i === mode.selectedIndex && (item.type === "session" || item.type === "orphan")
        const quickSwitch = sessionQuickSwitchNumber(mode.rows, i)
        const number = quickSwitch ? `${quickSwitch} ` : "  "
        const prefix = item.type === "task" ? (item.current ? "› " : "  ") : "  "
        const tree = item.type === "session"
          ? item.connector === "root"
            ? "● "
            : `${item.guides.map((guide) => guide ? "│  " : "   ").join("")}${item.connector === "last" ? "└─" : "├─"}● `
          : ""
        result.push({
          label: item.type === "task"
            ? `${prefix}${item.label}`
            : item.type === "orphan"
              ? `${sel ? "❯ " : "  "}${number}${item.label}`
              : `${sel ? "❯ " : "  "}${number}${tree}${item.label}`,
          fg: sel
            ? colors.primary
            : item.type === "task"
              ? (item.current ? colors.primary : colors.text)
              : item.running
                ? colors.success
                : colors.textDim,
          bg: colors.commandCardBg,
          bold: sel,
        })
      }
    } else if (mode.type === "worktrees") {
      for (let i = 0; i < mode.rows.length; i++) {
        const item = mode.rows[i]!
        const sel = i === mode.selectedIndex && item.type === "worktree"
        const prefix = sel ? "❯ " : "  "
        const marker = item.type === "worktree"
          ? (item.current ? " ← current" : item.root ? " (root)" : "")
          : ""
        result.push({
          label: `${prefix}${item.label}${marker}`,
          fg: item.type === "disabled" ? colors.muted : sel ? colors.primary : colors.textDim,
          bg: colors.commandCardBg,
          bold: sel,
        })
      }
    } else if (mode.type === "models" || mode.type === "profiles" || mode.type === "skills" || mode.type === "tools") {
      for (let i = 0; i < mode.items.length; i++) {
        const item = mode.items[i]!
        const sel = i === mode.selectedIndex
        result.push({
          label: `${sel ? "❯ " : "  "}${item.label}${item.isCurrent ? "  ← current" : ""}`,
          fg: sel ? colors.primary : colors.textDim,
          bg: colors.dropdownBg,
          bold: sel,
        })
      }
    }

    return result
  }

  // Compute visible height: min of actual rows and MAX_VISIBLE_ROWS
  const visibleHeight = () => Math.min(rows().length, maxVisibleRows())
  const isSessionCard = () => m()?.type === "sessions" || m()?.type === "worktrees"
  const isSessionPicker = () => m()?.type === "sessions"
  const bodyHeight = visibleHeight
  const panelBg = () => isSessionCard() ? colors.commandCardBg : colors.dropdownBg
  const panelHeight = () => isSessionCard() && rows().length > 0
    ? bodyHeight() + 2 + (isSessionPicker() ? 2 : 0)
    : visibleHeight()

  const content = () => (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
      height={bodyHeight()}
      scrollbarOptions={{ visible: false }}
      backgroundColor={panelBg()}
    >
      <For each={rows()}>
        {(row) => {
          // Pad label with spaces to fill the full row width so bg covers all cells.
          // Keep the row background inside the picker shell, not under its border.
          const padded = () => {
            const w = dims().width - (isSessionCard() ? 10 : 6)
            return row.label.length >= w ? row.label : row.label + " ".repeat(w - row.label.length)
          }
          return (
            <box height={1} backgroundColor={row.bg}>
              <text fg={row.fg} bg={row.bg} bold={row.bold}>{padded()}</text>
            </box>
          )
        }}
      </For>
    </scrollbox>
  )

  const cardContent = () => isSessionPicker()
    ? (
      <box flexDirection="column">
        <box height={1} backgroundColor={colors.commandCardBg}>
          <text fg={colors.text} bg={colors.commandCardBg} bold>
            {m()?.type === "sessions" && m()!.action === "rename"
              ? "Rename session"
              : m()?.type === "sessions" && m()!.action === "delete"
                ? "Delete selected session?"
              : m()?.type === "sessions" && m()!.query
                ? `Sessions · ${m()!.scope === "worktree" ? "this worktree" : "all worktrees"} — search: ${m()!.query}`
                : `Sessions · ${m()?.type === "sessions" && m()!.scope === "project" ? "all worktrees" : "this worktree"} — type to search`}
          </text>
        </box>
        {content()}
        <box height={1} backgroundColor={colors.commandCardBg}>
          <text fg={colors.muted} bg={colors.commandCardBg}>
            {sessionControls(dims().width, sessionMode()?.action ?? "browse")}
          </text>
        </box>
      </box>
    )
    : content()

  return (
    <box
      flexDirection="column"
      paddingX={1}
      height={panelHeight()}
      position="absolute"
      bottom={BOTTOM_OFFSET}
      left={isSessionCard() ? SESSION_CARD_INSET : 0}
      right={isSessionCard() ? SESSION_CARD_INSET : 0}
      backgroundColor={rows().length > 0 && !isSessionCard() ? colors.dropdownBg : undefined}
    >
      {isSessionCard() && rows().length > 0
        ? <CommandCard height={panelHeight()}>{cardContent()}</CommandCard>
        : content()}
    </box>
  )
}
