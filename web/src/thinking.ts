// thinking — presentation helpers for the thinking-effort control
//
// The available levels come from the catalog: `thinkingCapabilityFromCatalog`
// normalizes a model's reasoning_options into an ordered list with "none"
// first. These helpers only format that list for the UI.

import type { AppStatus } from "./types"

/** Half of the slider knob; the track fill and dots are inset by this much. */
export const KNOB_SIZE = 30

export function thinkingLabel(effort: string): string {
  if (effort === "none") return "None"
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Trigger text: the active level, or a prompt when thinking is off. */
export function thinkingTriggerLabel(status: AppStatus): string {
  return status.thinkingEffort === "none" ? "Select effort" : thinkingLabel(status.thinkingEffort)
}

/** A model that exposes no levels beyond "none" cannot be configured. */
export function thinkingEnabled(status: AppStatus): boolean {
  return status.thinkingLevels.length > 1
}

/** Position of the active level as a 0..1 fraction along the track. */
export function thinkingFraction(status: AppStatus): number {
  const last = Math.max(1, status.thinkingLevels.length - 1)
  const index = Math.max(0, status.thinkingLevels.indexOf(status.thinkingEffort))
  return index / last
}

export function thinkingFill(status: AppStatus): string {
  return `calc(${KNOB_SIZE / 2}px + (100% - ${KNOB_SIZE}px) * ${thinkingFraction(status)})`
}
