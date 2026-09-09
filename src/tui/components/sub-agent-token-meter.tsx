// @jsxImportSource @opentui/solid

import type { Component } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { colors } from "../theme"

interface SubAgentTokenMeterProps {
  tokensUsed: number
  tokenLimit: number
  color: string | RGBA
}

// Each bar cell is 2 columns wide. `▎` is a visually quarter-width separator.
// Terminals still reserve one character column for the separator glyph.
const METER_CELL = "▄▄▎"
const METER_CELL_WIDTH = 3

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const value = tokens / 1000
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`
}

export const SubAgentTokenMeter: Component<SubAgentTokenMeterProps> = (props) => {
  const dimensions = useTerminalDimensions()

  const percentage = () => {
    if (props.tokenLimit <= 0) return 0
    return Math.min(100, props.tokensUsed / props.tokenLimit * 100)
  }

  const displayPercentage = () => {
    const pct = percentage()
    if (props.tokensUsed <= 0) return "0%"
    if (pct < 1) return `${pct.toFixed(1)}%`
    return `${Math.round(pct)}%`
  }

  const tokenLabel = () => {
    const limit = props.tokenLimit > 0 ? ` / ${formatTokens(props.tokenLimit)}` : ""
    return `${formatTokens(props.tokensUsed)}${limit} tokens (${displayPercentage()})`
  }

  // The meter lives inside a half-width card, so estimate the available width
  // as roughly half the terminal width minus the label and padding.
  const meterSegments = () => Math.max(
    4,
    Math.floor(((dimensions().width - 1) * 0.5 - 5 - tokenLabel().length) / METER_CELL_WIDTH),
  )

  const filledSegments = () => {
    if (props.tokensUsed <= 0) return 0
    return Math.max(1, Math.round(percentage() / 100 * meterSegments()))
  }

  return (
    <box flexDirection="row" height={1} backgroundColor={colors.commandCardBg}>
      <box flexDirection="row" flexGrow={1} flexBasis={0} minWidth={0} height={1} overflow="hidden">
        <text fg={props.color}>{METER_CELL.repeat(filledSegments())}</text>
        <text fg={colors.border}>{METER_CELL.repeat(meterSegments() - filledSegments())}</text>
      </box>
      <text fg={colors.text} flexShrink={0}> {tokenLabel()}</text>
    </box>
  )
}
