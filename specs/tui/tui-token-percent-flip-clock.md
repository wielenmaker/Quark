---
title: TUI Token Percent Flip Clock
date_created: 2026-05-28
date_modified: 2026-05-28
revision: 1
history:
  - 2026-05-28: Initial implementation record
status: done
---

## Problem

The prompt status line showed token context usage as a static percentage. When
the value changed, the first animation attempt read like a horizontal scanner:
changed characters were replaced by block glyphs across the string.

The desired effect is closer to a mechanical flip clock or odometer: changed
digits should feel like they roll vertically into place.

## Implementation

The percent display was split out of `Prompt` into a small animated component:

- `src/tui/components/prompt.tsx` computes the visible token percentage with
  `tokenPercentValue()` and renders `FlipPercent` before the rest of the
  status text.
- `src/tui/components/flip-percent.tsx` tracks `from`, `to`, and `frame`.
  It starts a short interval only when the visible percentage increases.
- `src/tui/components/flip-percent-frame.ts` owns the pure frame logic so it
  can be tested without mounting OpenTUI.

Frame sequence:

```text
42% -> 4²% -> 4₃% -> 43%
```

Unchanged digits stay fixed. Changed digits first lift upward using superscript
digits, then enter from below using subscript digits, then settle into normal
text.

## Key Decisions

1. Animate only upward visible percentage changes.
   Token usage should draw attention when context pressure increases. Resets,
   session switches, and unchanged rounded percentages update immediately.

2. Roll per digit, not per whole string.
   This avoids the scanner/ticker feel and makes the movement read as a small
   mechanical dial.

3. Keep one terminal row.
   The prompt status line is height-stable, so vertical movement is simulated
   with superscript/subscript glyphs instead of adding layout height.

4. No color flash.
   The status-line color remains constant. Motion carries the feedback.

5. Use a local interval, not OpenTUI Timeline.
   The OpenTUI reference cache shows `useTimeline`, but Quark's TUI already
   uses short component-local intervals for spinners. This kept the change
   smaller and consistent with nearby code.

## Acceptance Criteria

- [x] Token percentage animates only when the displayed percent increments.
- [x] The animation reads as vertical rolling digits, not horizontal scanning.
- [x] The prompt status line keeps stable height and does not shift surrounding
      text.
- [x] The animation does not flash blue or change status-line color.
- [x] Pure frame behavior is covered by tests.

## Verification

- `bun test test/tui/flip-percent-frame.test.ts`
- `bun run typecheck`
- `bun run dev` TUI render smoke test

Known unrelated broader TUI test failures at implementation time:

- `test/tui/spinner.test.ts` expects one-character spinner frames, while the
  current spinner uses two-character frames.
- `test/tui/commands.test.ts` expects three `/s` matches, while the current
  command list also includes `statistics`.
