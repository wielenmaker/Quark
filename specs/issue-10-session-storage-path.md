# Issue #10 — Fix: Session DB Stored in Project Root

## Problem

Quark currently stores its SQLite database (`quark.db`) in the **current working directory** (project root) because `getDB()` defaults to a relative path:

```ts
// src/storage/db.ts:84
const sqlite = new Database(dbPath ?? "quark.db", { create: true })
```

`bootstrap.ts` calls `getDB()` with no arguments, so the DB always lands wherever the user ran `quark` from.

## Correct Behavior

Sessions should persist at:
```
~/.config/quark/session/<project-id>/quark.db
```

Where `<project-id>` is a deterministic identifier derived from the **absolute path of the project directory** (CWD at startup). This ties each project to its own isolated session store.

## Implementation Plan

### Step 1 — Add `getDBPath(cwd?)` to `src/config/config.ts`

Add a utility that computes the canonical DB file path for a given working directory:

```ts
import { createHash } from "crypto"
import * as os from "os"
import * as path from "path"
import * as fs from "fs"

export const SESSION_DIR = path.join(os.homedir(), ".config", "quark", "session")

/**
 * Returns the DB file path for a given project directory.
 * Path: ~/.config/quark/session/<sha1-of-cwd>/quark.db
 * Creates the directory if it doesn't exist.
 */
export function getDBPath(cwd?: string): string {
  const dir = path.resolve(cwd ?? process.cwd())
  const id = createHash("sha1").update(dir).digest("hex").slice(0, 12)
  const sessionDir = path.join(SESSION_DIR, id)
  fs.mkdirSync(sessionDir, { recursive: true })
  return path.join(sessionDir, "quark.db")
}
```

**Key decisions:**
- SHA1 of the absolute CWD path → first 12 hex chars (sufficient for uniqueness)
- `mkdirSync` with `recursive: true` ensures the dir exists before DB opens
- `SESSION_DIR` exported as a constant (useful for tests and listing)

---

### Step 2 — Update `src/storage/db.ts`

Change the default DB path from `"quark.db"` to use `getDBPath()`:

```ts
import { getDBPath } from "../config/config"

export function getDB(dbPath?: string) {
  if (_db) return _db
  const resolvedPath = dbPath ?? getDBPath()
  const sqlite = new Database(resolvedPath, { create: true })
  // ... rest unchanged
}
```

- Remove the `mkdir` from `getDBPath` into db.ts if preferred (but keeping it in `getDBPath` is fine — `mkdirSync` with `recursive` is idempotent)
- `dbPath` override still works for tests that pass an in-memory path (`:memory:`)

---

### Step 3 — Verify `src/bootstrap.ts`

`bootstrap.ts` calls `getDB()` with no arguments — this already works after Step 2. No change needed.

---

### Step 4 — Reset `_db` singleton for tests

The `_db` module-level singleton in `db.ts` needs a reset function for test isolation (one may already exist — check first):

```ts
export function resetDB(): void {
  _db = undefined
}
```

---

## Tests to Write (TDD — Red First)

File: `src/storage/db.test.ts` (or alongside `src/config/config.test.ts`)

### Test suite: `getDBPath()`

```ts
describe("getDBPath", () => {
  it("returns a path inside ~/.config/quark/session/", () => {
    const p = getDBPath("/some/project")
    expect(p).toContain(path.join(os.homedir(), ".config", "quark", "session"))
    expect(p).toEndWith("/quark.db")
  })

  it("returns the same path for the same CWD", () => {
    expect(getDBPath("/foo/bar")).toBe(getDBPath("/foo/bar"))
  })

  it("returns different paths for different CWDs", () => {
    expect(getDBPath("/project/a")).not.toBe(getDBPath("/project/b"))
  })

  it("creates the session directory", () => {
    const p = getDBPath("/tmp/quark-test-project")
    expect(fs.existsSync(path.dirname(p))).toBe(true)
  })

  it("uses process.cwd() when no argument given", () => {
    const p = getDBPath()
    expect(p).toContain(path.join(os.homedir(), ".config", "quark", "session"))
  })
})
```

### Test suite: `getDB()` path integration

```ts
describe("getDB", () => {
  beforeEach(() => resetDB())

  it("opens DB at the path returned by getDBPath() by default", () => {
    // Spy or inspect: the DB should NOT be at process.cwd()/quark.db
    const db = getDB()
    expect(db).toBeDefined()
    // quark.db must NOT exist in cwd after getDB()
    expect(fs.existsSync(path.join(process.cwd(), "quark.db"))).toBe(false)
  })

  it("accepts an explicit path override (e.g. :memory:)", () => {
    const db = getDB(":memory:")
    expect(db).toBeDefined()
  })
})
```

---

## Affected Files

| File | Change |
|------|--------|
| `src/config/config.ts` | Add `getDBPath()` + `SESSION_DIR` export |
| `src/storage/db.ts` | Import `getDBPath`, use it as default, add `resetDB()` |
| `src/bootstrap.ts` | No change needed |
| `src/storage/db.test.ts` | New test file (TDD) |
| `src/config/config.test.ts` | Add `getDBPath` tests (or create if missing) |

## Dependencies

- No new npm packages — uses Node built-ins (`crypto`, `path`, `os`, `fs`)
- Bun test runner (`bun test`) for test execution

## Migration Note

Existing `quark.db` files in project roots will be orphaned (not auto-migrated). This is acceptable for now — sessions start fresh from the new path. A future migration issue can handle importing old DBs if needed.
