// Low-level JSONL filesystem operations for session storage
//
// All functions are synchronous (Bun fs is sync-friendly) except where noted.
// Each session is stored in its own directory:
//   ~/.config/quark/session/<id>/session.jsonl   — append-only event log
//   ~/.config/quark/session/<id>/meta.json       — derived cache
//
// Write strategy:
//   - JSONL: open(O_APPEND | O_WRONLY), write, close — no locking needed
//   - meta.json: write to .tmp, rename (atomic on POSIX)

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import {
  getSessionDir,
  getSessionLogPath,
  getSessionMetaPath,
  getSessionStorageRoot,
} from "./session-path"
import type {
  SessionLogEvent,
  SessionEvent,
  SessionMetaFile,
} from "./session-format"
import { isEphemeral, type Session } from "../session/session"
import type { MessageRow, PartRow } from "../session/message"

// ---------------------------------------------------------------------------
// In-memory event store for ephemeral sessions (never written to disk)
// ---------------------------------------------------------------------------

const ephemeralEvents = new Map<string, SessionLogEvent[]>()

function normalizeSession(session: Session): Session {
  return {
    ...session,
    title: session.title ?? null,
    directory: session.directory ?? null,
    parentSessionId: session.parentSessionId ?? null,
    kind: session.kind ?? "main",
    taskId: session.taskId ?? null,
    summary: session.summary ?? null,
    parentSummary: session.parentSummary ?? null,
    filesModified: session.filesModified ?? null,
  }
}

// ---------------------------------------------------------------------------
// ensureStorageRoot — create the top-level session directory
// ---------------------------------------------------------------------------

/**
 * Ensure the top-level session storage directory exists
 * (e.g. `~/.config/quark/session/`).
 *
 * Idempotent — safe to call repeatedly. Called once at startup before any
 * session reads/writes so downstream `mkdirSync(dir, { recursive: true })`
 * calls have a parent to land under.
 */
export function ensureStorageRoot(): void {
  mkdirSync(getSessionStorageRoot(), { recursive: true })
}

// ---------------------------------------------------------------------------
// createSessionLog — create dir + write first event + meta.json
// ---------------------------------------------------------------------------

/**
 * Initialize a new session on disk.
 *
 * Creates `~/.config/quark/session/<id>/`, writes the first JSONL line
 * (a `SessionEvent` carrying the full `Session` object), and seeds the
 * `meta.json` cache so the session shows up in listings without a replay.
 *
 * Must be called exactly once per session before any `appendEvents()` calls.
 * Ephemeral sessions skip this entirely (they live only in `ephemeralEvents`).
 */
export function createSessionLog(session: Session): void {
  const dir = getSessionDir(session.id)
  mkdirSync(dir, { recursive: true })

  const event: SessionEvent = {
    v: 1,
    ts: Date.now(),
    sessionId: session.id,
    type: "session",
    session,
  }

  writeFileSync(getSessionLogPath(session.id), JSON.stringify(event) + "\n")
  writeMetaAtomic(session.id, session)
}

// ---------------------------------------------------------------------------
// appendEvents — append one or more events to the JSONL file
//
// If metaPatch is provided, atomically rewrite meta.json with the patch
// applied to the current session object.
// ---------------------------------------------------------------------------

/**
 * Append one or more events to a session's JSONL log.
 *
 * This is the **only** write path for session content — every message,
 * part snapshot, and message-end goes through here. Writes are
 * append-only (`appendFileSync` opens with `O_APPEND | O_WRONLY`), which
 * is atomic on POSIX, so no locking is needed even with concurrent writers.
 *
 * - Ephemeral sessions: events are buffered in the in-memory
 *   `ephemeralEvents` map and never touch disk.
 * - `metaPatch`: optional shallow merge applied to the cached `Session`
 *   object in `meta.json`. Used for things like title updates and
 *   `timeUpdated` bumps so listings stay fresh without a full replay.
 *
 * No-op when `events` is empty.
 */
export function appendEvents(
  sessionId: string,
  events: SessionLogEvent[],
  metaPatch?: Partial<Session>,
): void {
  if (events.length === 0) return

  // Ephemeral sessions: store in memory, never touch disk
  if (isEphemeral(sessionId)) {
    const existing = ephemeralEvents.get(sessionId) ?? []
    existing.push(...events)
    ephemeralEvents.set(sessionId, existing)
    return
  }

  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  appendFileSync(getSessionLogPath(sessionId), lines)

  if (metaPatch) {
    // Read current meta, apply patch, rewrite
    const current = readSessionMeta(sessionId)
    if (current) {
      const updated = { ...current, ...metaPatch }
      writeMetaAtomic(sessionId, updated)
    }
  }
}

// ---------------------------------------------------------------------------
// readSessionMeta — read meta.json for a session
// ---------------------------------------------------------------------------

/**
 * Read the cached `Session` object from `meta.json`.
 *
 * Fast path that avoids replaying the JSONL log — used by listings,
 * `appendEvents`'s metaPatch merge, and anywhere only the session
 * envelope is needed (title, timestamps, model preference).
 *
 * Returns `null` if the file is missing, unreadable, malformed JSON,
 * or carries a different schema version. Callers can fall back to
 * `rebuildSessionMeta()` to regenerate it from the JSONL.
 */
export function readSessionMeta(sessionId: string): Session | null {
  const path = getSessionMetaPath(sessionId)
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as SessionMetaFile
    if (parsed.v === 1 && parsed.session) return normalizeSession(parsed.session)
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// scanSessionMetas — scan all meta.json files for session listing
// ---------------------------------------------------------------------------

/**
 * Enumerate every session by reading each subdirectory's `meta.json`.
 *
 * This powers the `/sessions` picker in the TUI and any "recent sessions"
 * listing. It deliberately reads only the cached metadata — never replays
 * a JSONL — so it stays O(N) in the number of sessions, not O(events).
 *
 * Corrupt or missing `meta.json` files are silently skipped; callers can
 * trigger `rebuildSessionMeta()` to recover them. Returns an empty array
 * if the storage root doesn't exist yet (fresh install).
 */
export function scanSessionMetas(): Session[] {
  const root = getSessionStorageRoot()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }

  const sessions: Session[] = []
  for (const entry of entries) {
    const metaPath = join(root, entry, "meta.json")
    try {
      const raw = readFileSync(metaPath, "utf-8")
      const parsed = JSON.parse(raw) as SessionMetaFile
      if (parsed.v === 1 && parsed.session) {
        sessions.push(normalizeSession(parsed.session))
      }
    } catch {
      // Skip corrupt or missing meta.json — can be rebuilt from JSONL
      continue
    }
  }

  return sessions
}

// ---------------------------------------------------------------------------
// replaySessionFile — full replay of session.jsonl → { session, messages, parts }
//
// Reads the entire file and materializes the final state.
// ---------------------------------------------------------------------------

/**
 * Load and reconstruct a session's full state from disk.
 *
 * This is the **read counterpart** to `appendEvents`. It reads every line
 * of `session.jsonl`, parses each into a `SessionLogEvent`, and folds them
 * via `replayEvents()` into the materialized shape consumers expect:
 * `{ session, messages: MessageRow[], parts: PartRow[] }`.
 *
 * - Ephemeral sessions: replay from the in-memory `ephemeralEvents` map.
 * - Missing/unreadable file: returns empty state (used on first session open).
 * - Malformed lines: silently skipped so a single bad write can't brick a
 *   whole session.
 *
 * Cost is O(events). For very long sessions this is the most expensive
 * read in the system — `meta.json` exists precisely to avoid calling it
 * just to render a session list.
 */
export function replaySessionFile(sessionId: string): {
  session: Session | null
  messages: MessageRow[]
  parts: PartRow[]
} {
  // Ephemeral sessions: replay from in-memory event store
  const memEvents = ephemeralEvents.get(sessionId)
  if (isEphemeral(sessionId) || memEvents) {
    return replayEvents(memEvents ?? [])
  }

  const logPath = getSessionLogPath(sessionId)
  let raw: string
  try {
    raw = readFileSync(logPath, "utf-8")
  } catch {
    return { session: null, messages: [], parts: [] }
  }

  const events: SessionLogEvent[] = []
  const lines = raw.split("\n")
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as SessionLogEvent)
    } catch {
      continue
    }
  }

  return replayEvents(events)
}

/**
 * Fold an ordered list of `SessionLogEvent`s into materialized state.
 *
 * This is the heart of the event-sourcing design — the function that
 * collapses many on-disk events into the in-memory rows consumers use:
 *
 *   - `SessionEvent`        → set the current `Session`
 *   - `SessionUpdateEvent`  → patch fields on the current `Session`
 *   - `MessageEvent`        → insert a new `MessageRow` (open envelope)
 *   - `PartEvent`           → upsert a `PartRow` keyed by `partId`
 *                             (later events with the same `partId`
 *                             overwrite earlier ones — this is how
 *                             streaming text deltas accumulate into a
 *                             single final row)
 *   - `MessageEndEvent`     → close the matching `MessageRow` with
 *                             finish reason, tokens, cost, completion ts
 *
 * Both maps preserve insertion order (chronological), so the returned
 * arrays are in the order messages/parts first appeared in the log.
 *
 * Pure / side-effect-free — used by both disk replay and ephemeral
 * in-memory replay.
 */
function replayEvents(events: SessionLogEvent[]): {
  session: Session | null
  messages: MessageRow[]
  parts: PartRow[]
} {
  let session: Session | null = null
  const messagesMap = new Map<string, MessageRow>()
  const partsMap = new Map<string, PartRow>()

  for (const event of events) {
    switch (event.type) {
      case "session": {
        session = normalizeSession(event.session)
        break
      }

      case "session-update": {
        if (session) {
          if (event.patch.title !== undefined) session.title = event.patch.title
          if (event.patch.taskId !== undefined) session.taskId = event.patch.taskId
          if (event.patch.summary !== undefined) session.summary = event.patch.summary
          if (event.patch.parentSummary !== undefined) session.parentSummary = event.patch.parentSummary
          if (event.patch.filesModified !== undefined) session.filesModified = event.patch.filesModified
          if (event.patch.timeUpdated !== undefined) session.timeUpdated = event.patch.timeUpdated
        }
        break
      }

      case "message": {
        const row: MessageRow = {
          id: event.messageId,
          sessionId: event.sessionId,
          role: event.role,
          modelId: event.modelId,
          providerId: event.providerId,
          finish: null,
          cost: null,
          tokensIn: null,
          tokensOut: null,
          timeCreated: event.timeCreated,
          timeCompleted: null,
        }
        messagesMap.set(event.messageId, row)
        break
      }

      case "part": {
        // For the same partId, later events overwrite earlier ones
        // (this is how appendPartSnapshot replaces updatePart)
        const row: PartRow = {
          id: event.partId,
          messageId: event.messageId,
          sessionId: event.sessionId,
          type: event.partType,
          data: typeof event.data === "string" ? event.data : JSON.stringify(event.data),
        }
        partsMap.set(event.partId, row)
        break
      }

      case "message-end": {
        const msg = messagesMap.get(event.messageId)
        if (msg) {
          msg.finish = event.finish
          msg.cost = event.cost
          msg.tokensIn = event.tokensIn
          msg.tokensOut = event.tokensOut
          msg.timeCompleted = event.timeCompleted
        }
        break
      }
    }
  }

  // Convert maps to arrays, preserving insertion order (which is chronological)
  const messages = Array.from(messagesMap.values())
  const parts = Array.from(partsMap.values())

  return { session, messages, parts }
}

// ---------------------------------------------------------------------------
// rewriteJSONL — strip all events from a given message onward
//
// Used by /undo to make the durable log match the undone state. Finds the
// first `message` event with the matching `messageId` and removes that line
// plus every event after it. Earlier events (session envelope, previous
// messages) are preserved.
//
// Ephemeral sessions mutate the in-memory event array instead of disk.
// ---------------------------------------------------------------------------

function filterEventsFromMessageId(
  events: SessionLogEvent[],
  fromMessageId: string,
): SessionLogEvent[] {
  const idx = events.findIndex(
    (e) => e.type === "message" && e.messageId === fromMessageId,
  )
  if (idx === -1) return events
  return events.slice(0, idx)
}

export function rewriteJSONL(sessionId: string, fromMessageId: string): void {
  // Ephemeral sessions: filter the in-memory event array
  const memEvents = ephemeralEvents.get(sessionId)
  if (isEphemeral(sessionId) || memEvents) {
    const filtered = filterEventsFromMessageId(memEvents ?? [], fromMessageId)
    ephemeralEvents.set(sessionId, filtered)
    return
  }

  const logPath = getSessionLogPath(sessionId)
  let raw: string
  try {
    raw = readFileSync(logPath, "utf-8")
  } catch {
    return
  }

  const lines = raw.split("\n")
  let cutIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    try {
      const event = JSON.parse(line) as SessionLogEvent
      if (event.type === "message" && event.messageId === fromMessageId) {
        cutIndex = i
        break
      }
    } catch {
      continue
    }
  }

  if (cutIndex === -1) return

  const keptLines = lines.slice(0, cutIndex)
  const newContent = keptLines.join("\n") + "\n"

  // Atomic write: temp file then rename
  const tmpPath = logPath + ".tmp"
  writeFileSync(tmpPath, newContent)
  renameSync(tmpPath, logPath)
}

// ---------------------------------------------------------------------------
// rebuildSessionMeta — replay JSONL + rewrite meta.json
// ---------------------------------------------------------------------------

/**
 * Recover a session's `meta.json` from the source-of-truth JSONL log.
 *
 * Used when the cache is missing, corrupt, or out of sync — for example
 * after a crash mid-write, manual file deletion, or a schema migration.
 * Replays the full log to extract the latest `Session` envelope, then
 * atomically rewrites `meta.json`.
 *
 * Returns the rebuilt `Session`, or `null` if the JSONL has no
 * `SessionEvent` (which would mean the session never existed).
 */
export function rebuildSessionMeta(sessionId: string): Session | null {
  const { session } = replaySessionFile(sessionId)
  if (session) {
    writeMetaAtomic(sessionId, session)
  }
  return session
}

// ---------------------------------------------------------------------------
// Internal: atomic meta.json write (write .tmp + rename)
// ---------------------------------------------------------------------------

/**
 * Write `meta.json` atomically using the write-temp-then-rename pattern.
 *
 * Steps:
 *   1. Serialize `{ v: 1, session }` to `meta.json.tmp`
 *   2. `rename()` the tmp file over `meta.json`
 *
 * `rename()` is atomic on POSIX filesystems, so readers (e.g.
 * `scanSessionMetas` running in another process or thread) will only
 * ever see the old complete file or the new complete file — never a
 * half-written one. This guards against torn writes if the process is
 * killed mid-flush.
 *
 * Internal helper — all callers go through `appendEvents` (with metaPatch),
 * `createSessionLog`, or `rebuildSessionMeta`.
 */
function writeMetaAtomic(sessionId: string, session: Session): void {
  const metaPath = getSessionMetaPath(sessionId)
  const tmpPath = metaPath + ".tmp"
  const meta: SessionMetaFile = { v: 1, session }
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2))
  renameSync(tmpPath, metaPath)
}
