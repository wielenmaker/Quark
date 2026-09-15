import { marked, type Token, type Tokens } from "marked"

export type TableAlign = "left" | "center" | "right" | null

/**
 * Parse Markdown into marked's block tokens.
 *
 * The web UI renders those tokens directly, the same way Open WebUI and the TUI
 * do, instead of re-implementing a Markdown parser or injecting HTML.
 */
export function parseMarkdown(text: string): Token[] {
  if (!text) return []
  try {
    return marked.lexer(text)
  } catch {
    return [{ type: "text", raw: text, text }]
  }
}

/** Primary language of a code block: `js title=main.ts` → `js`. */
export function codeLanguage(token: Token): string {
  if (token.type !== "code") return ""
  const lang = (token as Tokens.Code).lang ?? ""
  return lang.trim().split(/[\s:]+/)[0]!.toLowerCase()
}

/** Label shown in a code block header; fenced blocks without a language say `text`. */
export function codeLabel(lang: string): string {
  return lang || "text"
}

const SAFE_PROTOCOL = /^(?:https?|mailto|tel):/i
const SAFE_RELATIVE = /^(?:#|\/|\.{1,2}\/)/

/** Only hand the browser hrefs we know are safe to follow. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null
  const value = href.trim()
  if (!value) return null
  if (SAFE_PROTOCOL.test(value) || SAFE_RELATIVE.test(value)) return value
  return null
}

/** marked alignment value → inline style for a table cell. */
export function alignStyle(align: TableAlign | undefined): string | undefined {
  return align ? `text-align: ${align}` : undefined
}

/** GitHub-style task list item (`- [x] done`). */
export function isTaskItem(item: Tokens.ListItem): boolean {
  return Boolean(item.task)
}
