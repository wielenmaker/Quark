import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")

type Status = "sent" | "replied" | "aborted" | "failed"

interface SpanInfo {
  text: string
  attributes: number
  fg?: { buffer: Record<number, number> }
}

function renderUserMessage(status: Status, text = "lifecycle fixture", width = 60): { frame: string; lines: { spans: SpanInfo[] }[] } {
  const script = `
    import { testRender } from "@opentui/solid";
    import { createComponent } from "solid-js";
    import { UserMessage } from "./src/tui/components/user-message.tsx";

    const setup = await testRender(
      () => createComponent(UserMessage, {
        text: ${JSON.stringify(text)},
        images: [{ label: "Image 1" }],
        status: ${JSON.stringify(status)},
      }),
      { width: ${width}, height: 8, useConsole: false },
    );
    await setup.renderOnce();
    const capture = setup.captureSpans();
    console.log(JSON.stringify({ frame: setup.captureCharFrame(), lines: capture.lines }));
    setup.renderer.destroy();
  `
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./preload.ts", "-e", script],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!proc.success) throw new Error(proc.stderr.toString())
  return JSON.parse(proc.stdout.toString()) as { frame: string; lines: { spans: SpanInfo[] }[] }
}

const ITALIC_ATTR = 1 << 2

describe("UserMessage lifecycle presentation", () => {
  test("renders a sent message without italic", () => {
    const { frame, lines } = renderUserMessage("sent")
    expect(frame).toContain("│ lifecycle fixture")
    expect(frame).toContain("│ [Image 1]")
    expect(lines.flatMap((line) => line.spans).some((s) => (s.attributes & ITALIC_ATTR) !== 0)).toBe(false)
  })

  test.each(["replied", "aborted", "failed"] as const)("renders a %s message italic and keeps content visible", (status) => {
    const { frame, lines } = renderUserMessage(status)
    expect(frame).toContain("│ lifecycle fixture")
    expect(frame).toContain("│ [Image 1]")
    expect(lines.flatMap((line) => line.spans).some((s) => (s.attributes & ITALIC_ATTR) !== 0)).toBe(true)
  })

  test("renders a full-width top border and left border on wrapped lines", () => {
    const { frame } = renderUserMessage("sent", "one two three four five six seven", 14)
    const lines = frame.split("\n")
    const topBorder = lines.find((line) => line.includes("┌"))
    const messageLines = lines.filter((line) => /\w/.test(line))

    expect(topBorder).toMatch(/^┌─+\s*$/)
    expect(messageLines.length).toBeGreaterThan(1)
    expect(messageLines.slice(1).every((line) => line.startsWith("│"))).toBe(true)
  })

  test("colors replied text with the model status color", () => {
    const { lines } = renderUserMessage("replied")
    const textSpan = lines.flatMap((line) => line.spans).find((span) => span.text.includes("lifecycle fixture"))
    expect(textSpan?.fg?.buffer?.[0]).toBeCloseTo(95 / 255)
    expect(textSpan?.fg?.buffer?.[1]).toBeCloseTo(215 / 255)
    expect(textSpan?.fg?.buffer?.[2]).toBe(1)
    expect(textSpan?.fg?.buffer?.[3]).toBe(1)
  })
})
