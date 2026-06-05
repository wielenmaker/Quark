---
title: Quark Desktop V1 — Shared Diff Workspace
date_created: 2026-05-06
date_modified: 2026-05-06
revision: 2
history:
  - 2026-05-06: Initial spec from design brief
  - 2026-05-06: Added existing prototype reference section
status: draft
---

# Quark Desktop V1: Shared Diff Workspace

## Problem

Quark today runs in a terminal (TUI) or browser (web UI). Neither surface gives
the user a first-class view of what the agent is about to change before it
changes it. In the TUI, the permission prompt shows a filename and maybe a
diff snippet. In the web UI, there is no shared workspace at all.

A desktop app can provide a richer interaction model: a three-pane layout where
human and agent share a middle workspace for reviewing diffs, reading source,
and seeing live previews — all before a single file write happens.

## Existing Prototype (`quark-desktop/`)

The repo already contains a static HTML/CSS/JS prototype at `quark-desktop/`
that demonstrates the three-pane layout concept:

```
quark-desktop/
  index.html    — Three-pane layout: left sidebar (files/commands),
                  middle canvas (visual/source mode toggle, Mermaid renderer),
                  right agent chat panel with diff cards and omnibar
  styles.css    — CSS custom properties, grid layout, responsive breakpoints,
                  card components (diff-card, artifact-card), chat thread
  script.js     — ModeSwitch (visual↔source toggle), Omnibar (chat submit)
```

**What the prototype shows:**
| Element | Prototype equivalent |
|---------|---------------------|
| Left pane | File tree, workspace nav, task checkboxes, traffic-light window controls |
| Middle pane (Visual) | Mermaid SVG diagram — placeholder for diff review / HTML preview |
| Middle pane (Source) | CodeMirror-like editor with line numbers — placeholder for source editor |
| Right pane | Agent chat thread, diff cards (`+21 -20`), response actions, omnibar input |
| Diff card | `index.html +8 -8`, `styles.css +13 -12` — placeholder for real permission-gated diffs |

**What the prototype does NOT do:**
- No real backend connection — chat input echo, no WebSocket
- No diff review → permission flow — diff cards are static HTML
- No file system access — file tree entries are hardcoded
- No sidecar integration — no Quark server process

The prototype serves as UX reference for the Tauri app. The V1 implementation
replaces it with a real React + Vite + Tauri scaffold that connects to a live
Quark sidecar.

## Solution

Build `quark-desktop` as a macOS-first Tauri 2 + React/TypeScript app. It
remains a thin desktop shell — not a replacement for the TUI or web UI.
Quark core runs as a Tauri sidecar (Bun-compiled binary), exposing the
same REST/WebSocket API the web UI already consumes.

The first proof is the **shared diff workspace**: a middle pane that shows
`write`/`edit` preview diffs from `tool-input` before the permission gate
allows the tool to execute. The user can approve, reject, or correct the
diff in a rich editor, and only approval lets the write proceed.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tauri 2 Desktop Shell (macOS)                                        │
│                                                                       │
│  ┌──────────┐  ┌──────────────────────────────┐  ┌────────────────┐  │
│  │  Left    │  │         Middle Pane           │  │   Right Pane   │  │
│  │  Pane    │  │                                │  │                │  │
│  │          │  │  ┌────── Diff Review ────────┐ │  │  Agent Chat    │  │
│  │ File     │  │  │  ▲ Edit Permission         │ │  │  (React SPA)  │  │
│  │ Tree     │  │  │                           │ │  │                │  │
│  │          │  │  │  context line before       │ │  │  WebSocket    │  │
│  │ Commands │  │  │ - old line of code          │ │  │  events       │  │
│  │          │  │  │ + new line of code          │ │  │                │  │
│  │ Tasks    │  │  │  context line after        │ │  │  REST API     │  │
│  │ (future) │  │  │                           │ │  │  calls        │  │
│  │          │  │  │  [Approve] [Reject] [Fix] │ │  │                │  │
│  │          │  │  └───────────────────────────┘ │  │                │  │
│  │          │  │  ┌────── Source (CodeMirror) ┐ │  │                │  │
│  │          │  │  │  ...                       │ │  │                │  │
│  │          │  │  └───────────────────────────┘ │  │                │  │
│  │          │  │  ┌────── Preview (HTML) ──────┐ │  │                │  │
│  │          │  │  │  ...                       │ │  │                │  │
│  │          │  │  └───────────────────────────┘ │  │                │  │
│  └──────────┘  └──────────────────────────────┘  └────────────────┘  │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Tauri Sidecar: quark-server (Bun --compile)                     │ │
│  │  REST API + WebSocket on localhost:$PORT                         │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## Key Decisions

### 1. Sidecar, not embedded

Quark core is compiled with `bun --compile` into a standalone binary and
configured as a Tauri `externalBin`. Tauri starts the sidecar on app launch,
waits for `/api/health`, then passes the backend URL to the React frontend.

**Why**: The Quark core (Bun + TypeScript) does not run inside Tauri's Rust
runtime. Sidecar is the blessed Tauri pattern for bundling non-Rust servers.

### 2. Existing web UI preserved

The right pane reuses the existing React SPA from `src/web/client/`. No
redesign of chat components — they connect to the sidecar exactly as they
connect to the web server today.

### 3. Three diff actions, not two

| Action | Behavior |
|--------|----------|
| **Approve once** | Calls `POST /api/permission { reply: "once" }`. Tool executes. |
| **Always approve** | Calls `POST /api/permission { reply: "always" }`. Creates session-scope allow rule. Tool executes. |
| **Reject** | Calls `POST /api/permission { reply: "reject" }`. Tool blocked. |
| **Reject + correct** | Calls `POST /api/permission { reply: "correct", correction: "..." }`. Model receives feedback. |

### 4. Middle pane modes

| Mode | Trigger | Content |
|------|---------|---------|
| **Diff Review** | `tool-input` with `diff` metadata on `edit`/`write` tools | Unified diff with // approve / reject||correct actions |
| **Source** | File tree selection | CodeMirror editor, read-only or draft-editable |
| **Preview** | HTML file selected or after file write | Sandboxed `<iframe>` showing rendered HTML |

### 5. Draft state is ephemeral

Human edits in the source pane are held in desktop React state — not written
to disk. Disk changes happen only through:
- Explicit human "Save" action (`POST /api/workspace/file`)
- Agent tool execution after approval

When sending a chat prompt, the desktop includes active draft/diff context
via the new `context` field on `POST /api/prompt`.

## API Extensions

### `POST /api/prompt` — new `context` field

```json
{
  "text": "user message",
  "sessionId": "...",
  "images": [],
  "context": "User has the following file open in the desktop editor: src/foo.ts\nCurrent draft diff: ..."
}
```

The backend prepends `context` as an extra system-level message part before
the user text, so the agent is aware of what the user is looking at.

### `GET /api/workspace/file?path=...`

Returns `{ content, mtime, size }` for a file in the project workspace.

### `POST /api/workspace/file`

Body: `{ path, content }`. Writes explicit human saves to disk.

## Desktop React State

```ts
interface DesktopState {
  activeFile: string | null
  activeDraft: string | null           // unsaved editor content
  activeView: "diff" | "source" | "preview"
  activeReview: {
    messageId: string
    callId: string
    tool: string                       // "edit" | "write"
    filePath: string
    diff: string                       // unified diff from tool-input
    input: Record<string, unknown>     // raw tool args
    permissionRequestId: string
  } | null
}
```

## Diff Workflow (End-to-End)

```
1. User sends chat prompt
2. Agent proposes edit via edit() / write() tool call
3. Backend emits "tool-input" with { tool, args, metadata: { diff, filePath } }
4. Desktop WebSocket receives event → sets activeReview, switches middle pane
   to "diff" mode
5. User reviews diff in middle pane:
   a. Clicks [Approve] → POST /api/permission { reply: "once", requestId }
   b. Clicks [Always] → POST /api/permission { reply: "always", requestId }
   c. Clicks [Reject] → POST /api/permission { reply: "reject", requestId }
   d. Edits diff + clicks [Correct] → POST /api/permission
      { reply: "correct", requestId, correction: "..." }
6. Permission resolved:
   - Approved → tool executes, file is written
   - Rejected → tool blocked, agent may retry
7. Backend emits "tool-end" with result
8. Desktop reloads file content and HTML preview (if applicable)
```

## File Structure (new)

```
quark-desktop/
  package.json              # React + Vite + Tauri deps
  vite.config.ts
  tsconfig.json
  index.html                # Vite entry point
  src/
    App.tsx                 # Three-pane layout shell
    state.ts                # DesktopState + WebSocket event handlers
    api.ts                  # REST API client (reuses web client patterns)
    components/
      LeftPane.tsx          # File tree + commands
      MiddlePane.tsx        # Mode switcher: DiffReview / Source / Preview
      DiffReview.tsx        # Unified diff + approve/reject actions
      SourceEditor.tsx      # CodeMirror wrapper
      HtmlPreview.tsx       # Sandboxed iframe
      RightPane.tsx         # Chat panel (wraps existing web client)
    chat/                   # Symlink or copy of src/web/client/ components
  src-tauri/
    Cargo.toml
    tauri.conf.json         # externalBin: quark-server
    src/
      main.rs               # Spawns sidecar, waits for health, opens window
    binaries/               # quark-server binary (Bun --compile output)
  scripts/
    build-sidecar.sh        # Compiles Quark core with Bun --compile
```

## Test Plan

### Backend
- `/api/prompt` includes `context` in submitted message parts
- `GET /api/workspace/file?path=...` reads real temp files
- `POST /api/workspace/file` writes and verifies content on disk
- `tool-input` diff metadata survives the bus → WebSocket round-trip
- Permission `reply: "correct"` with `correction` delivers feedback to model

### Desktop React
- `tool-input` with diff opens middle pane in DiffReview mode
- Approve/Reject/Correct actions call `/api/permission` with correct payloads
- `tool-end` reloads source and preview after successful write
- File tree click loads file into SourceEditor
- HTML file selection renders in HtmlPreview iframe
- Chat panel sends/receives messages through WebSocket

### Manual (macOS)
- Tauri app starts sidecar, health check passes, window opens
- Chat works end-to-end through REST/WebSocket
- Agent edit shows middle-pane diff before write
- Approve writes file; reject blocks it
- Existing web server (`bun run src/web/server.ts`) still works unchanged

## Assumptions & V1 Scope Boundaries

- **macOS first** — Windows/Linux packaging deferred to V2
- **CodeMirror** is the V1 editor component
- **File source is canonical** — desktop draft state is temporary context only
- **No drag-to-source visual editing yet** — V1 is keyboard + button driven
- **HTML preview only** — TeX, Mermaid, SVG, Markdown previews deferred to V2
- **Tauri setup** follows official guides:
  - [Create a Project](https://v2.tauri.app/start/create-project/)
  - [Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)
- **Existing `quark-desktop/` prototype** (see [Existing Prototype](#existing-prototype-quark-desktop) above) is
  replaced entirely by the Tauri + React scaffold
- **Branch**: all work happens on `codex/quark-desktop-tauri`

## References

- [Tauri 2 Documentation](https://v2.tauri.app/)
- [Tauri Sidecar Guide](https://v2.tauri.app/develop/sidecar/)
- [Bun Compile](https://bun.sh/docs/bundler/executables)
- [CodeMirror 6](https://codemirror.net/)
- [specs/permission-diff-preview.md](../core/permission-diff-preview.md) — existing
  diff preview work that feeds into the desktop diff review pane
- [specs/epics.json](../foundation/epics.json) — EPIC-17
- [`quark-desktop/index.html`](../quark-desktop/index.html) — existing three-pane prototype
- [`quark-desktop/styles.css`](../quark-desktop/styles.css) — existing layout + card styles
- [`quark-desktop/script.js`](../quark-desktop/script.js) — existing ModeSwitch + Omnibar
