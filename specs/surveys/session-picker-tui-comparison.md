---
title: Coding Agent Session Picker TUI Comparison
date_created: 2026-08-20
date_modified: 2026-08-20
revision: 1
status: done
history:
  - 2026-08-20: Compared Quark with OpenCode, Amp, and Pi using live captures, current source, and official docs
---

# Coding Agent Session Picker TUI Comparison

This survey compares the session-selection experience in Quark, OpenCode, Amp,
and Pi. The focus is the UI used to find, inspect, resume, and manage a saved
conversation—not the main transcript renderer.

## Method

Observed on 2026-08-20:

- **Quark**: local source at `0a3c193`, plus a live 120×40 capture of `/sessions`.
- **Amp**: CLI `0.0.1787117828-g1c5807`, plus a live 120×40 capture of
  `amp threads continue`.
- **Pi**: CLI `0.80.10`, plus live 120×40 captures of `pi --resume` in current-
  folder and all-folder scopes.
- **OpenCode**: current official TUI docs and `dev` branch source. The local
  binary exited with `SIGKILL`, so no live frame was used.

Primary references:

- [OpenCode TUI commands](https://dev.opencode.ai/docs/tui/)
- [OpenCode CLI session flags](https://dev.opencode.ai/docs/cli/)
- [OpenCode session-list source](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/dialog-session-list.tsx)
- [Amp Owner's Manual](https://ampcode.com/manual)
- [Amp: new threads without leaving the CLI](https://ampcode.com/news/new-threads-without-leaving-the-cli)
- [Pi sessions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [Pi session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)

## The four design models

### Quark: task lineage map

Quark groups sessions under task titles, then shows a leaf-to-root path for each
branch. The current task is sorted first. The picker is an eight-row card above
the composer.

```text
which branch are we on, and what changes did we make
╰─▶ from which branch are we on ... · root · 8/20

Add a /todo command that creates a human-readable todo list.
╰─▶ from Human Todo List Command · root · 8/19
```

Strengths:

- Only picker that makes Quark's task/session lineage a first-class visual.
- Current task and current/root markers preserve branch context.
- Reuses the composer overlay and stays visually consistent with other pickers.
- Session loading is project-directory scoped, matching Quark's worktree flow.

Weaknesses:

- Input is blocked while the picker is open, so there is no search or filtering.
- The leaf-first renderer is not a conventional tree. Shared ancestors are
  repeated when a parent has multiple children.
- Only title, `current`/`root`, and `M/D` are visible. There is no preview,
  relative age, activity state, changed-file count, or path.
- There are no picker actions for rename, delete, or pin.
- Discoverability is weak: the card has no title or keybinding hints.
- The eight-row viewport becomes expensive to navigate as history grows.

### OpenCode: searchable recent-session index

OpenCode opens a large `Sessions` dialog through `/sessions` (`/resume` and
`/continue` aliases) or `ctrl+x l`. Its current source requests only root
sessions, searches by title, and groups results into `Pinned`, `Today`, and date
sections.

Current rows can show:

- title and optional directory footer;
- current selection;
- a spinner for busy/retrying sessions;
- a quick-switch slot number;
- pin/unpin, rename, and two-step delete actions.

Strengths:

- Fast retrieval at scale: search, recency ordering, pinning, and quick slots.
- Activity indicators make concurrent sessions visible.
- Management actions live where users browse sessions.
- CLI parity is strong: continue latest, resume by ID, and fork on resume.

Weaknesses:

- The main picker deliberately shows roots only, so branch/subagent topology is
  absent from this view.
- No transcript preview; users identify sessions mostly by generated titles.
- Its feature density and persistent slots are more machinery than Quark needs
  before basic search and management exist.

### Amp: searchable work queue with preview

Amp's `Switch Thread` view is a full-width split pane. The left pane is a
searchable thread list; the right pane previews the selected transcript.

```text
╭─ Switch Thread ─────────────────────────────────────────────────╮
│ >                         ╭──────── Thread Preview ────────────╮ │
│ Thread title +0 ~0 -6 3w │ selected thread transcript         │ │
│ Another thread       4w  │ tool calls and final response      │ │
│                           ╰────────────────────────────────────╯ │
╰──────────── Opt+W/Ctrl+T all workspaces · Esc close ────────────╯
```

Strengths:

- Best recognition support: title, change statistics, age, and transcript
  preview reduce the need to remember exact wording.
- One-key workspace/all-workspaces scope switching.
- Multiple threads can run in one CLI process, with `Ctrl+\` opening the thread
  sidebar for faster switching than reopening the picker.
- Threads are also searchable by ID, file, repo, ref, and update time from the
  CLI, and can be referenced from a prompt with `@@`.
- Thread lifecycle is broad: rename, label, archive, delete, share, and remote
  continuation are supported outside or alongside the picker.

Weaknesses:

- The preview consumes substantial width and makes narrow-terminal behavior
  harder.
- It is a flat work queue; parent/child lineage is not the primary navigation
  model.
- Cloud/workspace semantics and the wider thread lifecycle are not directly
  transferable to Quark's local-first storage.

### Pi: dense local session browser plus in-session tree

Pi separates two jobs:

1. `/resume` or `pi -r` selects a session file.
2. `/tree` navigates branches inside that session file.

The resume picker exposes its controls directly:

```text
Resume Session (All)                 ○ Current Folder | ◉ All  Name: All  Sort: Threaded
tab scope · re:<pattern> regex · "phrase" exact
ctrl+s sort · ctrl+n named · ctrl+d delete · ctrl+p path (off)

> search
› Session title                    ~/project/path  3  1mo
```

It also supports rename (`ctrl+r`), exact/regex search, a named-only filter,
path visibility, sort modes, and recoverable deletion through `trash` when
available.

Strengths:

- Most capable local history browser, with excellent keyboard discoverability.
- Current-folder/all scope is explicit and reversible.
- Naming, search syntax, sort, path, and delete controls scale to large stores.
- Its separate `/tree` is the strongest branch-history UI: jump to any entry,
  fold branches, label entries, and continue from an earlier point.

Weaknesses:

- Dense header and shortcut rows create a steeper learning curve.
- Session-file selection and branch selection are separate concepts and screens.
- Pi's in-file message tree does not map directly to Quark's session-per-branch
  data model.

## Capability matrix

| Capability | Quark | OpenCode | Amp | Pi |
|---|---|---|---|---|
| Open picker in TUI | `/sessions` | `/sessions`, aliases, keybind | `/continue` | `/resume` |
| Continue latest from CLI | No dedicated flag | `-c` | `amp last` / `--last` | `-c` |
| Resume by ID | Yes | Yes | Yes | Yes |
| Search in picker | No | Title search | Text search | Text, exact, regex |
| Scope toggle | No; current cwd only | Project/path query | Workspace/all workspaces | Current folder/all |
| Recency grouping | Task order + date label | Pinned/today/date | Relative age | Sort modes + age |
| Preview | No | No | Transcript pane | No |
| Branch topology in picker | Yes, leaf-to-root paths | No; roots only | No | Separate `/tree` |
| Busy state | No | Spinner | Not observed in picker | No |
| Rename | No | Yes | CLI/palette | Yes |
| Delete | No | Two-step confirmation | CLI | Confirmed, trash if available |
| Pin/quick switch | No | Both | Thread sidebar, no pinned slots | Named-only filter |
| Change metadata | `filesModified` stored, not shown | No | `+ / ~ / -` counts | Message count |

## What Quark should keep

Quark should not replace its picker with a flat clone of Amp or OpenCode. The
lineage view explains Quark's defining session-per-branch model and makes
automatic context branching inspectable. Neither a flat recent list nor Pi's
message-entry tree communicates that model as directly.

The task grouping has a cost, however: it duplicates root-session identity and
currently produces an inverted, duplicate-prone tree. The existing
`session-tree-without-tasks.md` direction—root session as the group and a normal
root-first DFS—is better aligned with what the picker is trying to explain.

## Recommended Quark direction

### Priority 0: make the current model usable at scale

1. **Render a real root-first DFS tree.** Each session appears once; current
   tree first; recent siblings first. This fixes comprehension before adding
   more chrome.
2. **Search while the picker is open.** Match session title, root title, and ID.
   Filtering should retain ancestors of matching branches so topology remains
   understandable.
3. **Add a compact header/footer.** Show `Sessions`, a search hint, and visible
   actions such as `Enter open · Ctrl+R rename · Ctrl+D delete · Esc close`.
4. **Add rename and two-step delete.** These are baseline history hygiene in
   OpenCode and Pi. Prefer recoverable deletion where the platform supports it.

### Priority 1: improve recognition without losing the tree

5. Replace `M/D` with relative age for recent sessions, falling back to a date
   for older ones.
6. Show a small changed-file count from Quark's existing `filesModified`
   metadata. It provides part of Amp's recognition benefit without loading a
   transcript preview.
7. Add a current-worktree/all-project-worktrees scope toggle only after the
   current `/worktree` → `/sessions` flow is preserved as the simple default.

### Priority 2: optional wide-screen preview

Amp's preview is useful, but it should be conditional rather than foundational.
At widths around 120 columns or more, a right pane could show the last user
message, final assistant text, and changed files. On narrow terminals, keep the
single tree card.

```text
Wide terminal
╭─ Sessions ────────────────────────┬─ Preview ───────────────────╮
│ > search                          │ Last request                │
│ Root task                         │ Last response               │
│ ├─ branch A · 2h · 3 files        │ Files changed              │
│ └─ branch B · current · 4m        │                             │
├───────────────────────────────────┴─────────────────────────────┤
│ Enter open · Ctrl+R rename · Ctrl+D delete · Esc close          │
╰─────────────────────────────────────────────────────────────────╯
```

## Bottom line

- **Borrow from Pi first:** visible controls, search, rename/delete, scope.
- **Borrow from OpenCode next:** pinning, quick slots, and busy state only when
  concurrent session switching becomes common.
- **Borrow from Amp selectively:** changed-file metadata now; preview later and
  only on wide terminals.
- **Keep Quark's differentiator:** session lineage, but render it as a normal
  root-first tree rather than leaf-to-root path stacks.
