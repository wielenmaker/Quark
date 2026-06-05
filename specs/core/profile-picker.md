---
title: Profile Picker
date_created: 2026-05-30
date_modified: 2026-05-30
revision: 2
history:
  - 2026-05-30: Initial plan
  - 2026-05-30: Implemented profile picker and verification
status: done
---

## Problem

`/model` opens an interactive picker, while `/profile` only lists profiles in a toast. Users must type the target profile manually.

## Architecture

- Reuse the existing slash picker state and `PickerItem` rendering.
- Add a `profiles` picker mode beside `models`.
- Expose profile options from the TUI entrypoint via `listProfiles()`.
- Selecting a profile delegates to the existing `/profile <id>` backend path.

## Decisions

- Keep backend no-argument `/profile` listing as a fallback.
- Show profile IDs in the picker because IDs are the command arguments.
- Do not create a new session when switching profiles; preserve existing behavior.

## Acceptance Criteria

- Typing `/profile` and pressing Enter opens a profile picker.
- The current profile is sorted first and marked current.
- Typing while the picker is open filters profiles.
- Pressing Enter on a profile runs the existing profile switch path.
- Tests cover picker item construction and command registry behavior.
