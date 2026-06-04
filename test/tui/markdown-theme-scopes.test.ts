import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { darkTheme } from "../../src/tui/themes/dark"
import { lightTheme } from "../../src/tui/themes/light"

describe("markdown theme scopes", () => {
  test("registers OpenTUI block heading scopes", () => {
    for (const theme of [darkTheme, lightTheme]) {
      const style = SyntaxStyle.fromTheme(theme.syntax)

      expect(style.getStyle("markup.heading")).toBeDefined()
      expect(style.getStyle("markup.heading.1")).toBeDefined()
      expect(style.getStyle("markup.heading.6")).toBeDefined()
      if (theme === darkTheme) {
        expect(style.getStyle("markup.strong")?.fg?.toInts()).toEqual([229, 192, 123, 255])
      }

      style.destroy()
    }
  })

  test("assistant messages use markdown renderable", () => {
    const source = readFileSync("src/tui/components/assistant-message.tsx", "utf8")

    expect(source).toContain("<markdown")
    expect(source).toContain("conceal={true}")
    expect(source).toContain("syntaxStyle={syntaxStyle}")
    expect(source).toContain("streaming={props.streaming ?? false}")
  })

  test("renders markdown with concealed delimiters and structured tables", async () => {
    const style = SyntaxStyle.fromTheme(darkTheme.syntax)
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 })
    const markdown = new MarkdownRenderable(renderer, {
      id: "markdown",
      content: readFileSync("test.md", "utf8"),
      syntaxStyle: style,
      conceal: true,
      streaming: false,
      width: "100%",
    })

    renderer.root.add(markdown)
    for (let i = 0; i < 8; i++) {
      await renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 80))
    }

    const frame = captureCharFrame()
    expect(frame).toContain("Heading 1")
    expect(frame).toContain("Heading 2")
    expect(frame).not.toContain("# Heading 1")
    expect(frame).not.toContain("## Heading 2")
    expect(frame).toContain("Plain paragraph with bold, italic, bold italic, strike, and inline code.")
    expect(frame).not.toContain("**bold**")
    expect(frame).not.toContain("`code`")
    expect(frame).not.toContain("```ts")

    // Tables must render as structured tables (box-drawing characters), not raw markdown
    expect(frame).toContain("┌")
    expect(frame).toContain("┐")
    expect(frame).toContain("└")
    expect(frame).toContain("┘")
    expect(frame).toContain("├")
    expect(frame).toContain("┤")
    expect(frame).not.toContain("| Name | Age | City |")
    expect(frame).not.toContain("|------|-----|------|")

    renderer.destroy()
    style.destroy()
  })

})
