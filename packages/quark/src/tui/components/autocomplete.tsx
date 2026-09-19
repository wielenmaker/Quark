// @jsxImportSource @opentui/solid
// Autocomplete — dropdown for @ file mentions, / slash commands, and pickers
//
// Renders above the Prompt component. Controlled entirely by App.tsx.
// Replaces both FileDropdown and CommandDropdown from the React TUI.

import type { Component } from "solid-js"
import { For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { ColorInput } from "@opentui/core"
import { colors } from "../theme"
import type { SlashCommand } from "../commands"
import { scrollTopForSelection } from "./autocomplete-scroll"

/** Maximum visible rows in the dropdown */
const MAX_VISIBLE_ROWS = 5

export interface PickerItem {
  id: string
  label: string
  detail: string
  isCurrent?: boolean
}

export type AutocompleteMode =
  | { type: "files"; items: string[]; selectedIndex: number; query: string }
  | { type: "commands"; items: SlashCommand[]; selectedIndex: number; query: string }
  | { type: "agents"; items: PickerItem[]; selectedIndex: number }
  | { type: "tools"; items: PickerItem[]; selectedIndex: number }

export interface AutocompleteProps {
  mode: AutocompleteMode | null
}

export const Autocomplete: Component<AutocompleteProps> = (props) => {
  // This remains directly above Prompt in normal flow, so it stays anchored
  // correctly as the composer grows with images, multiline input, or a queue.

  return <AutocompleteContent mode={props.mode} />
}

/** Row type for the unified list — title, empty text, and data rows all in one array */
interface DropdownRow {
  label: string
  detail?: string
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
  const maxVisibleRows = () => {
    const available = Math.max(1, dims().height - 6)
    return Math.min(MAX_VISIBLE_ROWS, available)
  }

  const rows = (): DropdownRow[] => {
    const mode = m()
    if (!mode) return []
    const result: DropdownRow[] = []

    // Optional title row for choice pickers.
    if (mode.type === "agents") {
      result.push({ label: "Agents — select and press Enter to switch", fg: colors.primary, bg: colors.dropdownBg, bold: true })
    } else if (mode.type === "tools") {
      result.push({ label: "User tools — select and press Enter to add", fg: colors.primary, bg: colors.dropdownBg, bold: true })
    }

    // Empty-state row OR data rows (mutually exclusive)
    if (mode.type === "files" && mode.items.length === 0) {
      result.push({ label: `No files or directories matching @${mode.query}`, fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "commands" && mode.items.length === 0) {
      result.push({ label: `No commands matching /${mode.query}`, fg: colors.muted, bg: colors.dropdownBg, bold: false })
    } else if (mode.type === "agents" && mode.items.length === 0) {
      result.push({ label: "No agents available", fg: colors.muted, bg: colors.dropdownBg, bold: false })
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
    } else if (mode.type === "agents" || mode.type === "tools") {
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

  const visibleWindow = () => {
    const mode = m()
    const allRows = rows()
    if (!mode) return allRows
    const height = Math.min(allRows.length, maxVisibleRows())
    const start = scrollTopForSelection(mode, mode.selectedIndex, allRows.length, height)
    return allRows.slice(start, start + height)
  }

  // Compute visible height: min of actual rows and MAX_VISIBLE_ROWS
  const visibleHeight = () => Math.min(rows().length, maxVisibleRows())
  const bodyHeight = visibleHeight

  const content = () => {
    return (
      <scrollbox
        height={bodyHeight()}
        scrollbarOptions={{ visible: false }}
        backgroundColor={colors.dropdownBg}
      >
        <For each={visibleWindow()}>
          {(row) => {
            // Keep the row background inside the picker shell, not under its border.
            const width = () => dims().width - 6
            const padded = () => row.label.length >= width() ? row.label : row.label + " ".repeat(width() - row.label.length)
            return row.detail
              ? (
                <box height={1} flexDirection="row" backgroundColor={row.bg}>
                  <text fg={row.fg} bg={row.bg} bold={row.bold}>{row.label}</text>
                  <box flexGrow={1} backgroundColor={row.bg} />
                  <text fg={row.fg} bg={row.bg} bold={row.bold}>{row.detail}</text>
                </box>
              )
              : (
                <box height={1} backgroundColor={row.bg}>
                  <text fg={row.fg} bg={row.bg} bold={row.bold}>{padded()}</text>
                </box>
              )
          }}
        </For>
      </scrollbox>
    )
  }

  return (
    <box
      flexDirection="column"
      paddingX={1}
      height={visibleHeight()}
      backgroundColor={rows().length > 0 ? colors.dropdownBg : undefined}
    >
      {content()}
    </box>
  )
}
