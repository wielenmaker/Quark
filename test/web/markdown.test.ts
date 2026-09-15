import { describe, expect, test } from "bun:test"
import type { Token, Tokens } from "marked"
import {
  alignStyle,
  codeLabel,
  codeLanguage,
  isTaskItem,
  parseMarkdown,
  safeHref,
} from "../../web/src/markdown"
import { highlightCode, highlightLanguage } from "../../web/src/highlight"

function blocks(markdown: string): Token[] {
  return parseMarkdown(markdown).filter((token) => token.type !== "space")
}

function only(markdown: string): Token {
  const [token] = blocks(markdown)
  return token!
}

describe("parseMarkdown", () => {
  test("produces marked block tokens instead of hand-parsed blocks", () => {
    const tokens = blocks("# Title\n\n- one\n- two\n\n> quote\n\n```ts\nconst a = 1\n```")
    expect(tokens.map((token) => token.type)).toEqual(["heading", "list", "blockquote", "code"])
  })

  test("keeps ordered list numbering and nesting", () => {
    const list = only("1. first\n2. second") as Tokens.List
    expect(list.ordered).toBe(true)
    expect(list.items).toHaveLength(2)
    expect(list.start).toBe(1)
  })

  test("parses GFM tables with alignment", () => {
    const table = only("| a | b |\n| :-- | --: |\n| 1 | 2 |") as Tokens.Table
    expect(table.type).toBe("table")
    expect(table.header.map((cell) => cell.text)).toEqual(["a", "b"])
    expect(table.rows[0]!.map((cell) => cell.text)).toEqual(["1", "2"])
    expect(table.align).toEqual(["left", "right"])
  })

  test("survives empty input", () => {
    expect(parseMarkdown("")).toEqual([])
  })
})

describe("codeLanguage", () => {
  test("takes the first word of the fence info string", () => {
    expect(codeLanguage(only("```ts title=app.ts\nconst a = 1\n```"))).toBe("ts")
  })

  test("lowercases the language and ignores non-code tokens", () => {
    expect(codeLanguage(only("```TypeScript\nx\n```"))).toBe("typescript")
    expect(codeLanguage(only("plain paragraph"))).toBe("")
  })

  test("labels language-less blocks as text", () => {
    expect(codeLabel(codeLanguage(only("```\nraw\n```")))).toBe("text")
    expect(codeLabel("rust")).toBe("rust")
  })
})

describe("safeHref", () => {
  test("allows http, mailto, anchors and relative paths", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com")
    expect(safeHref("http://example.com")).toBe("http://example.com")
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co")
    expect(safeHref("#section")).toBe("#section")
    expect(safeHref("/docs/page")).toBe("/docs/page")
  })

  test("rejects script and data URLs", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull()
    expect(safeHref("data:text/html,<script>")).toBeNull()
    expect(safeHref("  ")).toBeNull()
    expect(safeHref(null)).toBeNull()
    expect(safeHref(undefined)).toBeNull()
  })
})

describe("alignStyle", () => {
  test("maps marked alignment to an inline style", () => {
    expect(alignStyle("center")).toBe("text-align: center")
    expect(alignStyle("right")).toBe("text-align: right")
    expect(alignStyle(null)).toBeUndefined()
    expect(alignStyle(undefined)).toBeUndefined()
  })
})

describe("isTaskItem", () => {
  test("detects GitHub task list items", () => {
    const list = only("- [x] done\n- [ ] todo") as Tokens.List
    expect(list.items.map(isTaskItem)).toEqual([true, true])
    expect(list.items[0]!.checked).toBe(true)
    expect(list.items[1]!.checked).toBe(false)
    expect(isTaskItem((only("- plain") as Tokens.List).items[0]!)).toBe(false)
  })
})

describe("highlighting", () => {
  test("resolves aliases highlight.js does not ship", () => {
    expect(highlightLanguage("TS")).toBe("ts")
    expect(highlightLanguage("shell")).toBe("bash")
    expect(highlightLanguage("python")).toBe("python")
    expect(highlightLanguage("html")).toBe("html")
    expect(highlightLanguage("")).toBeNull()
    expect(highlightLanguage("not-a-language")).toBeNull()
  })

  test("highlights known languages", () => {
    const html = highlightCode("const a = 1", "ts")
    expect(html).toContain("hljs-keyword")
    expect(html).toContain("hljs-number")
  })

  test("returns null for unknown languages so callers fall back to plain text", () => {
    expect(highlightCode("x", "")).toBeNull()
    expect(highlightCode("x", "not-a-language")).toBeNull()
  })

  test("escapes markup instead of emitting it", () => {
    const html = highlightCode("<script>alert(1)</script>", "html")
    expect(html).toBeTruthy()
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;")
  })
})
