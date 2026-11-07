import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

interface FileSnapshot {
  contents: Buffer | null
  mode?: number
}

/** Child-owned undo checkpoints. Snapshot bytes never leave RAM. */
export class SubagentCheckpoints {
  private turns = new Map<string, Map<string, FileSnapshot>>()
  private currentTurn?: string
  private bytes = 0

  constructor(private readonly workspace: string, private readonly maxBytes = 64 * 1024 * 1024) {}

  begin(messageId: string): void {
    this.currentTurn = messageId
    this.turns.set(messageId, new Map())
  }

  async capture(tool: string, args: Record<string, unknown>): Promise<void> {
    if (tool !== "write" && tool !== "edit") return
    const rawPath = args.filePath ?? args.path
    if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("File checkpoint requires a file path")
    const path = isAbsolute(rawPath) ? rawPath : resolve(this.workspace, rawPath)
    const turn = this.currentTurn ? this.turns.get(this.currentTurn) : undefined
    if (!turn || turn.has(path)) return
    let snapshot: FileSnapshot
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error(`Cannot checkpoint a non-file: ${path}`)
      if (this.bytes + info.size > this.maxBytes) throw new Error("Subagent file checkpoints exceed the memory limit")
      snapshot = { contents: await readFile(path), mode: info.mode }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      snapshot = { contents: null }
    }
    // Parallel calls can target the same file: retain only the first snapshot.
    if (turn.has(path)) return
    const size = snapshot.contents?.length ?? 0
    if (this.bytes + size > this.maxBytes) throw new Error("Subagent file checkpoints exceed the memory limit")
    turn.set(path, snapshot)
    this.bytes += size
  }

  async restore(messageId: string): Promise<void> {
    const turn = this.turns.get(messageId)
    if (!turn) throw new Error(`Subagent checkpoint not found: ${messageId}`)
    for (const [path, snapshot] of turn) {
      if (snapshot.contents === null) await rm(path, { force: true })
      else {
        await writeFile(path, snapshot.contents)
        if (snapshot.mode !== undefined) await chmod(path, snapshot.mode)
      }
    }
  }

  clear(): void {
    this.turns.clear()
    this.currentTurn = undefined
    this.bytes = 0
  }
}
