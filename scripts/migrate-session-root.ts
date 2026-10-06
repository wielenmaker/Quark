// Repair: move sessions stranded in the legacy store root into the shared
// runner namespace (`<root>/runners/`), where the CLI, TUI and ACP host look.
//
// History: commit 79b3d68 ("Add live TUI viewing for REST runner sessions",
// 2026-09-24) moved the CLI, TUI and REST runners under `runners/`. The ACP
// host (`quark acp`, added 2026-09-25) missed the switch, so every session it
// created landed in the legacy root and stayed invisible to `session/list`.
// A later fix makes the host call `useRunnerSessionRoot`; this script repairs
// sessions that predate it. Only sessions created after the split are moved —
// older records belong to the legacy store and are left untouched.
//
// Skips ids that already exist under `runners/` (collision), sessions with a
// live `active-turn/` lock, and sessions updated in the last 15 minutes (an
// already-running pre-fix agent process may still append to them). Idempotent.
//
// Usage: bun scripts/migrate-session-root.ts [--apply]
import * as fs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Commit 79b3d68, 2026-09-24T18:48:49+02:00 — when the CLI/TUI/REST writers moved into `runners/`. */
export const ROOT_SPLIT_AT_MS = Date.parse("2026-09-24T18:48:49+02:00")

/** An old agent process may still hold a session this recently touched. */
const RECENT_MS = 15 * 60_000

export interface SessionRootMigration {
  /** Session ids moved (or, in a dry run, that would be moved). */
  moved: string[]
  /** Sessions left in place, with the reason. */
  skipped: { id: string; reason: "collision" | "live" | "recent" }[]
  /** Whether the moves were actually performed. */
  apply: boolean
}

/** Move stray post-split sessions from `root` into `root/runners/`. */
export function migrateSessionRoot(root: string, apply = false): SessionRootMigration {
  const targetRoot = join(root, "runners")
  const result: SessionRootMigration = { moved: [], skipped: [], apply }
  const now = Date.now()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return result // no store on this machine
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "runners") continue
    const sourceDir = join(root, entry.name)
    const meta = readMeta(join(sourceDir, "meta.json"))
    if (!meta || (meta.timeCreated ?? 0) < ROOT_SPLIT_AT_MS || meta.kind === "ephemeral") continue
    if (fs.existsSync(join(targetRoot, entry.name))) {
      result.skipped.push({ id: entry.name, reason: "collision" })
      continue
    }
    if (fs.existsSync(join(sourceDir, "active-turn"))) {
      result.skipped.push({ id: entry.name, reason: "live" })
      continue
    }
    if (now - (meta.timeUpdated ?? meta.timeCreated ?? 0) < RECENT_MS) {
      result.skipped.push({ id: entry.name, reason: "recent" })
      continue
    }
    if (apply) {
      fs.mkdirSync(targetRoot, { recursive: true })
      fs.renameSync(sourceDir, join(targetRoot, entry.name))
    }
    result.moved.push(entry.name)
  }
  if (apply && (result.moved.length > 0 || fs.existsSync(join(targetRoot, "index.json")))) {
    // `index.json` is a derived cache, and `scanSessionMetas` trusts it as long
    // as it exists. Moving files behind its back would otherwise leave every
    // list() reading the pre-move index; dropping it forces a rebuild from the
    // meta.json files on the next listing.
    fs.rmSync(join(targetRoot, "index.json"), { force: true })
  }
  result.moved.sort()
  return result
}

function readMeta(file: string): { timeCreated?: number; timeUpdated?: number; kind?: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      session?: { timeCreated?: number; timeUpdated?: number; kind?: string }
    }
    return parsed.session ?? null
  } catch {
    return null
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg) => arg !== "--apply")
  if (unknown.length) {
    console.error(`Unknown argument: ${unknown[0]}. Usage: bun scripts/migrate-session-root.ts [--apply]`)
    process.exit(1)
  }
  const apply = args.includes("--apply")
  const root = join(homedir(), ".config", "quark", "session")
  const result = migrateSessionRoot(root, apply)
  for (const id of result.moved) console.log(`${apply ? "moved" : "would move"} ${id}`)
  for (const skip of result.skipped) console.log(`skip  ${skip.id} (${skip.reason})`)
  console.log(
    `${apply ? "Moved" : "Would move"} ${result.moved.length} session(s) into ${join(root, "runners")}` +
      (apply ? "" : `; pass --apply to run for real`),
  )
}
