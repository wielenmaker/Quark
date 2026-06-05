---
title: TUI + OpenTUI working notes
date_created: 2026-05-28
date_modified: 2026-05-28
revision: 1
history:
  - 2026-05-28: Initial draft, captured after unified theme refactor (commit a4a8d90)
status: in-progress
---

# TUI + OpenTUI working notes

Practical lessons for anyone modifying `src/tui/**` or upgrading OpenTUI.
Not exhaustive — written to save the next person the same debugging time.

---

## 1. OpenTUI prop names are non-obvious — always check `.d.ts` first

OpenTUI renderables do **not** follow web/CSS or React Native conventions.
Different renderables use different prop names for the same concept.

| Renderable | Text color | Background |
|---|---|---|
| `<text>` | `fg` | `bg` |
| `<textarea>` | `textColor` / `focusedTextColor` | `backgroundColor` / `focusedBackgroundColor` |
| `<input>` (Input.d.ts) | same as textarea | same as textarea |
| `<box>` | n/a (uses child `<text>`) | `backgroundColor` |
| `<markdown>` | n/a — themed via `syntaxStyle` prop | n/a |

**Two-state colors.** Input-like renderables (`textarea`, `input`) keep
*both* a focused and unfocused color. If you only set `textColor` and the
component is focused, OpenTUI uses its built-in `focusedTextColor` default
— which is a light gray that vanishes on light backgrounds. **Always set
both, or use the same value for both.**

**Discovery workflow.** Before writing JSX for any OpenTUI element:

```bash
ls node_modules/@opentui/core/renderables/    # list available types
grep -E "Color|Fg|Bg" node_modules/@opentui/core/renderables/<Name>.d.ts
```

This is faster than reading the OpenTUI docs and catches API drift between
versions.

---

## 2. ES module live bindings power theme-swappable singletons

The unified theme system relies on a TypeScript/JS feature most people
forget: `export let x = ...` followed by reassignment inside the module
is visible to `import { x }` consumers as a **live binding**. This is how
[src/tui/theme.ts](../src/tui/theme.ts) swaps `syntaxStyle` without
forcing all 22 component imports to change.

```ts
// theme.ts
export let syntaxStyle = SyntaxStyle.fromTheme(darkTheme.syntax)
export function applyTheme(t: Theme) {
  syntaxStyle = SyntaxStyle.fromTheme(t.syntax)  // importers see new value
}

// some-component.tsx
import { syntaxStyle } from "../theme"           // live binding
<markdown syntaxStyle={syntaxStyle} />           // re-evaluated each render
```

**Constraints to remember:**

1. The swap must happen **before** the JSX that captures the binding is
   evaluated. We do it at startup, before the renderer mounts.
2. Works only with `export let`. `export const` is frozen.
3. Re-exports also forward the live binding:
   `export { syntaxStyle } from "./theme"` keeps tracking.
4. For object-shaped exports (`colors`), don't reassign the binding —
   `Object.assign(colors, newPalette)` mutates the *same* reference so
   any consumer that destructured or aliased it still sees updates.

---

## 3. OpenTUI cannot be loaded under two module specifiers

Importing OpenTUI via both `@opentui/core` and a deep path
(`node_modules/@opentui/src/...`) — or via two different absolute paths
through symlinks — triggers a hard crash:

```
error: Environment variable "OTUI_TREE_SITTER_WORKER_PATH" is already
registered with different configuration.
```

Hit during a `bun /tmp/theme-test.ts` smoke test that imported from
`/Users/.../src/tui/theme` (absolute). OpenTUI's `registerEnvVar` is
strict about double-registration.

**Implication for ad-hoc test scripts:** keep them inside the repo
(`scripts/`, `test/`) so they resolve OpenTUI via the same module
specifier as production code, or skip importing OpenTUI from them
entirely (inline the pure logic you want to verify).

---

## 4. Terminal background detection: OSC 11, not tmux

[src/tui/terminal-bg.ts](../src/tui/terminal-bg.ts) sends OSC 11
(`\x1b]11;?\x07`) and parses the `rgb:RRRR/GGGG/BBBB` reply.

- **Works:** Ghostty, iTerm2, Terminal.app, Kitty, Alacritty, WezTerm.
- **Does NOT work inside tmux** — tmux is its own terminal emulator and
  does not proxy OSC 11 to the outer terminal. A query inside tmux
  returns an empty buffer. This is fine because the TUI is intended to
  run in the host terminal, not inside tmux.
- Requires raw stdin **before** OpenTUI takes over — we run the query
  at the top of `src/tui/index.tsx` as a top-level `await`, then call
  `applyTheme(pickThemeFor(termBg))` before `createCliRenderer()`.
- Returns a 150 ms-timed fallback (`#000000`) if no reply, so headless
  / CI runs don't hang.

**Luminance threshold:** ITU-R BT.601, `L = 0.299r + 0.587g + 0.114b`.
`L > 128` → light theme. Tested against 8 reference backgrounds
(Ghostty, Solarized light/dark, Gruvbox light, GitHub, Tomorrow Night).

**`RGBA.fromHex` stores channels in 0–1 floats**, not 0–255. Multiply
by 255 before applying the BT.601 formula.

---

## 5. Theme architecture — one Theme, two palettes, zero consumer churn

```diagram
╭─────────────────────╮   ╭───────────────────╮   ╭──────────────────────╮
│ themes/dark.ts      │   │ themes/light.ts   │   │ themes/types.ts      │
│ Palette + syntax[]  │   │ Palette + syntax[]│   │ Theme, Palette types │
╰──────────┬──────────╯   ╰─────────┬─────────╯   ╰──────────────────────╯
           │                        │
           ╰──────────┬─────────────╯
                      ▼
            ╭──────────────────────╮       ╭────────────────────────╮
            │ theme.ts             │       │ syntax-theme.ts        │
            │ • colors (mutable)   │◀──────│ re-exports syntaxStyle │
            │ • syntaxStyle (let)  │       ╰────────────────────────╯
            │ • applyTheme(t)      │
            │ • pickThemeFor(bg)   │
            ╰──────────┬───────────╯
                       │
        ╭──────────────┼──────────────╮
        ▼              ▼              ▼
   22 components   <markdown>    index.tsx (startup)
   import colors   syntaxStyle   applyTheme(pickThemeFor(termBg))
```

**Design rules to keep:**

- The `Palette` type in `themes/types.ts` is the single source of truth.
  Every theme **must** provide every key — no optional palette fields.
- Don't add hardcoded hex strings in components. Use `colors.*`. If a
  needed semantic token doesn't exist, add it to `Palette` and both
  themes, don't inline.
- Syntax tokens are themed via TextMate scopes (`markup.bold`,
  `entity.name.function`, …). When adding a new scope to one theme,
  add it to both.

---

## 6. SolidJS gotchas inside OpenTUI

These bit us during the markdown work — relevant for any reactive prop:

- **Component body runs once.** Never do early returns based on reactive
  props; use `<Show when={...}>` so the rendering path stays reactive.
  Example: [src/tui/components/assistant-message.tsx](../src/tui/components/assistant-message.tsx).
- **Reactive expressions in JSX re-run.** `prepareContent(props.text)`
  fires on every streaming delta because it's read inside JSX, not at
  setup time.
- **Don't `await` inside reactive setup.** It breaks tracking. Do all
  async startup work in `index.tsx` before mounting the App component.

---

## 7. Verification checklist for TUI changes

Per the project AGENTS.md (`Testing: Verify end-to-end at integration
boundaries`), unit tests are not enough for TUI work. Before declaring
done:

1. `bun build src/tui/<changed files> --target=bun --outdir /tmp/x` —
   catches type/import breakage faster than full `tsc` (which has lots
   of pre-existing OpenTUI JSX typing noise).
2. `bun run dev` — launch the TUI in Ghostty.
3. For theme/color changes specifically: launch once in **dark** Ghostty
   and once in **light** Ghostty. Type into the input. Read assistant
   markdown with bold/code. Trigger an error notification.
4. Take a screenshot if the change is visual — easier to see regressions
   than to describe them.

---

## 8. Known gaps / follow-ups

These were noticed during the unified-theme work but were out of scope:

- **No runtime theme toggle.** `applyTheme` works at runtime, but there
  is no `/theme` command or settings UI. The detected background at
  startup wins for the whole session.
- **No user-supplied themes.** Palettes are hardcoded in
  `themes/{dark,light}.ts`. A `~/.quark/themes/<name>.yaml` loader
  would slot in cleanly.
- **No accessibility check.** The light palette was hand-tuned for
  contrast but not measured against WCAG ratios.
- **Other inputs may have the same `textColor` bug** as the prompt
  textarea did. Audit every OpenTUI input-like renderable (`<input>`,
  `<textarea>`) for explicit `textColor` / `focusedTextColor` props.
