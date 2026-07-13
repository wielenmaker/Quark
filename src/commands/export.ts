import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getSession } from "../session/session"
import { loadMessages, formatConversation } from "../session/message"
import type { MessageRow, PartRow } from "../session/message"

export interface ExportResult {
  filePath: string
  messageCount: number
}

export function exportSessionToMarkdown(
  sessionId: string,
  opts?: { cwd?: string },
): ExportResult {
  const session = getSession(sessionId)
  const { messages, parts } = loadMessages(sessionId)
  const markdown = formatConversation(messages, parts, {
    userPrefix: "## User",
    assistantPrefix: "## Assistant",
    separator: "\n\n",
    prefixSeparator: "\n\n",
  })

  const exportDir = join(opts?.cwd ?? process.cwd(), ".quark", "export")
  mkdirSync(exportDir, { recursive: true })

  const filename = `${sanitizeFilename(session.title ?? session.id)}.md`
  const filePath = join(exportDir, filename)
  writeFileSync(filePath, markdown ? `${markdown}\n` : "", "utf-8")

  return { filePath, messageCount: countRenderedMessages(messages, parts) }
}

function countRenderedMessages(messages: MessageRow[], parts: PartRow[]): number {
  const partsByMessage = new Map<string, PartRow[]>()
  for (const part of parts) {
    const list = partsByMessage.get(part.messageId) ?? []
    list.push(part)
    partsByMessage.set(part.messageId, list)
  }

  let count = 0
  for (const message of messages) {
    if (message.finish === "aborted") continue
    const hasText = (partsByMessage.get(message.id) ?? []).some((part) => {
      if (part.type !== "text") return false
      try {
        const data = JSON.parse(part.data) as { text?: string }
        return Boolean(data.text?.trimEnd())
      } catch {
        return false
      }
    })
    if (hasText) count++
  }
  return count
}

function sanitizeFilename(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?%*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")

  return sanitized || "conversation"
}
