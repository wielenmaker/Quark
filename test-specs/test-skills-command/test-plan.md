---
title: "/skills Slash Command — Test Plan"
date_created: 2026-06-04
date_modified: 2026-06-04
revision: 1
history:
  - 2026-06-04: Initial draft
status: draft
---

## Objective

Verify that the `/skills` TUI slash command feature correctly:
1. Registers as a slash command with proper filtering
2. Opens a choice picker listing all discovered skills
3. Adds a selected skill to the active agent's in-memory skill list
4. Updates the system prompt to include L1 metadata for the new skill
5. Re-registers the skill tool with the expanded boundSkills list
6. Detects and handles duplicate skill additions
7. Shows appropriate toast notifications

## Test Strategy

- **Unit tests** for command registration, filtering, and picker mode mapping
- **Integration tests** for the full flow: discovery → picker items → agent mutation → system prompt update → skill tool update
- **Edge case tests** for empty states, duplicates, and non-existent skills

### Approach

Tests are written BEFORE implementation (TDD). Tests target the pure functions and
integration points that will be touched by this feature:
- `src/tui/commands.ts` — command entry + filter
- `src/tui/picker-items.ts` — picker mode + picker items
- `src/skill/skill.ts` — skill discovery/conversion
- `src/session/system.ts` — system prompt rebuilding
- `src/tool/skill.ts` — skill tool re-registration
- `src/agent.ts` — agent skills mutation

## Environment

- Bun test runtime (`bun:test`)
- Temporary directories for skill file creation (via `fs.mkdtempSync`)
- No TUI rendering required — all tests are headless

## Entry/Exit Criteria

**Entry**: All source files exist, test framework is configured.
**Exit**: All test cases pass after implementation is complete.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Tests may need adjustment after implementation details are finalized | Write tests against public API surfaces, not implementation internals |
| TUI picker state machine changes (App.tsx) are hard to unit-test | Focus on pure functions and integration points; manual E2E test required separately |
| `buildPickerItems` single `currentId` param may need change for skills | Test with the current API; if API changes, tests will guide the change |

## Schedule

- Test writing: 1 session (this task)
- Implementation: subsequent task
- Manual E2E verification: after implementation
