// Tool: write — create or overwrite files

import * as fs from "fs"
import * as path from "path"
import * as childProcess from "child_process"
import * as os from "os"
import { z } from "zod"

function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  if (oldContent === newContent) return ""
  try {
    const tmpDir = os.tmpdir()
    const oldFile = path.join(tmpDir, `quark-diff-old-${Date.now()}`)
    const newFile = path.join(tmpDir, `quark-diff-new-${Date.now()}`)
    const oldLabel = oldContent === "" ? "/dev/null" : `a/${filePath}`
    const newLabel = `b/${filePath}`
    fs.writeFileSync(oldFile, oldContent, "utf-8")
    fs.writeFileSync(newFile, newContent, "utf-8")
    try {
      const result = childProcess.spawnSync(
        "diff",
        ["-u", "--label", oldLabel, "--label", newLabel, oldFile, newFile],
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
  id: "write",
  description: "Create or overwrite a file with the given content. Creates parent directories if needed.",
  parameters: z.object({
    filePath: z.string().describe("Absolute path to the file to write"),
    content: z.string().describe("Content to write to the file"),
  }),
  async execute(args: { filePath: string; content: string }) {
    const { filePath, content } = args

    // Read old content for diff (empty string if new file)
    const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : ""

    // Ensure parent directory exists
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, content, "utf-8")

    const stats = fs.statSync(filePath)
    const diff = generateDiff(oldContent, content, filePath)

    return {
      title: `write: ${path.basename(filePath)}`,
      output: `Wrote ${stats.size} bytes to ${filePath}`,
      metadata: { filePath, size: stats.size, diff },
    }
  },
}
