// SQLite connection + schema bootstrap
// Uses bun:sqlite + drizzle-orm/bun-sqlite for Bun runtime compatibility.
// Uses CREATE TABLE IF NOT EXISTS for simplicity (no migration files needed).

import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "../session/session.sql"
import * as os from "os"
import * as path from "path"
import * as fs from "fs"

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined

/** Persistent database path: ~/.config/quark/quark.db */
const DEFAULT_DB_PATH = path.join(os.homedir(), ".config", "quark", "quark.db")

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  title TEXT,
  directory TEXT,
  parent_session_id TEXT REFERENCES session(id),
  kind TEXT NOT NULL DEFAULT 'main' CHECK(kind IN ('main', 'subagent')),
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  model_id TEXT,
  provider_id TEXT,
  finish TEXT CHECK(finish IN ('stop', 'tool-calls', 'length')),
  cost REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  time_created INTEGER NOT NULL,
  time_completed INTEGER
);

CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  type TEXT NOT NULL CHECK(type IN ('text', 'tool', 'step-start', 'step-finish', 'summary', 'image', 'reasoning')),
  data TEXT NOT NULL
);
`

// ---------------------------------------------------------------------------
// Migrations — run after CREATE TABLE IF NOT EXISTS (which won't alter
// an existing table). Each migration is idempotent.
// ---------------------------------------------------------------------------

function migrateSessionSubagentColumns(sqlite: Database) {
  // Add parent_session_id and kind columns for sub-agent support
  const row = sqlite.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='session'").get() as { sql: string } | null
  if (!row) return
  if (row.sql.includes("parent_session_id")) return // already migrated

  sqlite.exec(`ALTER TABLE session ADD COLUMN parent_session_id TEXT REFERENCES session(id)`)
  sqlite.exec(`ALTER TABLE session ADD COLUMN kind TEXT NOT NULL DEFAULT 'main' CHECK(kind IN ('main', 'subagent'))`)
}

function migratePartTypeConstraint(sqlite: Database) {
  // Check if the current part table already allows 'image'
  // by inspecting the CREATE TABLE SQL stored in sqlite_master
  const row = sqlite.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='part'").get() as { sql: string } | null
  if (!row) return
  if (row.sql.includes("'image'")) return // already migrated

  // SQLite doesn't support ALTER CHECK — recreate the table
  sqlite.exec(`
    CREATE TABLE _part_new (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id),
      session_id TEXT NOT NULL REFERENCES session(id),
      type TEXT NOT NULL CHECK(type IN ('text', 'tool', 'step-start', 'step-finish', 'summary', 'image')),
      data TEXT NOT NULL
    );
    INSERT INTO _part_new SELECT * FROM part;
    DROP TABLE part;
    ALTER TABLE _part_new RENAME TO part;
  `)
}

function migratePartTypeConstraintReasoning(sqlite: Database) {
  // Check if the current part table already allows 'reasoning'
  const row = sqlite.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='part'").get() as { sql: string } | null
  if (!row) return
  if (row.sql.includes("'reasoning'")) return // already migrated

  // SQLite doesn't support ALTER CHECK — recreate the table
  sqlite.exec(`
    CREATE TABLE _part_new (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id),
      session_id TEXT NOT NULL REFERENCES session(id),
      type TEXT NOT NULL CHECK(type IN ('text', 'tool', 'step-start', 'step-finish', 'summary', 'image', 'reasoning')),
      data TEXT NOT NULL
    );
    INSERT INTO _part_new SELECT * FROM part;
    DROP TABLE part;
    ALTER TABLE _part_new RENAME TO part;
  `)
}

export function getDB(dbPath?: string) {
  if (_db) return _db
  const resolvedPath = dbPath ?? DEFAULT_DB_PATH
  // Ensure the parent directory exists (no-op for :memory:)
  if (resolvedPath !== ":memory:") {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  }
  const sqlite = new Database(resolvedPath, { create: true })
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA synchronous = NORMAL")
  sqlite.run("PRAGMA busy_timeout = 5000")
  sqlite.run("PRAGMA foreign_keys = ON")
  sqlite.exec(CREATE_TABLES)

  // Run idempotent migrations for existing databases
  migrateSessionSubagentColumns(sqlite)
  migratePartTypeConstraint(sqlite)
  migratePartTypeConstraintReasoning(sqlite)

  _db = drizzle({ client: sqlite, schema })
  return _db
}
