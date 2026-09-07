import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { getContinuingToolCallId, getToolActivityKind, groupMessageParts, mergeToolActivityMessages } from "../../src/tui/components/tool-activity"
import type { TuiMessage, TuiPart } from "../../src/tui/state"

const ROOT = resolve(import.meta.dir, "../..")

function tool(tool: string, status: "pending" | "running" | "completed" | "error" = "completed"): TuiPart {
  return { type: "tool", tool, callId: tool, status, input: { path: `/${tool}.ts` } }
}

function assistant(id: string, parts: TuiPart[]): TuiMessage {
  return { id, role: "assistant", parts }
}

describe("tool activity grouping", () => {
  test("maps tools to user-facing activities", () => {
    expect(getToolActivityKind("Read")).toBe("explore")
    expect(getToolActivityKind("grep")).toBe("explore")
    expect(getToolActivityKind("glob")).toBe("explore")
    expect(getToolActivityKind("write")).toBe("modify")
    expect(getToolActivityKind("edit")).toBe("modify")
    expect(getToolActivityKind("websearch")).toBe("internet")
    expect(getToolActivityKind("webfetch")).toBe("internet")
    expect(getToolActivityKind("bash")).toBe("command")
  })

  test("combines adjacent tools with the same purpose", () => {
    const items = groupMessageParts([
      tool("read"),
      tool("grep"),
      tool("glob"),
      tool("edit"),
      tool("write"),
      tool("bash"),
    ])

    expect(items.map((item) => item.type === "activity" ? [item.kind, item.tools.length] : item.type)).toEqual([
      ["explore", 3],
      ["modify", 2],
      ["command", 1],
    ])
  })

  test("text and sub-agents remain visible timeline items", () => {
    const subAgent = tool("subagent") as Extract<TuiPart, { type: "tool" }>
    subAgent.subAgent = {
      profile: "finder",
      tools: [],
      tokensUsed: 0,
      tokenLimit: 1,
      done: false,
    }
    const items = groupMessageParts([
      tool("read"),
      { type: "text", text: "Found it." },
      subAgent,
      tool("grep"),
    ])

    expect(items.map((item) => item.type)).toEqual(["activity", "part", "part", "activity"])
    expect(items.filter((item) => item.type === "activity")).toHaveLength(2)
  })

  test("merges exploration calls across intervening assistant content", () => {
    const messages = mergeToolActivityMessages([
      assistant("grep-step", [tool("grep"), tool("glob")]),
      assistant("thinking-step", [{ type: "thinking", done: true, text: "Inspecting the result" }]),
      assistant("text-step", [{ type: "text", text: "Checking another file" }]),
      assistant("read-step", [tool("read")]),
    ])

    expect(messages.slice(1).every((message) => message === undefined)).toBe(true)
    const items = groupMessageParts(messages[0]!.parts)
    expect(items.filter((item) => item.type === "activity")).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: "activity", kind: "explore" })
    expect((items[0] as any).tools).toHaveLength(3)
  })

  test("does not merge across a user turn or steer divider", () => {
    const userBoundary = mergeToolActivityMessages([
      assistant("grep-step", [tool("grep")]),
      { id: "user", role: "user", parts: [{ type: "text", text: "Continue" }] },
      assistant("read-step", [tool("read")]),
    ])
    expect(userBoundary.filter(Boolean)).toHaveLength(3)

    const dividerBoundary = mergeToolActivityMessages([
      assistant("grep-step", [tool("grep")]),
      assistant("read-step", [tool("read")]),
    ], new Set([1]))
    expect(dividerBoundary.filter(Boolean)).toHaveLength(2)
  })

  test("stops the latest activity shimmer when thinking starts", () => {
    const completedGrep = tool("grep") as Extract<TuiPart, { type: "tool" }>
    completedGrep.callId = "grep-call"

    expect(getContinuingToolCallId([
      assistant("grep-step", [completedGrep]),
      { ...assistant("next-step", []), streaming: true },
    ], true)).toBe("grep-call")

    expect(getContinuingToolCallId([
      assistant("grep-step", [completedGrep]),
      assistant("next-step", [{ type: "thinking", done: false, text: "" }]),
    ], true)).toBeNull()

    const bash = tool("bash") as Extract<TuiPart, { type: "tool" }>
    bash.callId = "bash-call"
    expect(getContinuingToolCallId([
      assistant("grep-step", [completedGrep]),
      assistant("bash-step", [bash]),
    ], true)).toBe("bash-call")

    expect(getContinuingToolCallId([assistant("grep-step", [completedGrep])], false)).toBeNull()
  })
})

describe("ToolActivity progressive disclosure", () => {
  test("App renders cross-step exploration as one summary", () => {
    const script = `
      import { testRender } from "@opentui/solid";
      import { createComponent } from "solid-js";
      import { App } from "./src/tui/components/App.tsx";

      const setup = await testRender(
        () => createComponent(App, {
          initialSessionId: "activity-session",
          initialModelName: "smart",
          initialSkillCount: 0,
          onSubmit() {},
          onCancel() {},
          initialMessages: [
            { id: "grep-step", role: "assistant", parts: [
              { type: "tool", tool: "grep", callId: "1", status: "completed", input: { pattern: "src" } },
            ] },
            { id: "read-step", role: "assistant", parts: [
              { type: "tool", tool: "read", callId: "2", status: "completed", input: { path: "/src/tui/index.tsx" } },
            ] },
          ],
        }),
        { width: 80, height: 12, useConsole: false },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      setup.renderer.destroy();
      console.log(JSON.stringify(frame));
    `
    const proc = Bun.spawnSync({
      cmd: ["bun", "--preload", "./preload.ts", "-e", script],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (!proc.success) throw new Error(proc.stderr.toString())
    const frame = JSON.parse(proc.stdout.toString()) as string
    expect(frame.match(/Explored the codebase/g)).toHaveLength(1)
  })

  test("hides calls by default and reveals them when clicked", () => {
    const script = `
      import { testRender } from "@opentui/solid";
      import { createComponent } from "solid-js";
      import { ToolActivity } from "./src/tui/components/tool-activity-view.tsx";

      const tools = [
        { type: "tool", tool: "read", callId: "1", status: "completed", input: { path: "/src/a.ts" } },
        { type: "tool", tool: "grep", callId: "2", status: "completed", input: { pattern: "needle" } },
      ];
      const setup = await testRender(
        () => createComponent(ToolActivity, { kind: "explore", tools }),
        { width: 80, height: 10, useConsole: false },
      );
      await setup.renderOnce();
      const before = setup.captureCharFrame();
      await setup.mockMouse.click(10, 0);
      await setup.renderOnce();
      const after = setup.captureCharFrame();
      setup.renderer.destroy();
      console.log(JSON.stringify({ before, after }));
    `
    const proc = Bun.spawnSync({
      cmd: ["bun", "--preload", "./preload.ts", "-e", script],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (!proc.success) throw new Error(proc.stderr.toString())
    const { before, after } = JSON.parse(proc.stdout.toString()) as { before: string; after: string }

    expect(before).toContain("• Explored the codebase")
    expect(before).toContain("▸")
    expect(before).not.toContain("Read /src/a.ts")
    expect(after).toContain("• Explored the codebase")
    expect(after).toContain("▾")
    expect(after).toContain("Read /src/a.ts")
    expect(after).toContain("Grep needle")
  })

  test("uses a live present-tense label while an activity continues between calls", () => {
    const script = `
      import { testRender } from "@opentui/solid";
      import { createComponent } from "solid-js";
      import { ToolActivity } from "./src/tui/components/tool-activity-view.tsx";
      const setup = await testRender(
        () => createComponent(ToolActivity, {
          kind: "modify",
          tools: [{ type: "tool", tool: "edit", callId: "1", status: "completed", input: { path: "/src/a.ts" } }],
          continuingToolCallId: "1",
        }),
        { width: 80, height: 4, useConsole: false },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      setup.renderer.destroy();
      console.log(JSON.stringify(frame));
    `
    const proc = Bun.spawnSync({
      cmd: ["bun", "--preload", "./preload.ts", "-e", script],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (!proc.success) throw new Error(proc.stderr.toString())
    const frame = JSON.parse(proc.stdout.toString()) as string
    expect(frame).toContain("• Modifying code…")
    expect(frame).toContain("▸")
  })
})
