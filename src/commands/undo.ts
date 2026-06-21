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

import { mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
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
  /** Relative (from cwd) paths of files touched in this turn */
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
 * Convert an absolute file path to one relative to cwd.
 * Returns null if the file is outside the workspace.
 */
function toRelPath(absPath: string): string | null {
  const rel = relative(process.cwd(), absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

// ---------------------------------------------------------------------------
// Snapshot engine (Task 1)
// ---------------------------------------------------------------------------

/**
 * Snapshot a single file into the undo directory for a given turn.
 * Only snapshots files that currently exist (skip files about to be created).
 */
async function snapshotFile(
  sessionId: string,
  messageId: string,
  relPath: string,
): Promise<void> {
  const src = join(process.cwd(), relPath);
  if (!existsSync(src)) return;

  const dest = join(undoDir(sessionId, messageId), relPath);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest);
}

/**
 * Take snapshots of all listed files for a given turn.
 */
export async function takeSnapshot(
  sessionId: string,
  messageId: string,
  files: string[],
): Promise<void> {
  await Promise.all(files.map((f) => snapshotFile(sessionId, messageId, f)));
}

/**
 * Restore files from a snapshot and clean up.
 * Returns a summary of what was restored and deleted.
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

  for (const relPath of touchedFiles) {
    const workspacePath = join(process.cwd(), relPath);
    const snapPath = join(dir, relPath);

    if (existsSync(snapPath)) {
      // File existed before this turn — restore from snapshot
      await mkdir(dirname(workspacePath), { recursive: true });
      await cp(snapPath, workspacePath);
      restored.push(relPath);
    } else {
      // No snapshot → file was created this turn → delete it
      if (existsSync(workspacePath)) {
        await rm(workspacePath);
        deleted.push(relPath);
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
  for (const relPath of previousTurn.files) {
    if (!snapshottedThisTurn.has(relPath)) {
      snapshottedThisTurn.add(relPath);
      await snapshotFile(sessionId, messageId, relPath);
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
  relPath: string,
): Promise<void> {
  if (!currentTurnMsgId) return;

  const tracker = loadTracker(sessionId);
  let turn = tracker.turns.find((t) => t.messageId === currentTurnMsgId);

  if (!turn) {
    turn = { messageId: currentTurnMsgId, files: [] };
    tracker.turns.push(turn);
  }

  if (!turn.files.includes(relPath)) {
    turn.files.push(relPath);
    await saveTracker(sessionId, tracker);
  }
}

// ---------------------------------------------------------------------------
// Tool hook (Task 5) — lazy snapshot + track in toAITool()
// ---------------------------------------------------------------------------

/**
 * File-extracting tool IDs. Both use `filePath` in their args.
 */
const FILE_TOOLS = new Set(["write", "edit"]);

/**
 * Extract the file path from a tool call's arguments.
 * Returns an absolute path, or null if the tool doesn't modify files.
 */
export function extractFilePath(toolId: string, args: Record<string, unknown>): string | null {
  if (!FILE_TOOLS.has(toolId)) return null;
  const fp = args.filePath;
  if (typeof fp !== "string" || fp.length === 0) return null;
  return fp;
}

/**
 * Called in toAITool() before a write/edit tool executes.
 * Lazily snapshots the file if not already done this turn,
 * and registers it in the turn tracker.
 */
export async function toolPreExecute(
  sessionId: string,
  filePath: string,
): Promise<void> {
  if (!currentTurnMsgId) return;

  const relPath = toRelPath(filePath);
  if (!relPath) return; // outside workspace

  // Track the file for this turn
  await trackFile(sessionId, relPath);

  // Lazy snapshot — only if not already snapshotted this turn
  if (!snapshottedThisTurn.has(relPath)) {
    snapshottedThisTurn.add(relPath);
    await snapshotFile(sessionId, currentTurnMsgId, relPath);
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
