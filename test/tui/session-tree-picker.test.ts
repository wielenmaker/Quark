import { describe, expect, test } from "bun:test"
import {
  buildSessionTreeRows,
  firstSelectableSessionRow,
  formatRelativeTime,
  moveSessionRowSelection,
  searchSessionTree,
  type SessionTreeInput,
} from "../../src/tui/session-tree-picker"

const day = (month: number, date: number) => new Date(2026, month - 1, date, 12).getTime()

describe("session tree picker", () => {
  test("groups sessions by root lineage and renders branches once", () => {
    const sessions: SessionTreeInput[] = [
      { id: "rotation", title: "Add refresh token rotation", parentSessionId: "root", timeUpdated: day(5, 4) },
      { id: "cookies", title: "Move tokens to cookies", parentSessionId: "root", timeUpdated: day(5, 5) },
      { id: "csrf", title: "Add CSRF protection", parentSessionId: "cookies", timeUpdated: day(5, 6) },
      { id: "root", title: "Workspace Auth Cleanup", parentSessionId: null, timeUpdated: day(5, 3) },
      { id: "login", title: "Fix Login Redirect Loop", parentSessionId: null, timeUpdated: day(5, 2) },
    ]

    const rows = buildSessionTreeRows(sessions, "csrf", day(5, 10))
    expect(rows.filter((row) => row.type === "session").map((row) => row.id)).toEqual([
      "root", "cookies", "csrf", "rotation", "login",
    ])
    expect(rows[0]).toMatchObject({
      type: "session", id: "root", label: "Workspace Auth Cleanup", detail: "original · 1w ago", connector: "root",
    })
    expect(rows[2]).toMatchObject({
      type: "session", id: "csrf", label: "Add CSRF protection", detail: "branch · 4d ago", current: true,
    })
  })

  test("keeps unrelated single sessions compact", () => {
    const rows = buildSessionTreeRows([
      { id: "one", title: "First", timeUpdated: day(5, 2) },
      { id: "two", title: "Second", timeUpdated: day(5, 1) },
    ], null, day(5, 10))

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.type)).toEqual(["session", "session"])
  })

  test("moves selection between session rows only", () => {
    const rows = buildSessionTreeRows([
      { id: "child", title: "Child", parentSessionId: "root", timeUpdated: day(5, 4) },
      { id: "root", title: "Root", timeUpdated: day(5, 3) },
      { id: "other", title: "Other", timeUpdated: day(5, 2) },
    ], "child")

    const selected = firstSelectableSessionRow(rows, "child")
    expect(rows[moveSessionRowSelection(rows, selected, -1)]).toMatchObject({ id: "root" })
    expect(rows[moveSessionRowSelection(rows, selected, 1)]).toMatchObject({ id: "other" })
  })

  test("searches titles and keeps matching ancestors", () => {
    const sessions: SessionTreeInput[] = [
      { id: "root", title: "Workspace Auth Cleanup", timeUpdated: day(5, 3) },
      { id: "child", title: "Add refresh token rotation", parentSessionId: "root", timeUpdated: day(5, 4) },
      { id: "other", title: "Fix login redirect", timeUpdated: day(5, 5) },
    ]

    expect(searchSessionTree(sessions, "rotation")).toEqual({
      sessions: sessions.slice(0, 2),
      firstMatchId: "child",
    })
  })

  test("separates pinned lineages from recent sessions", () => {
    const rows = buildSessionTreeRows([
      { id: "newer", title: "Newer session", timeUpdated: day(5, 8) },
      { id: "pinned", title: "Pinned session", pinned: true, timeUpdated: day(5, 1) },
    ], null, day(5, 10))

    expect(rows).toMatchObject([
      { type: "divider", label: "Pinned" },
      { id: "pinned", detail: "pinned · 1w ago" },
      { type: "divider", label: "Recent" },
      { id: "newer" },
    ])
  })

  test("formats activity time for quick scanning", () => {
    const now = day(5, 10)
    expect(formatRelativeTime(now - 30_000, now)).toBe("now")
    expect(formatRelativeTime(now - 8 * 60_000, now)).toBe("8m ago")
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(formatRelativeTime(now - 14 * 86_400_000, now)).toBe("2w ago")
  })

  test("shows and searches changed-file metadata", () => {
    const sessions: SessionTreeInput[] = [{
      id: "files",
      title: "Update middleware",
      filesModified: ["src/auth.ts", "src/session.ts", "src/auth.ts"],
      timeUpdated: day(5, 9),
    }]

    expect(buildSessionTreeRows(sessions, null, day(5, 10))[0]).toMatchObject({
      label: "Update middleware", detail: "2 files · 1d ago",
    })
    expect(searchSessionTree(sessions, "session.ts").firstMatchId).toBe("files")
  })

  test("marks a running session", () => {
    const rows = buildSessionTreeRows([{
      id: "running", title: "Active session", running: true, timeUpdated: day(5, 10),
    }], "running", day(5, 10))

    expect(rows[0]).toMatchObject({ id: "running", detail: "● running · now", running: true })
  })
})
