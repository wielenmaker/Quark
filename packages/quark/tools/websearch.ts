// Tool: websearch — search the web via SearXNG

import { z } from "zod"

const SEARXNG_BASE = "http://searxng.home.arpa"

interface SearXNGResult {
  title: string
  url: string
  content: string
  engine: string
  score: number
  publishedDate?: string | null
  category?: string
}

interface SearXNGInfobox {
  infobox: string
  content: string
  urls?: { title: string; url: string }[]
}

interface SearXNGResponse {
  query: string
  number_of_results: number
  results: SearXNGResult[]
  answers: string[]
  infoboxes: SearXNGInfobox[]
  suggestions: string[]
}

function formatOutput(data: SearXNGResponse, maxResults: number): string {
  const lines: string[] = []

  lines.push(`Search results for: "${data.query}"`)
  lines.push("")

  // Direct answers
  if (data.answers && data.answers.length > 0) {
    lines.push("## Direct Answers")
    for (const answer of data.answers) {
      lines.push(`- ${answer}`)
    }
    lines.push("")
  }

  // Infoboxes
  if (data.infoboxes && data.infoboxes.length > 0) {
    lines.push("## Info")
    for (const box of data.infoboxes) {
      lines.push(`**${box.infobox}**: ${box.content}`)
      if (box.urls && box.urls.length > 0) {
        for (const u of box.urls) {
          lines.push(`  - ${u.title}: ${u.url}`)
        }
      }
    }
    lines.push("")
  }

  // Results
  const results = data.results.slice(0, maxResults)

  if (results.length === 0) {
    lines.push("No results found.")
    return lines.join("\n")
  }

  lines.push("## Results")
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    lines.push(`${i + 1}. **${r.title}**`)
    lines.push(`   URL: ${r.url}`)
    if (r.content) {
      lines.push(`   ${r.content}`)
    }
    if (r.publishedDate) {
      lines.push(`   Published: ${r.publishedDate.slice(0, 10)}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

export default {
  id: "websearch",
  description:
    'Search the web using the local SearXNG instance at http://searxng.home.arpa/. Returns ranked results with titles, URLs, and snippets. For normal/general web searches use engines="google". For code-related searches (repositories, issues, code snippets) use engines="github".',
  parameters: z.object({
    query: z.string().min(1).describe("Search query"),
    categories: z
      .string()
      .optional()
      .describe('SearXNG category, e.g. "general", "images", "news", "science" (default: general)'),
    engines: z
      .string()
      .optional()
      .describe('Comma-separated list of engines to use, e.g. "github,google,brave". Overrides categories when set.'),
    language: z
      .string()
      .optional()
      .describe('Language code, e.g. "en", "fr", "auto" (default: auto)'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum number of results to return (1–20, default: 10)"),
    pageno: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number for pagination (default: 1)"),
  }),
  async execute(args: {
    query: string
    categories?: string
    engines?: string
    language?: string
    max_results?: number
    pageno?: number
  }) {
    const {
      query,
      categories = "general",
      engines,
      language = "auto",
      max_results = 10,
      pageno = 1,
    } = args

    if (!query || query.trim().length === 0) {
      throw new Error("query must not be empty")
    }
    if (max_results < 1 || max_results > 20) {
      throw new Error("max_results must be between 1 and 20")
    }

    const params = new URLSearchParams({
      q: query,
      format: "json",
      categories,
      language,
      pageno: String(pageno),
    })

    if (engines) {
      params.set("engines", engines)
    }

    const url = `${SEARXNG_BASE}/search?${params.toString()}`

    let response: Response
    try {
      response = await fetch(url)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`SearXNG request failed: ${msg}`)
    }

    if (!response.ok) {
      throw new Error(`SearXNG returned HTTP ${response.status}: ${response.statusText}`)
    }

    let data: SearXNGResponse
    try {
      data = (await response.json()) as SearXNGResponse
    } catch {
      throw new Error("SearXNG returned invalid JSON")
    }

    const output = formatOutput(data, max_results)

    return {
      title: `websearch: ${query}`,
      output,
      metadata: {
        query,
        resultCount: data.results.length,
        engines: engines || categories,
      },
    }
  },
}
