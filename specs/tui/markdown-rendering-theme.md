---
title: "Markdown Rendering & Theme Scope Alignment"
date_created: 2026-05-28
date_modified: 2026-06-04
revision: 9
history:
  - 2026-05-28: Initial spec — investigation of TUI markdown rendering, scope-name bug fix, and Atom One palette swap plan
  - 2026-05-28: Applied steps 3–5 — italic foreground, strikethrough/link/quote scopes registered, markdown palette swapped to Atom One Dark/Light in both theme files
  - 2026-05-28: Cross-checked OpenTUI GitHub source; block headings are supported via explicit markup.heading.1-6 scopes
  - 2026-05-28: Enabled markdown concealment for assistant messages so rendered output hides source markers
  - 2026-05-28: Switched assistant output to Neovim-style markdown source rendering with structural markers preserved
  - 2026-05-28: Added Quark-side inline delimiter concealment so bold/italic/code/link markers disappear reliably
  - 2026-05-28: Aligned concealment target with hidden heading markers while keeping inline delimiter concealment
  - 2026-05-28: Changed dark-theme bold markdown color to #E5C07B
  - 2026-06-04: Switched assistant-message rendering from `<code filetype="markdown">` to `<markdown>` so tables render as structured TextTables; updated tests and validation asset
status: in-progress
---

# Markdown Rendering & Theme Scope Alignment

## Problem

Quark's TUI renders assistant messages through OpenTUI's markdown tree-sitter highlighting
(see [src/tui/components/assistant-message.tsx](../src/tui/components/assistant-message.tsx)).
The active syntax theme is wired in via `SyntaxStyle.fromTheme()` from
[src/tui/theme.ts](../src/tui/theme.ts), which rebuilds on `applyTheme()` swaps.

Visually, only `**bold**` showed color in assistant output. Headings, italic,
inline code, strikethrough, and links all rendered as plain default-color text,
even though several of those scopes appeared in the theme syntax arrays.

Goal: identify the cause, fix what can be fixed at the theme layer, and align
Quark's markdown palette with Atom One Dark / Light.

## Investigation

### 1. OpenTUI does support themes

`SyntaxStyle.fromTheme(theme.syntax)` accepts the exact `{ scope: string[], style }`
shape Quark already uses. No OpenTUI API changes needed; only the per-scope
entries in [src/tui/themes/dark.ts](../src/tui/themes/dark.ts) and
[src/tui/themes/light.ts](../src/tui/themes/light.ts) drive markdown styling.

### 2. Scopes OpenTUI actually emits

Grep on `node_modules/@opentui/core/index.js` confirms the markdown renderable
emits these scopes from `renderInlineToken`:

| Scope | Source |
|---|---|
| `markup.strong` | `**bold**` (note: NOT `markup.bold`) |
| `markup.italic` | `*italic*` |
| `markup.raw` | `` `inline` `` and codespans (note: NOT `markup.inline.raw`) |
| `markup.strikethrough` | `~~strike~~` |
| `markup.link`, `markup.link.label`, `markup.link.url` | `[label](url)` |
| `markup.heading` | table header cells |

The cached OpenTUI GitHub checkout lives at
`references-cache/opentui-source` (ignored by git). It points to
`https://github.com/anomalyco/opentui` at commit `db12ee3`, package version
`0.2.16`. Current npm latest is also `0.2.16`; Quark is installed on
`@opentui/core@0.1.86` / `@opentui/solid@0.1.86`.

The upstream source also includes tree-sitter markdown query scopes:

| Scope | Source |
|---|---|
| `markup.heading.1` through `markup.heading.6` | ATX/setext block headings |
| `markup.heading` | table header cells |
| `markup.list` | list markers |
| `markup.raw.block` | fenced/indented code blocks |

### 3. Theme/scope mismatches that broke styling

| Quark theme scope | OpenTUI scope | Result |
|---|---|---|
| `markup.bold`, `markup.strong` | `markup.strong` | ✅ matched → bold colored |
| `markup.italic` (style: `italic: true` only, no `foreground`) | `markup.italic` | ⚠ matched but no color set |
| `markup.inline.raw` | `markup.raw` | ❌ scope-name mismatch — inline code uncolored |
| (no `markup.strikethrough`) | `markup.strikethrough` | ❌ unregistered |
| (no `markup.link*`) | `markup.link*` | ❌ unregistered |
| `markup.heading` only | `markup.heading.1`-`markup.heading.6` | ❌ no partial fallback — headings uncolored |

### 4. Heading rendering — supported, but scope-specific

OpenTUI renders ordinary markdown blocks, including headings, through a
markdown `CodeRenderable` with `filetype: "markdown"` and the active
`syntaxStyle`:

```diagram
╭──────────────────╮   tokens   ╭────────────────────────╮
│ marked parser    │───────────▶│ buildRenderableTokens  │
╰──────────────────╯            ╰───────────┬────────────╯
                                            │
              ┌─────────────────────────────┴─────────────────────┐
              ▼                                                   ▼
  shouldRenderSeparately:                              all other tokens
  code | table | blockquote               (headings, paragraphs, lists, …)
              │                                                   │
              ▼                                                   ▼
   own renderable (code block,                  concatenated raw text into a
   table, blockquote block)                     synthetic "paragraph" block
                                                          │
                                                          ▼
                                       createMarkdownCodeRenderable
                                       filetype: "markdown"
                                       syntaxStyle: Quark theme
                                                          │
                                                          ▼
                                       tree-sitter markdown scopes
                                       markup.heading.1-6
```

Consequences:
- `# heading`, `## heading`, `### heading` can be styled via the theme.
- Quark must register `markup.heading.1` through `markup.heading.6` explicitly.
  `SyntaxStyle.getStyle("markup.heading.1")` falls back only to `markup`, not
  to `markup.heading`.
- `markup.heading` still matters for table header cells.
- `renderNode` remains useful for custom heading layout/renderables, but it is
  not required just to color headings.

Verification commands used:

```
npm view @opentui/core version repository.url --json
bun -e 'import { SyntaxStyle } from "@opentui/core"; const s=SyntaxStyle.fromTheme([{scope:["markup.heading"],style:{foreground:"#ff0000",bold:true}}]); console.log(s.getStyle("markup.heading.1"))'
```

## Decisions

1. **Fix scope name `markup.inline.raw` → `markup.raw`** in both theme files.
   Register both names side-by-side for forward-compat with the canonical
   TextMate convention. — ✅ done (revision 1)
2. **Add `foreground` to `markup.italic`** so italic text has color, not just
   slant. (Atom uses purple.)
3. **Register the missing scopes** `markup.strikethrough`, `markup.link`,
   `markup.link.label`, `markup.link.url`, and `markup.quote` (latter still
   useful where it does apply).
4. **Swap markdown palette to Atom One Dark / Light**, leaving code-syntax
   tokens (`comment`, `keyword`, `string`, etc.) on the current VSCode-derived
   palette unless a follow-up requests a full Atom swap. Hex codes pulled from
   the canonical `atom/atom` `one-dark-syntax` / `one-light-syntax` `colors.less`.
5. **Register explicit heading scopes** `markup.heading.1` through
   `markup.heading.6` alongside `markup.heading`. OpenTUI supports block
   headings; Quark's theme was missing the exact scopes.
6. **Use `<markdown>` renderable for assistant messages.** OpenTUI's
   `MarkdownRenderable` provides structured rendering for tables (via
   `TextTableRenderable`) and conceals inline delimiters, heading markers, and
   code fences natively. It also handles block-level layout for headings, lists,
   blockquotes, and code blocks. Link URLs remain visible in parentheses in
   `conceal` mode (e.g., `label (https://example.com)`), which is acceptable
   terminal UX since links are not clickable. The prior `<code
   filetype="markdown">` approach rendered tables as raw pipe-delimited text,
   which is the bug this switch fixes.

### Atom One palette (computed from canonical `colors.less`)

| Token | Dark hex | Light hex |
|---|---|---|
| `hue-1` (cyan) | `#56b6c2` | `#0184bc` |
| `hue-2` (blue) | `#61afef` | `#4078f2` |
| `hue-3` (purple) | `#c678dd` | `#a626a4` |
| `hue-4` (green) | `#98c379` | `#50a14f` |
| `hue-5` (red 1) | `#e06c75` | `#e45649` |
| `hue-6` (orange 1) | `#d19a66` | `#986801` |
| `mono-3` (subtle) | `#5c6370` | `#a0a1a7` |

### Markdown token mapping (target after step 5)

| Scope (OpenTUI) | Atom rule | Dark | Light |
|---|---|---|---|
| `markup.strong` | custom warm yellow bold | `#E5C07B` bold | `#986801` bold |
| `markup.italic` | `@hue-3` italic | `#c678dd` italic | `#a626a4` italic |
| `markup.raw` (+ `markup.inline.raw`) | `@hue-4` | `#98c379` | `#50a14f` |
| `markup.strikethrough` | `@hue-5` | `#e06c75` | `#e45649` |
| `markup.link` | `@hue-1` | `#56b6c2` | `#0184bc` |
| `markup.link.label` | `@hue-2` | `#61afef` | `#4078f2` |
| `markup.link.url` | `@hue-1` | `#56b6c2` | `#0184bc` |
| `markup.quote` | `@mono-3` italic | `#5c6370` italic | `#a0a1a7` italic |
| `markup.heading`, `markup.heading.1` | `@hue-5` bold | `#e06c75` bold | `#e45649` bold |
| `markup.heading.2` | `@hue-3` bold | `#c678dd` bold | `#a626a4` bold |
| `markup.heading.3` | `@hue-6` bold | `#d19a66` bold | `#986801` bold |
| `markup.heading.4` | `@hue-2` bold | `#61afef` bold | `#4078f2` bold |
| `markup.heading.5` | `@hue-1` bold | `#56b6c2` bold | `#0184bc` bold |
| `markup.heading.6` | `@hue-4` bold | `#98c379` bold | `#50a14f` bold |
| `markup.list` | `@hue-5` | `#e06c75` | `#e45649` |

## Acceptance Criteria

- Inline code in assistant messages renders in the configured `markup.raw`
  color (verified post-step-1: orange in dark theme).
- Italic text renders in `markup.italic` foreground color and italic style.
- Strikethrough, link, link label, link url all render in their configured
  colors.
- Headings render in the configured `markup.heading.N` color and bold style
  without visible `#`, `##`, or `###` markers.
- A manual end-to-end TUI test using
  [test.md](../test.md) shows all inline-level
  scopes and headings visibly colored after the palette swap.
- `bun run dev` plus a prompt asking the model to repeat `test.md` is the
  validation harness per AGENTS.md ("manual test verifies the pieces fit
  together at runtime").
- Custom heading layout is explicitly deferred; coloring is handled by theme
  scopes.
- List and quote structural markdown markers (`>`, `-`, `1.`) remain visible.
- Inline source markers (`**`, `*`, `~~`, backticks, fence markers) and heading
  markers (`#`, `##`, `###`) are concealed in assistant output.
- Tables render as structured `TextTableRenderable` with box-drawing borders,
  not as raw `|`-delimited markdown text.

## Progress

- [x] **1. Fix `markup.inline.raw` → `markup.raw`** in
  [dark.ts](../src/tui/themes/dark.ts#L73) and
  [light.ts](../src/tui/themes/light.ts#L76). Verified: inline code now orange.
- [x] **2. Investigate headings** — root cause documented (§4). OpenTUI
      supports heading colors through `markup.heading.1`-`markup.heading.6`.
- [x] **3. Add `foreground` to `markup.italic`** — purple in dark (`#c678dd`),
      purple in light (`#a626a4`). Done in
      [dark.ts](../src/tui/themes/dark.ts) and
      [light.ts](../src/tui/themes/light.ts).
- [x] **4. Register `markup.link`, `markup.link.label`, `markup.link.url`,
       `markup.strikethrough`, `markup.quote`** in both theme files.
- [x] **5. Swap markdown token colors to Atom One Dark / Light palette.**
      Inline scopes only; code-syntax tokens (`comment`, `keyword`, …) left on
      the existing VSCode-derived palette per Decision 4.
- [x] **6. Register `markup.heading.1` through `markup.heading.6`** in both
      theme files so block-level headings color without `renderNode`.
- [x] **7. Switch assistant-message to `<markdown>` renderable** in
      [assistant-message.tsx](../src/tui/components/assistant-message.tsx), so
      headings, inline delimiters, and code fences are concealed natively, and
      tables render as structured `TextTableRenderable` with box-drawing borders.
- [ ] 8. **Manual TUI verification** — run `bun run dev`, prompt with
       `@test.md repeat this exactly, do not do anything`, confirm headings,
       inline scopes, and tables render correctly in both themes.

## Validation Asset

[test.md](../test.md) at the repo root contains a compact sample covering
every inline scope OpenTUI emits plus the block-level elements (headings,
quote, lists, fenced code). To test:

```
bun run dev
> @test.md repeat this exactly, do not do anything
```

Inspect the assistant output for which scopes get colored vs. plain.
