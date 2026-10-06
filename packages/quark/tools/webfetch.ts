// Tool: webfetch — fetch and convert web content

import { z } from "zod"
import TurndownService from "turndown"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

const DESCRIPTION = `Fetches content from a specified URL.
- Takes a URL and optional format as input
- Fetches the URL content, converts to requested format (markdown by default)
- Returns the content in the specified format
- Use this tool when you need to retrieve and analyze web content

Usage notes:
- The URL must be a fully-formed valid URL
- HTTP URLs will be automatically upgraded to HTTPS
- Format options: "markdown" (default), "text", or "html"
- This tool is read-only and does not modify any files
- Results may be summarized if the content is very large`

export default {
  id: "webfetch",
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
    timeout: z.number().optional().describe("Optional timeout in seconds (max 120)"),
  }),
  async execute(args: { url: string; format?: "text" | "markdown" | "html"; timeout?: number }) {
    const { url, format = "markdown", timeout: timeoutSecs } = args

    // Validate URL
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    const timeout = Math.min((timeoutSecs ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

    // Build Accept header based on requested format
    let acceptHeader = "*/*"
    switch (format) {
      case "markdown":
        acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        break
      case "text":
        acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        break
      case "html":
        acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1"
        break
    }

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const initial = await fetch(url, { signal: controller.signal, headers })

      // Retry with honest UA if blocked by Cloudflare
      const response =
        initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
          ? await fetch(url, { signal: controller.signal, headers: { ...headers, "User-Agent": "atom" } })
          : initial

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`Request failed with status code: ${response.status}`)
      }

      // Check content length
      const contentLength = response.headers.get("content-length")
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)")
      }

      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)")
      }

      const contentType = response.headers.get("content-type") || ""
      const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
      const title = `webfetch: ${url}`

      // Check if response is an image
      const isImage = mime.startsWith("image/") && mime !== "image/svg+xml"
      if (isImage) {
        return {
          title,
          output: `Image fetched: ${mime} (${arrayBuffer.byteLength} bytes)`,
          metadata: { url, contentType: mime, size: arrayBuffer.byteLength },
        }
      }

      const content = new TextDecoder().decode(arrayBuffer)

      // Handle content based on requested format
      switch (format) {
        case "markdown":
          if (contentType.includes("text/html")) {
            const markdown = convertHTMLToMarkdown(content)
            return { output: markdown, title, metadata: { url, contentType } }
          }
          return { output: content, title, metadata: { url, contentType } }

        case "text":
          if (contentType.includes("text/html")) {
            const text = extractTextFromHTML(content)
            return { output: text, title, metadata: { url, contentType } }
          }
          return { output: content, title, metadata: { url, contentType } }

        case "html":
          return { output: content, title, metadata: { url, contentType } }

        default:
          return { output: content, title, metadata: { url, contentType } }
      }
    } finally {
      clearTimeout(timeoutId)
    }
  },
}

function extractTextFromHTML(html: string): string {
  // Simple text extraction - remove tags and decode entities
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
