import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")

function renderPreview(rows = `
            { type: "orphan", id: "one", label: "Session one", detail: "now", current: true },
            { type: "orphan", id: "two", label: "Session two", detail: "1m ago", current: false },
          `): string {
  const script = `
    import { testRender } from "@opentui/solid";
    import { createComponent } from "solid-js";
    import { CommandPalette } from "./src/tui/components/command-palette.tsx";

    const setup = await testRender(
      () => createComponent(CommandPalette, {
        active: true,
        mode: "sessions",
        query: "",
        entries: [],
        sessionRows: [${rows}],
        sessionAction: "browse",
        selectedIndex: 0,
        onInput() {},
      }),
      { width: 140, height: 20, useConsole: false },
    );

    await setup.renderOnce();
    console.log(JSON.stringify(setup.captureCharFrame()));
    setup.renderer.destroy();
  `

  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./preload.ts", "-e", script],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.success) throw new Error(proc.stderr.toString())
  return JSON.parse(proc.stdout.toString().trim()) as string
}

function renderSessionPicker(): string {
  const script = `
    import { testRender } from "@opentui/solid";
    import { createComponent } from "solid-js";
    import { App } from "./src/tui/components/App.tsx";

    const setup = await testRender(
      () => createComponent(App, {
        onSubmit() {},
        onCancel() {},
        getSessions() {
          return [{ id: "one", title: "Existing session", timeUpdated: Date.now() }];
        },
        getPaletteEntries() {
          return [{
            key: "command:sessions",
            type: "command",
            id: "sessions",
            label: "/sessions",
            searchText: ["/sessions", "sessions"],
            action: { type: "command", commandId: "sessions" },
          }];
        },
      }),
      { width: 100, height: 20, useConsole: false },
    );

    await setup.renderOnce();
    await setup.mockInput.typeText("/");
    await setup.renderOnce();
    await setup.mockInput.typeText("sessions");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    console.log(JSON.stringify(setup.captureCharFrame()));
    setup.renderer.destroy();
  `

  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./preload.ts", "-e", script],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.success) throw new Error(proc.stderr.toString())
  return JSON.parse(proc.stdout.toString().trim()) as string
}

function renderSessionActions(): { frame: string; commands: string[] } {
  const script = `
    import { testRender } from "@opentui/solid";
    import { createComponent } from "solid-js";
    import { App } from "./src/tui/components/App.tsx";

    const commands = [];
    const setup = await testRender(
      () => createComponent(App, {
        onSubmit() {},
        onCancel() {},
        onCommand(command) { commands.push(command); return { handled: true }; },
        getSessions() {
          return [{ id: "one", title: "Existing session", timeUpdated: Date.now() }];
        },
        getPaletteEntries() {
          return [{
            key: "command:sessions",
            type: "command",
            id: "sessions",
            label: "/sessions",
            searchText: ["/sessions", "sessions"],
            action: { type: "command", commandId: "sessions" },
          }];
        },
      }),
      { width: 100, height: 20, useConsole: false },
    );

    await setup.renderOnce();
    await setup.mockInput.typeText("/");
    await setup.renderOnce();
    await setup.mockInput.typeText("sessions");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    setup.mockInput.pressKey("k", { ctrl: true });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    setup.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 0));
    console.log(JSON.stringify({ frame, commands }));
    setup.renderer.destroy();
  `

  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./preload.ts", "-e", script],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.success) throw new Error(proc.stderr.toString())
  return JSON.parse(proc.stdout.toString().trim()) as { frame: string; commands: string[] }
}

describe("session picker layout", () => {
  test("does not show a transcript preview or scope", () => {
    const frame = renderPreview()
    expect(frame).not.toContain("Preview")
    expect(frame).not.toContain("You:")
    expect(frame).not.toContain("Quark:")
    expect(frame).not.toContain("this worktree")
    expect(frame).not.toContain("all worktrees")
  })

  test("renders a lineage root without a parent connector", () => {
    const frame = renderPreview(`
      { type: "session", id: "root", label: "General Conversation", detail: "original · now", current: true, root: true, guides: [], connector: "root" },
      { type: "session", id: "child", label: "Casual Conversation", detail: "branch · now", current: false, root: false, guides: [], connector: "last" },
    `)

    expect(frame).not.toContain("├─ General Conversation")
    expect(frame).toContain("└─ Casual Conversation")
  })

  test("renders pinned and recent session dividers", () => {
    const frame = renderPreview(`
      { type: "divider", label: "Pinned" },
      { type: "session", id: "pinned", label: "Important work", detail: "pinned · now", current: true, root: false, guides: [], connector: "plain" },
      { type: "divider", label: "Recent" },
      { type: "session", id: "recent", label: "Recent work", detail: "1m ago", current: false, root: false, guides: [], connector: "plain" },
    `)

    expect(frame).toContain("Pinned")
    expect(frame).toContain("Recent")
  })

  test("opens from /sessions", () => {
    const frame = renderSessionPicker()
    const lines = frame.split("\n")
    const borderRow = lines.findIndex((line) => line.includes("╭"))
    expect(frame).toContain("Existing session")
    expect(lines[borderRow]!.indexOf("╭")).toBeGreaterThan(10)
    expect(borderRow).toBeLessThan(8)
  })

  test("opens a searchable actions menu with Ctrl+K", () => {
    const { frame, commands } = renderSessionActions()
    expect(frame).toContain("Session actions")
    expect(frame).toContain("Pin session")
    expect(frame).toContain("Rename session")
    expect(frame).toContain("Search actions")
    expect(commands).toEqual(["pin-session"])
  })
})
