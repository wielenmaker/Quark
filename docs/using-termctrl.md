# Using `termctrl` to drive the Quark TUI

A self-contained reference. Do **not** re-fetch `kitlangton/terminal-control` —
everything you need to operate the binary is here.

## What it is

`termctrl` (binary name; crate `terminal-control`) runs a target program inside
a real **pseudo-terminal** and lets you script it from outside. You start a
named background session, send keys, wait for visible text, and read the
**rendered screen** (after VT escape codes are applied) — not raw stdout.

It is the right tool for inspecting Quark's TUI because:

- The Quark TUI uses **OpenTUI**, which performs a startup handshake that
  ordinary `script`/`tmux` capture does not answer cleanly. Pass
  `--host opentui` so `termctrl` answers it.
- `show` returns the final composed frame, so streaming assistant text, tool
  cards, and footer state are all visible exactly as a user sees them.
- It is non-interactive — every action is one CLI call, perfect for agents.

Installed at `~/.cargo/bin/termctrl` (v0.3.0). Run `termctrl --help` for the
full command list; this doc covers the subset you need.

## The workflow

```diagram
   termctrl start NAME --host opentui --cols C --rows R -- <command>
            │
            ▼
   termctrl wait NAME "visible text" --timeout MS
   termctrl send NAME text:<input> enter
   termctrl show NAME                       ← rendered screen to stdout
   termctrl save NAME --format png --out file.png
            │
            ▼
   termctrl stop NAME
```

Sessions live in owner-only Unix sockets under `/tmp`. They survive between
calls until `stop` (or process exit). Use `termctrl list` and
`termctrl status NAME` to inspect them.

## Commands you will actually use

| Command | Purpose |
|---|---|
| `start NAME --host opentui --cols 120 --rows 40 -- bun run dev` | Launch the Quark TUI in a named session. |
| `wait NAME "text" --timeout 10000` | Block until `text` appears on screen. Use this **instead of `sleep`**. |
| `send NAME text:hello enter` | Send literal text then press Enter. |
| `send NAME ctrl-c` / `escape` / `tab` / `arrow-down` / `page-up` | Special keys, exactly as named. |
| `send NAME --pace-ms 30 text:slow-typing enter` | Throttle keystrokes (helps when the TUI debounces input). |
| `show NAME` | Print the current visible frame to stdout. |
| `show NAME --format json` / `svg` | Same frame in structured form. |
| `save NAME --format png --out shot.png` | Write a PNG of the current frame. Repeat `--format` to write several. |
| `status NAME` | `running` or `exited`, viewport, cwd, launch command. |
| `logs NAME` | Retained terminal scrollback (useful for normal-screen output; **not** useful for alternate-screen TUIs — use `show` for those). |
| `resize NAME --cols 132 --rows 38` | Change viewport. |
| `stop NAME` | Terminate the session. |

`send` input atoms:
- `text:<value>` — literal characters (spaces allowed inside the value)
- key names — `enter`, `escape`, `tab`, `shift-tab`, `backspace`, `delete`,
  `home`, `end`, `page-up`, `page-down`, `arrow-up/down/left/right`
- `ctrl-a` … `ctrl-z`

Pipe exact bytes when the key set is not enough:
```
printf '%s' 'precise prompt' | termctrl send NAME --stdin
```

## Canonical recipe for the Quark TUI

```bash
# 1. Launch Quark in a 120×40 PTY named "quark"
termctrl start quark --host opentui --cols 120 --rows 40 -- \
  bash -c 'cd /Users/mac/01-CodeSpace/Personal-Lab/02-Experiment/Quark && bun run dev'

# 2. Wait for the prompt to mount (look for a stable string from the footer)
termctrl wait quark "of 1M" --timeout 15000

# 3. Send a user message
termctrl send quark --pace-ms 20 "text:Reply with the single word pong." enter

# 4. Wait for the assistant to finish; the running spinner disappears
termctrl wait quark "pong" --timeout 30000

# 5. Inspect / save
termctrl show quark                            # print the frame
termctrl save quark --format png --out /tmp/quark-pong.png

# 6. Clean up
termctrl stop quark
```

## Tips and gotchas

- **Always pass `--host opentui`** when starting the Quark TUI. Without it the
  OpenTUI startup probe stalls and you see a blank or stuck frame.
- **Choose a viewport that matches what you want to see.** The TUI lays out for
  the reported terminal size; 120×40 is a good default. Use `resize` to test
  responsive behavior.
- **Use `wait`, never `sleep`.** `wait` matches against the *rendered* screen
  so it is robust to network/model latency.
- **Substring matching is exact and visible.** Pick anchor strings that only
  appear in the state you are waiting for (e.g. footer percentages, tool
  card headers, the literal answer text).
- **`show` vs `logs`.** The TUI runs in alternate-screen mode, so `logs` is
  mostly empty. Always read the screen with `show`.
- **`save --format ansi`** can capture sensitive scrollback bytes. Only use it
  when you specifically need the raw escape sequence stream.
- **One-shot vs persistent.** `show -- cmd` and `save -- cmd` launch the
  command, capture, then kill it. For anything you need to interact with,
  use `start` + a named session.
- **`status NAME` after `stop`** still shows the final retained frame; call
  `stop` again or just move on — there is no harm.

## Minimal failure-mode checklist

If a recipe is not behaving:

1. `termctrl status NAME` — is the session actually running?
2. `termctrl show NAME` — what does the screen actually look like right now?
3. Did you forget `--host opentui`?
4. Is your `wait` anchor string really on the visible screen (and not, say,
   word-wrapped across two lines)?
5. Is the viewport too small for the layout you expect?

That is enough to drive Quark's TUI end-to-end without ever reading the
upstream README.
