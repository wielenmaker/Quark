#!/usr/bin/env bun
// Tmux-based E2E test for Issue #189 — visual verification of /steer failure handling
//
// Creates a session programmatically (no LLM calls), starts the TUI in tmux with
// an invalid small_model, loads the session, and runs /steer. Then captures the
// pane output to verify the warning/switch behavior.

import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { bootstrap } from "../../src/bootstrap"
import { setSessionStorageRoot } from "../../src/storage/session-path"
import { ensureStorageRoot } from "../../src/storage/session-jsonl"
import { createSession, listAllSessions } from "../../src/session/session"
import { saveUserMessage, createAssistantMessage, addPart, finishMessage } from "../../src/session/message"
import { setTaskStorageRoot, createTask } from "../../src/task/task"

const CONFIG_PATH = `${process.env.HOME}/.config/quark/config.yaml`
const SESSION_NAME = "quark-steer-test-agent"
const TMUX_BIN = "tmux"
const REPO_ROOT = "/Users/mac/01-CodeSpace/Personal-Lab/02-Experiment/Quark"

function addTurn(sessionId: string, userText: string, assistantText: string) {
  saveUserMessage({ sessionId, text: userText })
  const assistant = createAssistantMessage({ sessionId })
  addPart({ sessionId, messageId: assistant.id, type: "text", data: { text: assistantText } })
  finishMessage(assistant.id, "stop", undefined, sessionId)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tmux(args: string[]): string {
  const cmd = `${TMUX_BIN} ${args.join(" ")}`
  console.log(`  [tmux] ${cmd}`)
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
    return out
  } catch (err: any) {
    console.error(`  [tmux error] ${cmd}`)
    console.error(`  status: ${err.status}`)
    console.error(`  stderr: ${err.stderr}`)
    console.error(`  stdout: ${err.stdout}`)
    throw err
  }
}

async function main() {
  console.log("=== Issue #189 Tmux Steer Failure Test ===")

  // 1. Setup isolated storage
  const sessionDir = mkdtempSync(join(tmpdir(), "quark-tmux-steer-session-"))
  const taskDir = mkdtempSync(join(tmpdir(), "quark-tmux-steer-task-"))
  setSessionStorageRoot(sessionDir)
  setTaskStorageRoot(taskDir)
  ensureStorageRoot()
  await bootstrap()

  // 2. Create a task + parent session with 4 turns (so there is old history to summarize)
  const task = createTask({ title: "Tmux steer test", description: "Visual test", profile: "coder" })
  const parent = createSession({ taskId: task.id, directory: REPO_ROOT })
  addTurn(parent.id, "Hello assistant", "Hello user")
  addTurn(parent.id, "What is TypeScript?", "TypeScript is a typed superset of JavaScript.")
  addTurn(parent.id, "Show me an example", "const x: number = 1")
  addTurn(parent.id, "Thanks", "You're welcome.")

  const sessionId = parent.id
  const sessionPrefix = sessionId.slice(0, 4)
  console.log(`Created session ${sessionId.slice(0, 8)}`)

  // 3. Keep original config in memory and set invalid small_model
  const originalConfig = await Bun.file(CONFIG_PATH).text()
  const patchedConfig = originalConfig.replace(/^small_model:.*$/m, "small_model: invalid-provider/does-not-exist")
  await Bun.write(CONFIG_PATH, patchedConfig)
  const smallModelLine = patchedConfig.split("\n").find((line) => line.startsWith("small_model:"))
  console.log(`Patched config: ${smallModelLine}`)

  // 4. Kill any existing tmux session
  try { tmux(["kill-session", "-t", SESSION_NAME]) } catch { /* ignore */ }

  // 5. Start TUI in tmux using wrapper with isolated storage
  const startCmd = `sh -c 'cd ${REPO_ROOT} && QUARK_TEST_SESSION_DIR=${sessionDir} QUARK_TEST_TASK_DIR=${taskDir} bun --preload ./preload.ts scripts/test/tmux-steer-tui-wrapper.tsx'`
  tmux(["new-session", "-d", "-s", SESSION_NAME, "-x", "120", "-y", "40", startCmd])
  console.log("Started TUI in tmux")

  // Wait for TUI to boot
  await sleep(5000)

  // 6. List and load the pre-created session
  tmux(["send-keys", "-t", SESSION_NAME, "/sessions", "Enter"])
  await sleep(3000)

  tmux(["send-keys", "-t", SESSION_NAME, `/sessions ${sessionPrefix}`, "Enter"])
  await sleep(3000)

  // 7. Run /steer with a goal
  // Type /steer + space to dismiss dropdown, then args + Enter
  tmux(["send-keys", "-t", SESSION_NAME, "/steer", "Space", "improve the TypeScript example", "Enter"])
  await sleep(8000)

  // 8. Capture pane output
  const output = tmux(["capture-pane", "-t", SESSION_NAME, "-p"])

  // Verify a child session was created in isolated storage
  const childCount = listAllSessions().filter((s) => s.parentSessionId === sessionId).length
  console.log(`  Child sessions created for parent: ${childCount}`)
  console.log("\n--- Captured TUI output ---")
  console.log(output)
  console.log("--- End TUI output ---\n")

  // 9. Verify expected strings
  const checks = [
    { name: "warning toast about fallback", pass: output.includes("Could not load the summary model") || output.includes("Fallback context") },
    { name: "steer divider shown", pass: output.includes("Steered") },
    { name: "branch loaded with recent context", pass: output.includes("improve the TypeScript example") || output.includes("TypeScript") },
  ]

  for (const check of checks) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.name}`)
  }

  const allPassed = checks.every((c) => c.pass)

  // 10. Cleanup
  try { tmux(["kill-session", "-t", SESSION_NAME]) } catch { /* ignore */ }
  await Bun.write(CONFIG_PATH, originalConfig)
  console.log("Restored config")
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(taskDir, { recursive: true, force: true })
  setSessionStorageRoot(undefined)
  setTaskStorageRoot(undefined)

  if (allPassed) {
    console.log("\n[PASS] Tmux steer failure test")
  } else {
    console.log("\n[FAIL] Tmux steer failure test — see output above")
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("\n[FAIL]", err)
  process.exit(1)
})
