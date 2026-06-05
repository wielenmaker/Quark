---
title: EPIC-17 Implementation Task Breakdown
date_created: 2026-05-06
date_modified: 2026-05-06
revision: 5
history:
  - 2026-05-06: Initial atomic task breakdown from oracle analysis + manual completion
  - 2026-05-06: Corrected Phase 0 parallelism
  - 2026-05-06: Phase 0 complete — all 6 tasks verified
  - 2026-05-06: Phase 1 complete — 6 tasks in 3 rounds
  - 2026-05-06: Phase 2-5 complete — all 22 tasks done, 21 tests passing
status: done
---

# EPIC-17: Quark Desktop V1 — Atomic Task Breakdown

## Dependency Graph

```
Phase 0 (Backend — blocks all desktop work)
  ┌── parallel (different files) ──┐    ┌── sequential (same file: src/web/server.ts) ──┐
  │                                │    │                                                │
  T0.0                          T0.1    T0.2 ──→ T0.3 ──→ T0.4 ──→ T0.5
  archive prototype        sidecar    GET file   POST file  context    tree
  (quark-desktop/)         script
     │                        │         │          │         │         │
     └────────┬───────────────┘         │          │         │         │
              └── round 1 ─────────────┘          │         │         │
              (2 agents, done in parallel)         │         │         │
                                                   └── round 2 ─────────┘
                                                   (1 agent, sequential in one pass)
                                                      │
Phase 1 (Tauri + Layout Shell)                        │
  T1.1 ────── T1.2 ────── T1.3 ──────────────────────┤              │
  │            │                                       │              │
  T1.4 ────────┼── T1.5 (needs T0.5) ─────────────────┤              │
  │            └── T1.6 (needs T0.4) ─────────────────┤              │
  │                                                    │              │
Phase 2 (Middle Pane Modes)                            │              │
  T2.1 (needs T0.2, T1.4) ────────────────────────────┤              │
  T2.2 (needs T0.2, T1.4) ────────────────────────────┤              │
  T2.3 (needs T2.1, T2.2, T1.5) ──────────────────────┤              │
                                                       │              │
Phase 3 (Desktop State + Diff Review)                  │              │
  T3.1 (needs T1.4) ──────────────────────────────────┤              │
  T3.2 (needs T3.1) ──────────────────────────────────┤              │
  T3.3 (needs T3.2) ──────────────────────────────────┤              │
  T3.4 (needs T3.3, T2.3) ────────────────────────────┤              │
  T3.5 (needs T3.4) ──────────────────────────────────┤              │
  T3.6 (needs T3.3, T2.1, T2.2) ──────────────────────┤              │
                                                       │              │
Phase 4 (Context Passing)                              │              │
  T4.1 (needs T3.1, T1.5, T2.1) ──────────────────────┤              │
  T4.2 (needs T0.4, T4.1) ────────────────────────────┤              │
                                                       │              │
Phase 5 (Integration + Validation)                     │              │
  T5.1 (needs T0.2, T0.3, T0.4, T0.5) ────────────────┤              │
  T5.2 (needs ALL) ────────────────────────────────────┤              │
  T5.3 (needs ALL) ────────────────────────────────────┤              │
  T5.4 (needs ALL) ────────────────────────────────────┘              │
```

---

## Phase 0: Backend Foundation (No Desktop Code)

**Parallelism:**
- **Round 1 (parallel)**: T0.0 + T0.1 — touch completely different files (no conflicts)
- **Round 2 (sequential)**: T0.2 → T0.3 → T0.4 → T0.5 — all edit `src/web/server.ts`; one agent does them in a single pass to avoid merge conflicts

### T0.0 — Archive the existing static prototype

**Maps to**: US-17-2 (prep), US-17-8 (preserve reference)

**Work**:
- `mv quark-desktop quark-desktop-prototype`
- `mkdir quark-desktop && touch quark-desktop/.gitkeep`
- The prototype stays as UX reference

**Verify**:
- `ls quark-desktop-prototype/index.html` exists
- `quark-desktop/` is empty (only `.gitkeep`)

**Effort**: S

---

### T0.1 — Build sidecar binary script + Bun compile config

**Maps to**: US-17-1

**Work**:
- Create `quark-desktop/scripts/build-sidecar.sh`
- Build command: `bun build --compile src/web/index.ts --outfile quark-desktop/src-tauri/binaries/quark-server-aarch64-apple-darwin`
- Create `quark-desktop/src-tauri/binaries/.gitkeep`
- The binary reads `QUARK_WEB_PORT` env var for port

**Verify**:
- `bash quark-desktop/scripts/build-sidecar.sh` produces a binary
- `./quark-desktop/src-tauri/binaries/quark-server-aarch64-apple-darwin & sleep 2; curl -s http://localhost:3000/api/health` returns `{"status":"ok"}`
- Kill the background process

**Effort**: S

---

### T0.2 — Add `GET /api/workspace/file` endpoint

**Maps to**: US-17-6

**Work** — in `src/web/server.ts`:
- Add handler for `GET /api/workspace/file?path=...`
- Resolve path relative to `process.cwd()`
- Validate path is within workspace (reject `../` escapes with 403)
- Return `{ content, mtime, size }` or 404

**Verify**:
- `curl "http://localhost:3000/api/workspace/file?path=package.json"` → content + metadata
- `curl "http://localhost:3000/api/workspace/file?path=../etc/passwd"` → 403
- `curl "http://localhost:3000/api/workspace/file?path=nonexistent.txt"` → 404

**Effort**: S

---

### T0.3 — Add `POST /api/workspace/file` endpoint

**Maps to**: US-17-6

**Work** — in `src/web/server.ts`:
- Add handler for `POST /api/workspace/file` with body `{ path, content }`
- Validate path is within workspace
- Create parent directories if needed
- Write content to disk, return `{ ok: true }`

**Verify**:
- `curl -X POST ... -d '{"path":"test-output.txt","content":"hello"}'` → `{"ok":true}`
- `curl "http://localhost:3000/api/workspace/file?path=test-output.txt"` → content matches
- Path escape attempt → 403
- Clean up test file

**Effort**: S

---

### T0.4 — Add `context` field support to `POST /api/prompt`

**Maps to**: US-17-7

**Work** — in `src/web/server.ts`:
- Extend `POST /api/prompt` body type to include optional `context?: string`
- When `context` is present, prepend `[Desktop context]\n{context}` as an extra text part before the user message
- Existing `context`-less prompts work unchanged

**Verify**:
- `curl -X POST /api/prompt -d '{"text":"hello","context":"Active file: src/foo.ts"}'` → session created, first message includes `[Desktop context]` prefix
- `curl -X POST /api/prompt -d '{"text":"hello"}'` → works exactly as before
- On-disk session log shows the context part

**Effort**: S

---

### T0.5 — Add `GET /api/workspace/tree` endpoint

**Maps to**: US-17-4 (file tree needs full file listing)

**Work** — in `src/web/server.ts`:
- Add handler for `GET /api/workspace/tree`
- Uses existing `getFiles()` from `src/tui/filelist` (already imported in server.ts)
- Returns `{ files: string[] }` (flat list with directories marked by trailing `/`)

**Verify**:
- `curl http://localhost:3000/api/workspace/tree` → `{ files: [...] }`
- Response includes both files and directories
- Matches what the existing TUI file list produces

**Effort**: S

---

## Phase 1: Tauri Shell + Three-Pane Layout

Must be done sequentially within this phase: T1.1 → T1.2 → T1.3. T1.4–T1.6 depend on T1.1 only.

### T1.1 — Scaffold Tauri 2 + React + Vite project in `quark-desktop/`

**Maps to**: US-17-1, US-17-2

**Work** — manually scaffold:

1. **`quark-desktop/package.json`** — React 19, Vite 6, Tauri 2 deps
2. **`quark-desktop/vite.config.ts`** — React plugin, `@web` alias to `../src/web/client`
3. **`quark-desktop/tsconfig.json`** — bundler mode, paths alias
4. **`quark-desktop/index.html`** — Vite entry with `#root` div
5. **`quark-desktop/src/main.tsx`** — `createRoot` + render `<App />`
6. **`quark-desktop/src/App.tsx`** — minimal "Quark Desktop" placeholder
7. **`quark-desktop/src-tauri/Cargo.toml`** — tauri + tauri-plugin-shell
8. **`quark-desktop/src-tauri/build.rs`** — `tauri_build::build()`
9. **`quark-desktop/src-tauri/tauri.conf.json`** — window 1400×900, devUrl localhost:1420
10. **`quark-desktop/src-tauri/src/main.rs`** — minimal stub

**Verify**:
- `cd quark-desktop && npm install` succeeds
- `npm run dev` shows "Quark Desktop" at localhost:1420
- `npm run tauri dev` opens native macOS window with same content

**Effort**: M

---

### T1.2 — Configure Tauri sidecar in `tauri.conf.json`

**Maps to**: US-17-1

**Work** — update `src-tauri/tauri.conf.json`:
- Add `bundle.externalBin: ["binaries/quark-server"]` 
- Tauri appends target triple at runtime (`-aarch64-apple-darwin`)
- Add placeholder icons in `src-tauri/icons/`

**Verify**:
- `npm run tauri build -- --debug` compiles (binary may not exist yet — that's ok)
- Sidecar path is correctly referenced in the config

**Effort**: S

---

### T1.3 — Implement sidecar spawn + health poll in `main.rs`

**Maps to**: US-17-1

**Work** — in `src-tauri/src/main.rs`:
- Use `app.shell().sidecar("quark-server")` to spawn the sidecar
- Set `QUARK_WEB_PORT` env var to a fixed port (3001)
- Spawn with `.env("QUARK_WEB_PORT", "3001").spawn()`
- Store child process handle for cleanup on app quit
- Spawn background task to read sidecar stderr
- Expose `get_backend_url` Tauri command returning `http://localhost:3001`
- Register the command in `invoke_handler`

**Runtime flow**:
1. Tauri starts → spawns sidecar
2. React frontend loads → polls `GET /api/health` until 200
3. Backend URL exposed via `invoke("get_backend_url")`

**Verify**:
- `npm run tauri dev` opens window
- React receives backend URL via Tauri invoke
- `/api/health` returns 200 from the sidecar
- Quit app → sidecar process is killed

**Effort**: M–L

---

### T1.4 — Three-pane resizable layout shell

**Maps to**: US-17-2

**Work** — `App.tsx` + `App.css`:
- CSS Grid layout: `[left] 4px [middle] 4px [right]`
- Drag handles between panes (col-resize cursor)
- Design tokens: dark theme matching prototype (`--bg`, `--bg-sidebar`, `--border`, `--accent`, `--text`)
- Min-width constraints: middle 300px, right 320px

**Verify**:
- Three panes visible: left, middle, right
- Dragging handles resizes adjacent panes
- Layout fills full viewport height
- Dark theme applied

**Effort**: M

---

### T1.5 — Left pane: File tree component

**Maps to**: US-17-4

**Work** — `src/components/LeftPane.tsx`:
1. Fetch `GET /api/workspace/tree` on mount
2. Build tree structure from flat file list
3. Recursive render with expand/collapse, file/folder icons
4. Click handler emits file path to parent (for middle pane integration)

**Type**:
```ts
interface FileNode {
  name: string; path: string; isDir: boolean
  children: FileNode[]; expanded: boolean
}
```

**Verify**:
- Left pane shows real project file tree from workspace
- Directories expand/collapse on click
- Clicking a file logs the path (integration tested in T2.3)
- `node_modules` and `.git` handled gracefully (collapsed by default)

**Effort**: M

---

### T1.6 — Right pane: Chat component (reuse web client + WebSocket)

**Maps to**: US-17-2 (chat pane)

**Work** — `src/components/RightPane.tsx`:

1. **Establish WebSocket** to sidecar `ws://localhost:{port}/ws`
2. **Handle all WS events** (modeled after `src/web/client/app.tsx`)
3. **Manage chat state** with `useReducer` (messages, sessionId, running, connected)
4. **Render message list** using shared `MessageItem` component from `@web/components/message-item`
5. **Render input area** using shared `InputArea` from `@web/components/input-area`
6. **Shared component imports** via `@web` Vite alias:
   - `@web/api` — `api()` fetch helper
   - `@web/components/message-item` — MessageItem
   - `@web/components/tool-call` — ToolCall
   - `@web/components/input-area` — InputArea
   - `@web/components/thinking` — Thinking
   - `@web/components/rich-text` — RichText
   - `@web/components/typing-indicator` — TypingIndicator

**Architecture**: RightPane owns chat state independently from DesktopState. DesktopState tracks workspace concerns (activeFile, activeView, activeReview).

**Verify**:
- Right pane shows chat input + Quark header
- Type message + Enter → sends via `POST /api/prompt`
- Agent responses stream in via WebSocket (text, tools)
- Chat experience matches existing web UI
- Existing web UI at `http://localhost:3000` still works unchanged

**Effort**: L (most complex task)

---

## Phase 2: Middle Pane Modes

### T2.1 — Source editor (CodeMirror 6) component

**Maps to**: US-17-4

**Work** — `src/components/SourceEditor.tsx`:

1. Install deps: `codemirror`, `@codemirror/view`, `@codemirror/state`, language packs, `@codemirror/theme-one-dark`
2. **Props**: `filePath: string | null`, `onDraftChange?: (content: string) => void`
3. **On `filePath` change**: fetch via `GET /api/workspace/file`, load into CodeMirror
4. **On user edit**: debounced `onDraftChange` callback
5. **Syntax highlighting**: auto-detect from file extension (ts, js, json, md, html, css)
6. **Save button**: calls `POST /api/workspace/file` with edited content

**Verify**:
- Pass file path → editor shows content with syntax highlighting
- Edit text → draft content accessible via callback
- Save → file written to disk → re-fetch confirms
- Pass `null` → empty state

**Effort**: M

---

### T2.2 — HTML preview pane component

**Maps to**: US-17-5

**Work** — `src/components/HtmlPreview.tsx`:

1. **Props**: `filePath: string | null`, `refreshKey: number`
2. **On mount/change**: fetch HTML content via `GET /api/workspace/file`
3. **Render**: sandboxed `<iframe>` with `srcdoc` attribute
4. **Sandbox**: `sandbox="allow-scripts"`
5. **Reload**: when `refreshKey` increments, re-fetch and re-render

**Verify**:
- Select HTML file → iframe renders the page
- Non-HTML file → "Preview not available" message
- Increment refreshKey → iframe reloads with updated content

**Effort**: S

---

### T2.3 — MiddlePane mode switcher + integration

**Maps to**: US-17-2, US-17-3, US-17-4, US-17-5

**Work** — `src/components/MiddlePane.tsx`:

1. **Props**: `activeView`, `activeFile`, `activeReview`, callbacks
2. **Render switch**:
   - `"source"` → `<SourceEditor filePath={activeFile} />`
   - `"preview"` → `<HtmlPreview filePath={activeFile} refreshKey={...} />`
   - `"diff"` → `<DiffReview review={activeReview} />`
3. **Mode tabs**: Source / Preview / Diff — styled segment buttons
4. **Empty state**: when no file selected and no review active

**Verify**:
- Click file in left pane → middle shows source editor
- Switch to Preview tab with HTML file → shows rendered preview
- Mode tabs highlight active mode
- No file selected → shows empty state

**Effort**: M

---

## Phase 3: Desktop State + Diff Review Workflow

Core V1 proof. Must be done sequentially T3.1 → T3.2 → T3.3 → T3.4 → T3.5 → T3.6.

### T3.1 — Desktop state: `DesktopState` + reducer

**Maps to**: US-17-3, US-17-4

**Work** — `src/state.ts`:

```ts
interface ActiveReview {
  messageId: string
  callId: string
  tool: string           // "edit" | "write"
  filePath: string
  diff: string           // unified diff text
  input: Record<string, unknown>
  permissionRequestId: string
}

interface DesktopState {
  activeFile: string | null
  activeDraft: string | null
  activeView: "diff" | "source" | "preview"
  activeReview: ActiveReview | null
  previewRefreshKey: number
}
```

Reducer actions: `SELECT_FILE`, `SET_DRAFT`, `SET_VIEW`, `SHOW_DIFF`, `CLEAR_REVIEW`, `REFRESH_PREVIEW`

**Verify** — unit test:
- `SELECT_FILE` → sets activeFile, switches to source view
- `SHOW_DIFF` → sets activeReview, switches to diff view
- `CLEAR_REVIEW` → clears review, keeps file selected
- `REFRESH_PREVIEW` → increments refreshKey

**Effort**: S

---

### T3.2 — Backend URL provider + initial connection

**Maps to**: US-17-1 (frontend↔sidecar connection)

**Work** — `src/backend.ts`:

1. Call Tauri `invoke("get_backend_url")` or fallback to `http://localhost:3001`
2. Poll `GET /api/health` every 1s up to 30s
3. Export `getBackendUrl()` and `apiUrl(path)` helpers

**Verify**:
- `npm run tauri dev` → app shows "Connected" after health check
- Without sidecar → shows "Connecting..." then error after 30s

**Effort**: S

---

### T3.3 — Wire WebSocket events to DesktopState

**Maps to**: US-17-3 (diff review interception)

**Work** — `src/useDesktopEvents.ts` hook:

The RightPane already owns a WebSocket connection for chat events. `App.tsx` bridges between chat events and desktop state:

Event → action mapping:
- `tool-input` with `tool === "edit" || tool === "write"` and `metadata.diff` → dispatch `SHOW_DIFF`
- `permission-request` → correlate with activeReview, store `permissionRequestId`
- `tool-end` when `callId === activeReview.callId` → dispatch `CLEAR_REVIEW` + `REFRESH_PREVIEW`

**Verify**:
- Simulate `tool-input` WS event → middle pane switches to diff view
- Simulate `tool-end` → review cleared, preview refresh key increments

**Effort**: M

---

### T3.4 — DiffReview component

**Maps to**: US-17-3

**Work** — `src/components/DiffReview.tsx`:

1. **Props**: `review: ActiveReview`, `onApprove`, `onAlways`, `onReject`, `onCorrect`
2. **Render unified diff**: parse diff string, color lines (red for `-`, green for `+`, neutral for context)
3. **File path** displayed prominently
4. **Action buttons**: Approve (green), Always (blue), Reject (red), Correct (inline textarea + Send)
5. **Keyboard shortcuts**: `a` = approve, `A` = always, `r` = reject
6. **Correct mode**: editable textarea with the corrected code, Send button calls `onCorrect(text)`

**Verify**:
- Pass mock review → renders colored unified diff
- Click Approve → `onApprove` called
- Click Reject → `onReject` called
- Click Correct, type text, Send → `onCorrect` called with typed text
- Keyboard shortcuts work

**Effort**: M

---

### T3.5 — Wire Approve/Reject/Correct actions to `/api/permission`

**Maps to**: US-17-3

**Work** — in DiffReview callbacks:

```ts
// approve once
api("POST", "/api/permission", { sessionId, requestId, action: "once" })

// always approve  
api("POST", "/api/permission", { sessionId, requestId, action: "always" })

// reject
api("POST", "/api/permission", { sessionId, requestId, action: "reject" })

// correct (reject with feedback)
api("POST", "/api/permission", { sessionId, requestId, action: "reject", correction: userEditedText })
```

The `api()` helper is shared from `@web/api`. `sessionId` comes from RightPane chat state.

**Verify** — manual integration test:
1. Send prompt: "edit the README.md to add a title"
2. Agent proposes edit → diff appears in middle pane
3. Click Approve → tool executes, file written
4. Reject → tool blocked, agent can retry
5. Correct with feedback → agent receives correction

**Effort**: S

---

### T3.6 — Tool-end → reload source + preview

**Maps to**: US-17-3, US-17-4, US-17-5

**Work** — in `tool-end` event handler:
1. Dispatch `CLEAR_REVIEW`
2. If `activeFile` matches the edited file → re-fetch via `GET /api/workspace/file` → update source editor
3. Dispatch `REFRESH_PREVIEW`

**Verify**:
- After approving edit to `styles.css` → source editor reloads with new content
- After approving edit to `index.html` → HTML preview refreshes

**Effort**: S

---

## Phase 4: Context Passing

### T4.1 — Build context string from DesktopState

**Maps to**: US-17-7

**Work** — in `App.tsx`, build a context string before each prompt:

```ts
function buildContext(state: DesktopState): string | undefined {
  const parts: string[] = []
  if (state.activeFile) {
    parts.push(`Active file: ${state.activeFile}`)
    parts.push(`Active view: ${state.activeView}`)
  }
  if (state.activeDraft) {
    parts.push(`Unsaved draft in editor:\n\`\`\`\n${state.activeDraft}\n\`\`\``)
  }
  return parts.length > 0 ? parts.join("\n") : undefined
}
```

**Verify**:
- Select a file → open browser console → context includes file path
- Make unsaved edit → context includes draft content
- No file selected → context is `undefined` (not sent)

**Effort**: S

---

### T4.2 — Inject context into `POST /api/prompt`

**Maps to**: US-17-7

**Work** — in the chat send flow:
1. Before calling `POST /api/prompt`, compute `buildContext(desktopState)`
2. If context exists, include it in the request body
3. Backend (T0.4) prepends `[Desktop context]` prefix before the user message

**Verify**:
- Send a chat message while a file is selected → check session log → context is in the first message part
- Send without file selected → no context in the request → old behavior preserved

**Effort**: S

---

## Phase 5: Integration Testing + Validation

### T5.1 — Backend: API endpoint integration tests

**Maps to**: US-17-6, US-17-7, US-17-8

**Work** — `test/desktop-api.test.ts`:

1. Start the web server on a random port
2. Test `GET /api/workspace/file`:
   - Valid path → returns content + metadata
   - Non-existent → 404
   - Path escape → 403
3. Test `POST /api/workspace/file`:
   - Valid path → writes file, returns `{ ok: true }`
   - Verify content on disk
   - Path escape → 403
4. Test `GET /api/workspace/tree`:
   - Returns file listing
5. Test `POST /api/prompt` with `context`:
   - Context appears in submitted message parts
   - Without context → works unchanged
6. Test existing endpoints unaffected:
   - `GET /api/health` → 200
   - `GET /api/sessions` → 200
   - `POST /api/prompt` (basic) → creates session

**Verify**: All tests pass with `bun test test/desktop-api.test.ts`

**Effort**: M

---

### T5.2 — Desktop: React component tests

**Maps to**: US-17-3, US-17-4, US-17-5

**Work** — `quark-desktop/src/__tests__/`:

1. **DiffReview.test.tsx**:
   - Renders unified diff with colored lines
   - Approve/Always/Reject buttons call callbacks
   - Correct mode shows textarea + sends correction
2. **DesktopState.test.ts** (if not done in T3.1):
   - State transitions for all reducer actions
3. **SourceEditor.test.tsx**:
   - Renders CodeMirror with content
   - Draft changes fire callback
4. **HtmlPreview.test.tsx**:
   - Renders iframe with srcdoc
   - Refreshes on refreshKey change

Uses `vitest` + `@testing-library/react`.

**Verify**: All tests pass with `cd quark-desktop && npx vitest run`

**Effort**: M

---

### T5.3 — End-to-end: Diff review loop (manual)

**Maps to**: US-17-3

**Manual test script**:

1. Start the desktop app (`npm run tauri dev`)
2. Open a project directory in the workspace
3. Send prompt: "add a comment to the top of package.json explaining the project"
4. **Verify**: agent proposes `edit()` tool call
5. **Verify**: middle pane switches to DiffReview, showing the diff
6. Click Approve → **Verify**: tool executes, package.json is updated
7. Click file in left pane → **Verify**: source editor shows updated content
8. Send prompt: "revert that change"
9. When diff appears, click Reject → **Verify**: tool is blocked, file unchanged

**Verify**: All steps pass in the manual test session

**Effort**: S (scripted, not automated)

---

### T5.4 — Regression: Existing web UI still works

**Maps to**: US-17-8

**Work**:
1. `bun run src/web/server.ts` starts and serves web UI on port 3000
2. Open `http://localhost:3000` in browser
3. Full chat flow works (send message, receive response, tool calls rendered)
4. WebSocket events work (text streaming, tool lifecycle)
5. Permission dialog works (approve/reject)
6. All existing web tests pass (`bun test`)

**Verify**: Zero regressions in the existing web UI

**Effort**: S

---

## Task Summary by User Story

| User Story | Tasks |
|---|---|
| US-17-1: Tauri shell + sidecar startup | T0.1, T1.1, T1.2, T1.3, T3.2 |
| US-17-2: Three-pane layout shell | T0.0, T1.1, T1.4, T1.6, T2.3 |
| US-17-3: Diff review workflow | T3.1, T3.3, T3.4, T3.5, T3.6, T5.3 |
| US-17-4: Source editor + file tree | T0.5, T1.5, T2.1, T2.3 |
| US-17-5: HTML preview pane | T2.2 |
| US-17-6: Workspace file API | T0.2, T0.3, T5.1 |
| US-17-7: Chat context passing | T0.4, T4.1, T4.2 |
| US-17-8: Web UI preserved | T0.0, T5.1, T5.4 |

## Effort Estimates

| Size | Count | Tasks |
|---|---|---|
| S (Small) | 12 | T0.0–T0.5, T1.2, T2.2, T3.1, T3.2, T3.5, T3.6, T4.1, T4.2, T5.3, T5.4 |
| M (Medium) | 8 | T1.1, T1.4, T1.5, T2.1, T2.3, T3.3, T3.4, T5.1, T5.2 |
| L (Large) | 2 | T1.3, T1.6 |
| **Total** | **22** | |

## Recommended Implementation Order

1. **Phase 0 first** (T0.0–T0.5, parallelizable) — unblocks everything
2. **T1.1–T1.3** (Tauri scaffold) — get window + sidecar working
3. **T1.4 + T1.5 + T1.6** (Layout + panes) — visual shell complete
4. **T2.1 + T2.2 + T2.3** (Middle pane modes) — workspace functional
5. **T3.1–T3.6** (Diff review loop) — core V1 proof
6. **T4.1 + T4.2** (Context passing) — quality-of-life
7. **T5.1–T5.4** (Validation) — confidence before merge
