import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

export interface SubagentCommand {
  command: string
  args: string[]
}

export interface ResolveSubagentCommandOptions {
  argv1?: string
  execPath?: string
  env?: NodeJS.ProcessEnv
  moduleUrl?: string
  exists?: (file: string) => boolean
}

function rootFromEntry(entry: string): { root: string; mode: "development" | "packaged" } | null {
  const normalized = path.resolve(entry)
  const srcMarker = `${path.sep}src${path.sep}`
  const distMarker = `${path.sep}dist${path.sep}`
  const srcIndex = normalized.lastIndexOf(srcMarker)
  if (srcIndex !== -1) return { root: normalized.slice(0, srcIndex), mode: "development" }
  const distIndex = normalized.lastIndexOf(distMarker)
  if (distIndex !== -1) return { root: normalized.slice(0, distIndex), mode: "packaged" }
  return null
}

/** Resolve a direct child invocation for source and bundled Quark runtimes. */
export function resolveSubagentCommand(options: ResolveSubagentCommandOptions = {}): SubagentCommand {
  const env = options.env ?? process.env
  const execPath = options.execPath ?? process.execPath
  const argv1 = options.argv1 ?? process.argv[1] ?? ""
  const exists = options.exists ?? fs.existsSync

  if (env.QUARK_SUBAGENT_EXECUTABLE) {
    return { command: env.QUARK_SUBAGENT_EXECUTABLE, args: [] }
  }

  const entry = argv1 ? rootFromEntry(argv1) : null
  const moduleFile = fileURLToPath(options.moduleUrl ?? import.meta.url)
  const moduleLocation = rootFromEntry(moduleFile)
  const entryRoot = entry && (
    exists(path.join(entry.root, "src", "cli.ts"))
    || exists(path.join(entry.root, "dist", "cli.js"))
  ) ? entry.root : undefined
  const root = env.QUARK_DIR ?? entryRoot ?? moduleLocation?.root
  if (!root) throw new Error("Unable to resolve the Quark runtime for a subagent")

  if (entry?.mode === "packaged" && entryRoot) {
    return { command: execPath, args: [path.join(root, "dist", "cli.js")] }
  }

  const sourceCli = path.join(root, "src", "cli.ts")
  if (exists(sourceCli)) {
    const preload = path.join(root, "preload.ts")
    return {
      command: execPath,
      args: [...(exists(preload) ? ["--preload", preload] : []), sourceCli],
    }
  }
 const bundledCli = path.join(root, "dist", "cli.js")
  if (exists(bundledCli)) return { command: execPath, args: [bundledCli] }
  throw new Error(`Unable to find the Quark CLI under ${root}`)
}
