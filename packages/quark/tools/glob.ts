// Tool: glob — find files by pattern

import { glob } from "glob"
import { z } from "zod"

export default {
  id: "glob",
  description: "Find files matching a glob pattern. Use for discovering files by name or extension. Never use glob **/* because it can return tens of thousands of paths and consume the entire context window. Prefer a scoped pattern such as src/**/*.ts.",
  parameters: z.object({
    pattern: z.string().describe("Glob pattern (e.g., '**/*.ts', 'src/**/*.tsx')"),
    cwd: z.string().optional().describe("Base directory for the search"),
    ignore: z.array(z.string()).optional().describe("Patterns to ignore"),
  }),
  async execute(args: { pattern: string; cwd?: string; ignore?: string[] }) {
    const { pattern, cwd = process.cwd(), ignore = ["**/node_modules/**", "**/.git/**"] } = args

    const files = await glob(pattern, { cwd, ignore, nodir: true })

    return {
      title: `glob: ${pattern}`,
      output: files.length > 0 ? files.join("\n") : "(no matches)",
      metadata: { pattern, cwd, count: files.length },
    }
  },
}
