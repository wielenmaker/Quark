import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { scanSessionMetas } from "../../packages/runner/src/storage/session-jsonl"
import { ROOT_SPLIT_AT_MS, migrateSessionRoot } from "../../scripts/migrate-session-root"

const AFTER_SPLIT = ROOT_SPLIT_AT_MS + 60_000
const BEFORE_SPLIT = ROOT_SPLIT_AT_MS - 60_000

function fixture(fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quark-session-root-"))
  try {
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function session(
  root: string,
  id: string,
  opts: { created: number; kind?: string; lock?: boolean; updated?: number },
) {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "session.jsonl"), "")
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      v: 1,
      session: {
        id,
        kind: opts.kind ?? "main",
        timeCreated: opts.created,
        timeUpdated: opts.updated ?? opts.created,
      },
    }),
  )
  if (opts.lock) fs.mkdirSync(path.join(dir, "active-turn"))
}

describe("session root repair", () => {
  test("moves post-split strays; keeps legacy, live and colliding sessions; repeats safely", () =>
    fixture((root) => {
      session(root, "stray", { created: AFTER_SPLIT })
      session(root, "legacy", { created: BEFORE_SPLIT })
      session(root, "live-stray", { created: AFTER_SPLIT, lock: true })
      session(root, "hot", { created: AFTER_SPLIT, updated: Date.now() })
      session(root, "collides", { created: AFTER_SPLIT })
      session(root, "subagent-stray", { created: AFTER_SPLIT, kind: "subagent" })
      const runners = path.join(root, "runners")
      fs.mkdirSync(runners)
      session(runners, "collides", { created: AFTER_SPLIT })
      // A stale aggregate index must not survive the move, or list() keeps
      // serving the pre-move snapshot (scanSessionMetas trusts index.json).
      fs.writeFileSync(path.join(runners, "index.json"), JSON.stringify({ v: 1, sessions: [] }))

      // Dry run is read-only and reports what would move.
      const dry = migrateSessionRoot(root, false)
      expect(dry.moved).toEqual(["stray", "subagent-stray"])
      expect(fs.existsSync(path.join(root, "stray"))).toBe(true)

      const report = migrateSessionRoot(root, true)
      expect(report.moved).toEqual(["stray", "subagent-stray"])
      expect([...report.skipped].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "collides", reason: "collision" },
        { id: "hot", reason: "recent" },
        { id: "live-stray", reason: "live" },
      ])

      expect(fs.existsSync(path.join(runners, "stray", "meta.json"))).toBe(true)
      expect(fs.existsSync(path.join(runners, "subagent-stray", "meta.json"))).toBe(true)
      expect(fs.existsSync(path.join(root, "stray"))).toBe(false)
      expect(fs.existsSync(path.join(root, "legacy", "session.jsonl"))).toBe(true)
      expect(fs.existsSync(path.join(root, "live-stray"))).toBe(true)

      // The stale index is dropped, and a fresh listing sees the moved sessions.
      expect(fs.existsSync(path.join(runners, "index.json"))).toBe(false)
      const visible = scanSessionMetas(runners).map((s) => s.id).sort()
      expect(visible).toContain("stray")
      expect(visible).toContain("subagent-stray")

      // Idempotent: a second apply finds nothing new.
      expect(migrateSessionRoot(root, true).moved).toEqual([])
    }))
})
