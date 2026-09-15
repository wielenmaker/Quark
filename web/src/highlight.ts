import hljs from "highlight.js/lib/common"

/** Names models use that highlight.js does not register itself. */
const ALIASES: Record<string, string> = {
  console: "bash",
  shell: "bash",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
  objc: "objectivec",
  text: "plaintext",
  txt: "plaintext",
}

/** Resolve a fence language to a highlight.js language id, or null when unknown. */
export function highlightLanguage(lang: string): string | null {
  const name = lang.trim().toLowerCase().replace(/^language-/, "")
  if (!name) return null
  const resolved = ALIASES[name] ?? name
  return hljs.getLanguage(resolved) ? resolved : null
}

/** Highlight `code`, returning escaped HTML — or null when the language is unknown. */
export function highlightCode(code: string, lang: string): string | null {
  const language = highlightLanguage(lang)
  if (!language) return null
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return null
  }
}
