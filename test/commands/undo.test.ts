// Undo command — integration tests
//
// Tests the snapshot engine, tracker persistence, and undo execution
// in a real filesystem with temp directories.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { setSessionStorageRoot, getSessionStorageRoot } from "../../src/storage/session-path";
import {
  setCurrentTurn,
  preTurnSnapshot,
  trackFile,
  takeSnapshot,
  undoLatest,
  clearHistory,
  extractFilePath,
  toolPreExecute,
} from "../../src/commands/undo";

let workspace: string;
let storageRoot: string;
const sessionId = "test-session-undo";
const turn1Id = "turn-msg-1";
const turn2Id = "turn-msg-2";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "quark-undo-workspace-"));
  storageRoot = mkdtempSync(join(tmpdir(), "quark-undo-storage-"));
  setSessionStorageRoot(storageRoot);

  // Change cwd to the temp workspace (restored after test)
  const origCwd = process.cwd;
  process.cwd = () => workspace;

  // Clean up after test
  return () => {
    process.cwd = origCwd;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  };
});

// Helper to create a file in the workspace
function createFile(relPath: string, content: string): void {
  const abs = join(workspace, relPath);
  const dir = join(workspace, relPath).split("/").slice(0, -1).join("/") || workspace;
  const { mkdirSync } = require("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
}

// Helper to read a file from workspace
function readFile(relPath: string): string {
  return readFileSync(join(workspace, relPath), "utf-8");
}

// ---------------------------------------------------------------------------
// extractFilePath
// ---------------------------------------------------------------------------

describe("extractFilePath", () => {
  test("extracts filePath from write tool args", () => {
    const result = extractFilePath("write", { filePath: "/tmp/foo.ts" });
    expect(result).toBe("/tmp/foo.ts");
  });

  test("extracts filePath from edit tool args", () => {
    const result = extractFilePath("edit", { filePath: "/tmp/foo.ts" });
    expect(result).toBe("/tmp/foo.ts");
  });

  test("returns null for non-file tools", () => {
    expect(extractFilePath("read", { filePath: "/tmp/foo.ts" })).toBeNull();
    expect(extractFilePath("bash", { command: "echo hi" })).toBeNull();
  });

  test("returns null for missing filePath", () => {
    expect(extractFilePath("write", {})).toBeNull();
    expect(extractFilePath("write", { filePath: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Core undo flow: snapshot → modify → undo → verify restored
// ---------------------------------------------------------------------------

describe("undo flow", () => {
  test("snapshot, modify, undo restores file content", async () => {
    createFile("src/app.ts", "original content");

    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "src/app.ts");
    await takeSnapshot(sessionId, turn1Id, ["src/app.ts"]);

    // Simulate agent modification
    writeFileSync(join(workspace, "src/app.ts"), "modified content");

    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.restored).toEqual(["src/app.ts"]);
    expect(result!.deleted).toEqual([]);

    expect(readFile("src/app.ts")).toBe("original content");
  });

  test("undo deletes files created during the turn", async () => {
    // File doesn't exist before turn — write tool creates it
    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "new-file.md");
    // No snapshot taken (file didn't exist yet)

    // Simulate agent creating the file
    createFile("new-file.md", "newly created");

    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.restored).toEqual([]);
    expect(result!.deleted).toEqual(["new-file.md"]);

    expect(existsSync(join(workspace, "new-file.md"))).toBe(false);
  });

  test("undo restores correct state with multiple files", async () => {
    createFile("a.ts", "a-original");
    createFile("b.ts", "b-original");
    createFile("c.ts", "c-original");

    setCurrentTurn(sessionId, turn1Id);

    // Track and snapshot a.ts and b.ts (agent modifies these)
    await trackFile(sessionId, "a.ts");
    await trackFile(sessionId, "b.ts");
    await takeSnapshot(sessionId, turn1Id, ["a.ts", "b.ts"]);

    // Agent modifies them
    writeFileSync(join(workspace, "a.ts"), "a-modified");
    writeFileSync(join(workspace, "b.ts"), "b-modified");
    // c.ts is untouched

    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.restored.sort()).toEqual(["a.ts", "b.ts"]);
    expect(result!.deleted).toEqual([]);

    expect(readFile("a.ts")).toBe("a-original");
    expect(readFile("b.ts")).toBe("b-original");
    expect(readFile("c.ts")).toBe("c-original"); // unchanged
  });

  test("undo handles files in subdirectories", async () => {
    createFile("src/utils/helper.ts", "original helper");

    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "src/utils/helper.ts");
    await takeSnapshot(sessionId, turn1Id, ["src/utils/helper.ts"]);

    writeFileSync(join(workspace, "src/utils/helper.ts"), "modified helper");

    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.restored).toEqual(["src/utils/helper.ts"]);

    expect(readFile("src/utils/helper.ts")).toBe("original helper");
  });
});

// ---------------------------------------------------------------------------
// Chained undo (multiple turns)
// ---------------------------------------------------------------------------

describe("chained undo", () => {
  test("chained undo walks back multiple turns", async () => {
    createFile("shared.ts", "version-0");

    // Turn 1: modify shared.ts
    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "shared.ts");
    await takeSnapshot(sessionId, turn1Id, ["shared.ts"]);
    writeFileSync(join(workspace, "shared.ts"), "version-1");

    // Turn 2: modify shared.ts again + create new file
    setCurrentTurn(sessionId, turn2Id);
    await trackFile(sessionId, "shared.ts");
    await trackFile(sessionId, "new.ts");
    await takeSnapshot(sessionId, turn2Id, ["shared.ts"]); // shared.ts only — new.ts is new
    writeFileSync(join(workspace, "shared.ts"), "version-2");
    createFile("new.ts", "new file");

    // Undo turn 2
    const result2 = await undoLatest(sessionId);
    expect(result2).not.toBeNull();
    expect(result2!.messageId).toBe(turn2Id);
    expect(readFile("shared.ts")).toBe("version-1");
    expect(existsSync(join(workspace, "new.ts"))).toBe(false);

    // Undo turn 1
    const result1 = await undoLatest(sessionId);
    expect(result1).not.toBeNull();
    expect(result1!.messageId).toBe(turn1Id);
    expect(readFile("shared.ts")).toBe("version-0");
  });

  test("undoLatest returns null when no turns remain", async () => {
    const result = await undoLatest(sessionId);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toolPreExecute (lazy snapshot + track)
// ---------------------------------------------------------------------------

describe("toolPreExecute", () => {
  test("snapshots and tracks a file lazily", async () => {
    createFile("lazy.ts", "lazy-original");

    setCurrentTurn(sessionId, turn1Id);
    await toolPreExecute(sessionId, join(workspace, "lazy.ts"));

    // Modify the file
    writeFileSync(join(workspace, "lazy.ts"), "lazy-modified");

    // Undo
    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.restored).toEqual(["lazy.ts"]);
    expect(readFile("lazy.ts")).toBe("lazy-original");
  });

  test("skips files outside workspace", async () => {
    setCurrentTurn(sessionId, turn1Id);
    await toolPreExecute(sessionId, "/etc/passwd");

    // Should not track or snapshot anything — but the turn still exists
    // (zero files), so undo succeeds with no files to restore
    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.restored).toEqual([]);
    expect(result!.deleted).toEqual([]);
    expect(result!.messageId).toBe(turn1Id);
  });

  test("only snapshots a file once per turn", async () => {
    createFile("multi.ts", "multi-original");

    setCurrentTurn(sessionId, turn1Id);

    // First modification: snapshot should happen
    await toolPreExecute(sessionId, join(workspace, "multi.ts"));
    writeFileSync(join(workspace, "multi.ts"), "multi-v1");

    // Second modification (same turn): no duplicate snapshot
    await toolPreExecute(sessionId, join(workspace, "multi.ts"));
    writeFileSync(join(workspace, "multi.ts"), "multi-v2");

    // Undo should restore to original (first snapshot)
    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(readFile("multi.ts")).toBe("multi-original");
  });
});

// ---------------------------------------------------------------------------
// preTurnSnapshot (proactive snapshot)
// ---------------------------------------------------------------------------

describe("preTurnSnapshot", () => {
  test("proactively snapshots files from previous turn", async () => {
    createFile("proactive.ts", "proactive-original");

    // Turn 1: track and modify the file
    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "proactive.ts");
    await takeSnapshot(sessionId, turn1Id, ["proactive.ts"]);
    writeFileSync(join(workspace, "proactive.ts"), "proactive-v1");

    // Turn 2: proactive snapshot of files from turn 1
    setCurrentTurn(sessionId, turn2Id);
    await preTurnSnapshot(sessionId, turn2Id);

    // Now modify in turn 2
    writeFileSync(join(workspace, "proactive.ts"), "proactive-v2");
    await trackFile(sessionId, "proactive.ts");

    // Undo turn 2 — should restore to proactive-v1
    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(turn2Id);
    expect(readFile("proactive.ts")).toBe("proactive-v1");
  });
});

// ---------------------------------------------------------------------------
// JSONL rewrite on undo
// ---------------------------------------------------------------------------

function writeSessionJSONL(sessionId: string, lines: string[]): void {
  const dir = join(getSessionStorageRoot(), sessionId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "session.jsonl");
  writeFileSync(logPath, lines.join("\n") + "\n");
}

function readSessionJSONL(sessionId: string): string[] {
  const logPath = join(getSessionStorageRoot(), sessionId, "session.jsonl");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim());
}

describe("JSONL rewrite on undo", () => {
  test("undo truncates the undone turn from session.jsonl", async () => {
    createFile("jsonl-undo.ts", "original");

    writeSessionJSONL(sessionId, [
      JSON.stringify({ v: 1, ts: 1, sessionId, type: "session", session: { id: sessionId, title: null, directory: workspace, parentSessionId: null, kind: "main", taskId: null, summary: null, parentSummary: null, filesModified: null, timeCreated: 1, timeUpdated: 1 } }),
      JSON.stringify({ v: 1, ts: 2, sessionId, type: "message", messageId: turn1Id, role: "user", modelId: null, providerId: null, timeCreated: 2 }),
      JSON.stringify({ v: 1, ts: 3, sessionId, type: "part", messageId: turn1Id, partId: "part-user-1", partType: "text", data: { text: "hello" } }),
      JSON.stringify({ v: 1, ts: 4, sessionId, type: "message-end", messageId: turn1Id, finish: "stop", cost: null, tokensIn: null, tokensOut: null, timeCompleted: 4 }),
      JSON.stringify({ v: 1, ts: 5, sessionId, type: "message", messageId: "assistant-1", role: "assistant", modelId: "test/model", providerId: "test", timeCreated: 5 }),
      JSON.stringify({ v: 1, ts: 6, sessionId, type: "part", messageId: "assistant-1", partId: "part-assistant-1", partType: "text", data: { text: "hi" } }),
      JSON.stringify({ v: 1, ts: 7, sessionId, type: "message-end", messageId: "assistant-1", finish: "stop", cost: null, tokensIn: null, tokensOut: null, timeCompleted: 7 }),
    ]);

    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "jsonl-undo.ts");
    await takeSnapshot(sessionId, turn1Id, ["jsonl-undo.ts"]);

    writeFileSync(join(workspace, "jsonl-undo.ts"), "modified");

    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(turn1Id);
    expect(readFile("jsonl-undo.ts")).toBe("original");

    const lines = readSessionJSONL(sessionId);
    expect(lines.length).toBe(1);
    const onlyEvent = JSON.parse(lines[0]!);
    expect(onlyEvent.type).toBe("session");

    const allText = lines.join("\n");
    expect(allText).not.toContain(turn1Id);
    expect(allText).not.toContain("assistant-1");
  });

  test("undo with two turns truncates to the previous turn", async () => {
    createFile("jsonl-undo2.ts", "original");

    writeSessionJSONL(sessionId, [
      JSON.stringify({ v: 1, ts: 1, sessionId, type: "session", session: { id: sessionId, title: null, directory: workspace, parentSessionId: null, kind: "main", taskId: null, summary: null, parentSummary: null, filesModified: null, timeCreated: 1, timeUpdated: 1 } }),
      JSON.stringify({ v: 1, ts: 2, sessionId, type: "message", messageId: turn1Id, role: "user", modelId: null, providerId: null, timeCreated: 2 }),
      JSON.stringify({ v: 1, ts: 3, sessionId, type: "part", messageId: turn1Id, partId: "part-user-1", partType: "text", data: { text: "first" } }),
      JSON.stringify({ v: 1, ts: 4, sessionId, type: "message-end", messageId: turn1Id, finish: "stop", cost: null, tokensIn: null, tokensOut: null, timeCompleted: 4 }),
      JSON.stringify({ v: 1, ts: 5, sessionId, type: "message", messageId: turn2Id, role: "user", modelId: null, providerId: null, timeCreated: 5 }),
      JSON.stringify({ v: 1, ts: 6, sessionId, type: "part", messageId: turn2Id, partId: "part-user-2", partType: "text", data: { text: "second" } }),
      JSON.stringify({ v: 1, ts: 7, sessionId, type: "message-end", messageId: turn2Id, finish: "stop", cost: null, tokensIn: null, tokensOut: null, timeCompleted: 7 }),
    ]);

    // Simulate two tracked turns: turn1 nothing, turn2 touches a file
    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "jsonl-undo2.ts");
    await takeSnapshot(sessionId, turn1Id, ["jsonl-undo2.ts"]);

    // Manually add a second turn entry to the tracker
    setCurrentTurn(sessionId, turn2Id);
    await trackFile(sessionId, "jsonl-undo2.ts");

    writeFileSync(join(workspace, "jsonl-undo2.ts"), "modified");

    const result = await undoLatest(sessionId);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(turn2Id);

    const lines = readSessionJSONL(sessionId);
    const allText = lines.join("\n");
    expect(allText).toContain(turn1Id);
    expect(allText).not.toContain(turn2Id);
  });
});

// ---------------------------------------------------------------------------
// clearHistory
// ---------------------------------------------------------------------------

describe("clearHistory", () => {
  test("clears all undo data for a session", async () => {
    createFile("cleanup.ts", "cleanup-original");

    setCurrentTurn(sessionId, turn1Id);
    await trackFile(sessionId, "cleanup.ts");
    await takeSnapshot(sessionId, turn1Id, ["cleanup.ts"]);

    clearHistory(sessionId);

    // After clear, nothing to undo
    const result = await undoLatest(sessionId);
    expect(result).toBeNull();
  });
});
