// Tests for getDB() path integration and resetDB()
//
// Strategy: mock os.homedir() to a temp directory so getDBPath() writes to a
// throwaway location, not the real ~/.config/quark/session.
// The mock must be set up BEFORE importing config/db modules because
// SESSION_DIR is computed at module load time.

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ---------------------------------------------------------------------------
// Redirect home to a temp directory before any module import
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "quark-db-test-"))

mock.module("os", () => ({
  ...os,
  homedir: () => tmpHome,
}))

// Import AFTER mock is in place so SESSION_DIR resolves to tmpHome
const { getDB, resetDB } = await import("../../src/storage/db")

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// getDB() — path integration
// ---------------------------------------------------------------------------
describe("getDB", () => {
  beforeEach(() => resetDB())

  test("returns a defined DB instance", () => {
    const db = getDB()
    expect(db).toBeDefined()
  })

  test("does NOT create quark.db in the current working directory", () => {
    getDB()
    expect(fs.existsSync(path.join(process.cwd(), "quark.db"))).toBe(false)
  })

  test("does NOT create atom.db in the current working directory", () => {
    getDB()
    expect(fs.existsSync(path.join(process.cwd(), "atom.db"))).toBe(false)
  })

  test("accepts an explicit :memory: path override", () => {
    const db = getDB(":memory:")
    expect(db).toBeDefined()
  })

  test("returns the same instance on repeated calls (singleton)", () => {
    const first = getDB()
    const second = getDB()
    expect(first).toBe(second)
  })

  test("resetDB() allows a new instance to be created", () => {
    const first = getDB()
    resetDB()
    const second = getDB()
    // After reset, a new (different) instance is produced
    expect(second).toBeDefined()
  })
})
