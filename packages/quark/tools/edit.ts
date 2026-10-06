// Tool: edit — find and replace in files

import * as fs from "fs"
import * as childProcess from "child_process"
import * as os from "os"
import * as path from "path"
import { z } from "zod"

function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  if (oldContent === newContent) return ""
  try {
    const tmpDir = os.tmpdir()
    const oldFile = path.join(tmpDir, `quark-diff-old-${Date.now()}`)
    const newFile = path.join(tmpDir, `quark-diff-new-${Date.now()}`)
    fs.writeFileSync(oldFile, oldContent, "utf-8")
    fs.writeFileSync(newFile, newContent, "utf-8")
    try {
      const result = childProcess.spawnSync(
        "diff",
        ["-u", "--label", `a/${filePath}`, "--label", `b/${filePath}`, oldFile, newFile],
        { encoding: "utf-8" },
      )
      return result.stdout ?? ""
    } finally {
      fs.unlinkSync(oldFile)
      fs.unlinkSync(newFile)
    }
  } catch {
    return ""
  }
}

export default {
  id: "edit",
  description: "Edit a file by replacing a specific string with new content. Use for precise edits.",
  parameters: z.object({
    filePath: z.string().describe("Absolute path to the file to edit"),
    oldString: z.string().describe("The exact string to find and replace"),
    newString: z.string().describe("The replacement string"),
    replaceAll: z.boolean().optional().describe("Replace all occurrences (default: false)"),
  }),
  async execute(args: { filePath: string; oldString: string; newString: string; replaceAll?: boolean }) {
    const { filePath, oldString, newString, replaceAll = false } = args

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`)
    }

    const content = fs.readFileSync(filePath, "utf-8")

    if (!content.includes(oldString)) {
      throw new Error(`oldString not found in ${filePath}`)
    }

    const occurrences = content.split(oldString).length - 1
    if (occurrences > 1 && !replaceAll) {
      throw new Error(`Found ${occurrences} occurrences of oldString. Use replaceAll: true or provide more context.`)
    }

    const newContent = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString)

    fs.writeFileSync(filePath, newContent, "utf-8")

    const diff = generateDiff(content, newContent, filePath)

    return {
      title: `edit: ${filePath.split("/").pop()}`,
      output: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${filePath}`,
      metadata: { filePath, occurrences: replaceAll ? occurrences : 1, diff },
    }
  },
}
