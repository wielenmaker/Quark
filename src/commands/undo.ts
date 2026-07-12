// Undo command — file snapshot engine and undo tracker
//
// Snapshots files at ~/.config/quark/session/<id>/undo/<msgId>/
// Tracks touched files per user-turn in .touched.json sidecar.
//
// Snapshot strategy (hybrid):
//   - Pre-turn: at prompt() time, proactively snapshot files from the
//     most recent completed turn (covers repeated edits to same files).
//   - Lazy fallback: in toAITool(), snapshot files not yet captured
//     this turn, right before the tool modifies them.
//
// Both are stored under the current turn's user message ID.

import { createHash } from "node:crypto";
import { mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { getSessionStorageRoot } from "../storage/session-path";
import { rewriteJSONL } from "../storage/session-jsonl";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function sessionDir(sessionId: string): string {
  return join(getSessionStorageRoot(), sessionId);
}

function undoDir(sessionId: string, messageId: string): string {
  return join(sessionDir(sessionId), "undo", messageId);
}

function trackerPath(sessionId: string): string {
  return join(sessionDir(sessionId), "undo", ".touched.json");
}

// ---------------------------------------------------------------------------
// Tracker types
// ---------------------------------------------------------------------------

interface TurnEntry {
  /** User message ID — the turn identifier */
  messageId: string;
  /** Absolute paths of files touched in this turn.
   *  Legacy entries may store relative paths — resolved against cwd on load. */
  files: string[];
}

interface TrackerData {
  turns: TurnEntry[];
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** The user message ID for the currently-executing turn. */
let currentTurnMsgId: string | null = null;

/** Files already proactively snapshotted this turn (prevents lazy duplicates). */
const snapshottedThisTurn = new Set<string>();

/** In-memory tracker cache keyed by sessionId. */
const trackerCache = new Map<string, TrackerData>();

// ---------------------------------------------------------------------------
// Tracker persistence
// ---------------------------------------------------------------------------

function loadTracker(sessionId: string): TrackerData {
  const cached = trackerCache.get(sessionId);
  if (cached) return cached;

  const p = trackerPath(sessionId);
  if (!existsSync(p)) {
    const empty: TrackerData = { turns: [] };
    trackerCache.set(sessionId, empty);
    return empty;
  }

  try {
    const raw = require("node:fs").readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as TrackerData;
    // Normalize legacy relative paths to absolute paths
    for (const turn of data.turns) {
      turn.files = turn.files.map((f) => resolve(process.cwd(), f));
    }
    trackerCache.set(sessionId, data);
    return data;
  } catch {
    const empty: TrackerData = { turns: [] };
    trackerCache.set(sessionId, empty);
    return empty;
  }
}

async function saveTracker(sessionId: string, data: TrackerData): Promise<void> {
  trackerCache.set(sessionId, data);
  const p = trackerPath(sessionId);
  await mkdir(dirname(p), { recursive: true });
  require("node:fs").writeFileSync(p, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// File path helpers
// ---------------------------------------------------------------------------

/**
 * Derive a safe snapshot key from an absolute file path.
 * Uses SHA-256 to avoid path-traversal risks and collisions.
 */
function snapshotKey(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex");
}

/**
 * Return a display-friendly path: relative if inside cwd, absolute otherwise.
 */
function displayPath(absPath: string): string {
  const rel = relative(process.cwd(), absPath);
  if (rel.startsWith("..") || resolve(rel) !== resolve(process.cwd(), rel)) return absPath;
  return rel;
}

// ---------------------------------------------------------------------------
// Snapshot engine (Task 1)
// ---------------------------------------------------------------------------

/**
 * Snapshot a single file into the undo directory for a given turn.
 * Only snapshots files that currently exist (skip files about to be created).
 * Uses SHA-256 of the absolute path as the snapshot key to safely handle
 * files anywhere on disk (inside or outside cwd).
 */
async function snapshotFile(
  sessionId: string,
  messageId: string,
  absPath: string,
): Promise<void> {
  if (!existsSync(absPath)) return;

  const dest = join(undoDir(sessionId, messageId), snapshotKey(absPath));
  await mkdir(dirname(dest), { recursive: true });
  await cp(absPath, dest);
}

/**
 * Take snapshots of all listed files for a given turn.
 */
export async function takeSnapshot(
  sessionId: string,
  messageId: string,
  files: string[],
): Promise<void> {
  await Promise.all(
    files.map((f) => snapshotFile(sessionId, messageId, resolve(process.cwd(), f))),
  );
}

/**
 * Restore files from a snapshot and clean up.
 * Returns a summary of what was restored and deleted.
 * Files inside cwd are displayed as relative paths; external files as absolute.
 */
export async function restoreFromSnapshot(
  sessionId: string,
  messageId: string,
): Promise<{ restored: string[]; deleted: string[] }> {
  const dir = undoDir(sessionId, messageId);
  const restored: string[] = [];
  const deleted: string[] = [];

  // Get the list of files touched in this turn from the tracker
  const tracker = loadTracker(sessionId);
  const turn = tracker.turns.find((t) => t.messageId === messageId);
  const touchedFiles = turn?.files ?? [];

  for (const absPath of touchedFiles) {
    const snapPath = join(dir, snapshotKey(absPath));

    if (existsSync(snapPath)) {
      // File existed before this turn — restore from snapshot
      await mkdir(dirname(absPath), { recursive: true });
      await cp(snapPath, absPath);
      restored.push(displayPath(absPath));
    } else {
      // No snapshot → file was created this turn → delete it
      if (existsSync(absPath)) {
        await rm(absPath);
        deleted.push(displayPath(absPath));
      }
    }
  }

  // Clean up snapshot directory
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  return { restored, deleted };
}

// ---------------------------------------------------------------------------
// Pre-turn snapshot (Task 4) — proactive snapshot at prompt() time
// ---------------------------------------------------------------------------

/**
 * Called at the start of prompt().
 * Proactively snapshots files from the most recent completed turn,
 * storing them under the current turn's messageId.
 *
 * This covers the common case where the agent modifies the same files
 * across multiple turns — we snapshot them before the new turn begins.
 */
export async function preTurnSnapshot(
  sessionId: string,
  messageId: string,
): Promise<void> {
  const tracker = loadTracker(sessionId);
  // Need at least 2 turns: the current turn (created by setCurrentTurn)
  // and the completed previous turn to snapshot from.
  if (tracker.turns.length < 2) return;

  const previousTurn = tracker.turns[tracker.turns.length - 2];
  if (!previousTurn || previousTurn.files.length === 0) return;

  // Snapshot files from the previous turn under the new turn's messageId
  for (const absPath of previousTurn.files) {
    if (!snapshottedThisTurn.has(absPath)) {
      snapshottedThisTurn.add(absPath);
      await snapshotFile(sessionId, messageId, absPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Turn tracking (Task 2)
// ---------------------------------------------------------------------------

/**
 * Set the current turn's user message ID.
 * Called at the start of prompt(), after saving the user message.
 *
 * Creates a TurnEntry in the tracker so /undo works even when no files
 * are modified during the turn.
 */
export function setCurrentTurn(sessionId: string, messageId: string): void {
  currentTurnMsgId = messageId;
  snapshottedThisTurn.clear();

  // Ensure a TurnEntry exists for every turn (even zero-file turns)
  const tracker = loadTracker(sessionId);
  if (!tracker.turns.some((t) => t.messageId === messageId)) {
    tracker.turns.push({ messageId, files: [] });
    saveTracker(sessionId, tracker).catch(() => {
      // Best-effort — if the write fails, /undo still works from the
      // in-memory cache this session lifetime.
    });
  }
}

/**
 * Register a file as touched in the current turn.
 * Appends to the tracker, creating a new turn entry if needed.
 */
export async function trackFile(
  sessionId: string,
  inputPath: string,
): Promise<void> {
  if (!currentTurnMsgId) return;

  const absPath = resolve(process.cwd(), inputPath);
  const tracker = loadTracker(sessionId);
  let turn = tracker.turns.find((t) => t.messageId === currentTurnMsgId);

  if (!turn) {
    turn = { messageId: currentTurnMsgId, files: [] };
    tracker.turns.push(turn);
  }

  if (!turn.files.includes(absPath)) {
    turn.files.push(absPath);
    await saveTracker(sessionId, tracker);
  }
}

// ---------------------------------------------------------------------------
// Tool hook (Task 5) — lazy snapshot + track in toAITool()
// ---------------------------------------------------------------------------

/**
 * File-extracting tool IDs.
 */
const FILE_TOOLS = new Set(["write", "edit"]);

/**
 * Extract the file path from a tool call's arguments.
 * Accepts both `args.path` (reference tools) and `args.filePath` (legacy convention).
 * Returns a canonical absolute path, or null if the tool doesn't modify files.
 */
export function extractFilePath(toolId: string, args: Record<string, unknown>): string | null {
  if (!FILE_TOOLS.has(toolId)) return null;
  const fp = (typeof args.path === "string" && args.path.length > 0)
    ? args.path
    : (typeof args.filePath === "string" && args.filePath.length > 0)
      ? args.filePath
      : null;
  if (!fp) return null;
  return resolve(process.cwd(), fp);
}

/**
 * Called in toAITool() before a write/edit tool executes.
 * Lazily snapshots the file if not already done this turn,
 * and registers it in the turn tracker.
 * Now works for files anywhere on disk (not limited to cwd).
 */
export async function toolPreExecute(
  sessionId: string,
  filePath: string,
): Promise<void> {
  if (!currentTurnMsgId) return;

  const absPath = resolve(process.cwd(), filePath);

  // Track the file for this turn
  await trackFile(sessionId, absPath);

  // Lazy snapshot — only if not already snapshotted this turn
  if (!snapshottedThisTurn.has(absPath)) {
    snapshottedThisTurn.add(absPath);
    await snapshotFile(sessionId, currentTurnMsgId, absPath);
  }
}

// ---------------------------------------------------------------------------
// Undo execution (Task 7 support)
// ---------------------------------------------------------------------------

/**
 * Undo the most recent turn for a session.
 * Returns summary of restored/deleted files, or null if nothing to undo.
 * Also removes the undone turn from the tracker.
 */
export async function undoLatest(
  sessionId: string,
): Promise<{ restored: string[]; deleted: string[]; messageId: string } | null> {
  const tracker = loadTracker(sessionId);
  const lastTurn = tracker.turns.at(-1);
  if (!lastTurn) return null;

  const result = await restoreFromSnapshot(sessionId, lastTurn.messageId);

  // Strip the undone turn from the durable JSONL log so the next model call
  // no longer sees the messages or tool results from this turn.
  rewriteJSONL(sessionId, lastTurn.messageId);

  // Remove from tracker
  tracker.turns.pop();
  await saveTracker(sessionId, tracker);

  return { ...result, messageId: lastTurn.messageId };
}

/**
 * Clear all undo history for a session (on /new, /clear, etc.).
 */
export function clearHistory(sessionId: string): void {
  trackerCache.delete(sessionId);
  const p = trackerPath(sessionId);
  try {
    require("node:fs").unlinkSync(p);
  } catch {
    // Best-effort
  }
}
