#!/usr/bin/env bun
// E2E test for Issue #189 — API failure during /steer keeps branch usable
//
// Scenarios:
// 1. summarizeForBranch catches generateText failure -> branch created with BRANCH_FALLBACK_SUMMARY
// 2. resolveModel fails (invalid small_model) -> branch created with BRANCH_FALLBACK_SUMMARY
// 3. createBranch hard failure (parent has no taskId) -> error, no branch created

import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { bootstrap } from "../../src/bootstrap"
import { setSessionStorageRoot } from "../../src/storage/session-path"
import { ensureStorageRoot } from "../../src/storage/session-jsonl"
import { createSession, getSession } from "../../src/session/session"
import { saveUserMessage, createAssistantMessage, addPart, finishMessage, loadMessages } from "../../src/session/message"
import { setTaskStorageRoot, createTask } from "../../src/task/task"
import { summarizeForBranch, createBranch, BRANCH_FALLBACK_SUMMARY } from "../../src/session/branch"
import { resolveModel } from "../../src/session/prompt"

async function setupTestEnv() {
  const sessionDir = mkdtempSync(join(tmpdir(), "quark-test-steer-failure-"))
  const taskDir = mkdtempSync(join(tmpdir(), "quark-test-steer-failure-task-"))
  setSessionStorageRoot(sessionDir)
  setTaskStorageRoot(taskDir)
  ensureStorageRoot()
  await bootstrap()
  return { sessionDir, taskDir }
}

function cleanup(sessionDir: string, taskDir: string) {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(taskDir, { recursive: true, force: true })
  setSessionStorageRoot(undefined)
  setTaskStorageRoot(undefined)
}

function addTurn(sessionId: string, userText: string, assistantText: string) {
  saveUserMessage({ sessionId, text: userText })
  const assistant = createAssistantMessage({ sessionId })
  addPart({ sessionId, messageId: assistant.id, type: "text", data: { text: assistantText } })
  finishMessage(assistant.id, "stop", undefined, sessionId)
}

async function scenario1_summarizeForBranchCatchesError() {
  console.log("\n=== Scenario 1: summarizeForBranch catches generateText failure -> fallback summary ===")
  const task = createTask({ title: "Scenario 1", description: "Fallback test", profile: "coder" })
  const parent = createSession({ taskId: task.id })

  // Add 4 turns so splitMessages keeps 3 recent and 1 old message to summarize
  addTurn(parent.id, "Turn 1 user", "Turn 1 assistant")
  addTurn(parent.id, "Turn 2 user", "Turn 2 assistant")
  addTurn(parent.id, "Turn 3 user", "Turn 3 assistant")
  addTurn(parent.id, "Turn 4 user", "Turn 4 assistant")

  const { messages, parts } = loadMessages(parent.id)
  const invalidModel = "invalid-provider/this-model-does-not-exist" as any

  const summary = await summarizeForBranch({ messages, parts, model: invalidModel })

  console.log(`  summary: ${summary.slice(0, 70)}...`)
  console.log(`  is fallback: ${summary === BRANCH_FALLBACK_SUMMARY}`)

  const branch = createBranch({
    sessionId: parent.id,
    summary,
    prompt: "Continue refactoring",
    profile: "coder",
  })

  const child = getSession(branch.sessionId)
  console.log(`  child created: ${child.id.slice(0, 8)}`)
  console.log(`  parentSummary on child is fallback: ${child.parentSummary === BRANCH_FALLBACK_SUMMARY}`)

  const childMessages = loadMessages(branch.sessionId)
  const allText = childMessages.parts
    .filter((p) => p.type === "text")
    .map((p) => JSON.parse(p.data).text as string)
    .join("\n")

  console.log(`  child text contains fallback marker: ${allText.includes("Fallback context")}`)
  console.log(`  child text does NOT contain "Latest user request": ${!allText.includes("Latest user request")}`)

  if (summary !== BRANCH_FALLBACK_SUMMARY) throw new Error("Expected fallback summary")
  if (child.parentSummary !== BRANCH_FALLBACK_SUMMARY) throw new Error("Expected fallback parentSummary")
  if (!allText.includes("Fallback context")) throw new Error("Expected fallback marker in child messages")
  if (allText.includes("Latest user request")) throw new Error("Should not contain old fallback text")

  console.log("  [PASS]")
}

async function scenario2_invalidSmallModel() {
  console.log("\n=== Scenario 2: resolveModel fails with invalid small_model -> recoverable ===")
  const task = createTask({ title: "Scenario 2", description: "Model resolution failure", profile: "coder" })
  const parent = createSession({ taskId: task.id })

  addTurn(parent.id, "Turn 1", "Response 1")
  addTurn(parent.id, "Turn 2", "Response 2")
  addTurn(parent.id, "Turn 3", "Response 3")
  addTurn(parent.id, "Turn 4", "Response 4")

  // Simulate what the TUI does: try to resolve small_model
  let summary: string
  let usedFallback = false
  const { messages, parts } = loadMessages(parent.id)

  try {
    const model = await resolveModel("invalid-provider/this-model-does-not-exist")
    summary = await summarizeForBranch({ messages, parts, model })
    usedFallback = summary === BRANCH_FALLBACK_SUMMARY
  } catch {
    summary = BRANCH_FALLBACK_SUMMARY
    usedFallback = true
  }

  console.log(`  resolveModel threw -> usedFallback: ${usedFallback}`)

  const branch = createBranch({
    sessionId: parent.id,
    summary,
    prompt: "Do something",
    profile: "coder",
  })

  const child = getSession(branch.sessionId)
  console.log(`  child created despite model failure: ${child.id.slice(0, 8)}`)

  if (!usedFallback) throw new Error("Expected fallback to be used")
  if (child.parentSummary !== BRANCH_FALLBACK_SUMMARY) throw new Error("Expected fallback summary on child")

  console.log("  [PASS]")
}

async function scenario3_hardFailure() {
  console.log("\n=== Scenario 3: parent has no taskId -> hard failure, no branch ===")
  const parent = createSession() // no taskId

  try {
    createBranch({
      sessionId: parent.id,
      summary: "Will fail",
      prompt: "Goal",
      profile: "coder",
    })
    throw new Error("Should have thrown")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`  createBranch threw: ${message.slice(0, 80)}`)
    if (!message.includes("parent has no taskId")) throw new Error("Expected taskId error")
  }

  console.log("  [PASS]")
}

async function main() {
  console.log("=== Issue #189 Steer Failure E2E Tests ===")
  const { sessionDir, taskDir } = await setupTestEnv()

  try {
    await scenario1_summarizeForBranchCatchesError()
    await scenario2_invalidSmallModel()
    await scenario3_hardFailure()
    console.log("\n=== All scenarios passed ===")
  } finally {
    cleanup(sessionDir, taskDir)
  }
}

main().catch((err) => {
  console.error("\n[FAIL]", err)
  process.exit(1)
})
