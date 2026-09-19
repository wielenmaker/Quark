// autocomplete-scroll.ts — pure scroll-position math for the Autocomplete dropdown.
//
// The cursor (selected row) is anchored at a fixed visual row inside the
// viewport; the list slides past it (vim `scrolloff` style). At the edges
// of the list, the cursor naturally ends up at the top or bottom of the
// visible window (clamped to [0, maxScrollTop]).

import type { AutocompleteMode } from "./autocomplete"

/** Anchor row for compact pickers (5 visible rows). */
export const PICKER_ANCHOR_ROW = 2

/**
 * Compute the scroll position that keeps the selected row at its anchor row.
 *
 * Visual layout: the cursor occupies a fixed row inside the viewport; the list
 * slides past it. At the edges of the list, the cursor naturally ends up at
 * the top or bottom of the visible window (clamped to [0, maxScrollTop]).
 */
export function scrollTopForSelection(
  mode: AutocompleteMode,
  selectedIndex: number,
  totalRows: number,
  viewportHeight: number,
): number {
  if (totalRows <= viewportHeight) return 0

  // The row index inside the scrollbox. Choice pickers have a title row at 0,
  // so their items are offset by 1. Other pickers (files/commands)
  // have no title.
  const titleOffset =
    mode.type === "agents" || mode.type === "tools"
      ? 1
      : 0
  const scrollIndex = selectedIndex + titleOffset

  const maxScrollTop = totalRows - viewportHeight
  return Math.max(0, Math.min(scrollIndex - PICKER_ANCHOR_ROW, maxScrollTop))
}
