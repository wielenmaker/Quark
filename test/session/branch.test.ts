import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setSessionStorageRoot } from "../../src/storage/session-path"
import { ensureStorageRoot } from "../../src/storage/session-jsonl"
import { createSession, getSession, listSessions, updateSession } from "../../src/session/session"
import {
  addPart,
  createAssistantMessage,
  finishMessage,
  loadMessages,
  saveUserMessage,
} from "../../src/session/message"
import {
  buildLineageContext,
  createBranch,
  extractLastUserText,
  getSessionLineage,
  shouldBranchWithRealTokens,
  BRANCH_FALLBACK_SUMMARY,
} from "../../src/session/branch"
import { createTask, setTaskStorageRoot } from "../../src/task/task"

let sessionDir: string
let taskDir: string

beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "quark-test-branch-session-"))
  taskDir = mkdtempSync(join(tmpdir(), "quark-test-branch-task-"))
  setSessionStorageRoot(sessionDir)
  setTaskStorageRoot(taskDir)
  ensureStorageRoot()
})

beforeEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(taskDir, { recursive: true, force: true })
  setSessionStorageRoot(sessionDir)
  setTaskStorageRoot(taskDir)
  ensureStorageRoot()
})

afterAll(() => {
  setSessionStorageRoot(undefined)
  setTaskStorageRoot(undefined)
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(taskDir, { recursive: true, force: true })
})

describe("session branching", () => {
  test("creates a main child branch with frozen parent summary", () => {
    const task = createTask({
      title: "Task first storage",
      description: "Implement task-first storage",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })
    updateSession(parent.id, { filesModified: ["src/session/session.ts"] })

    const result = createBranch({
      sessionId: parent.id,
      summary: "Added task metadata",
      prompt: "Continue with branching",
      profile: "coder",
    })

    const updatedParent = getSession(parent.id)
    const child = getSession(result.sessionId)

    expect(updatedParent.summary).toBe("Added task metadata")
    expect(child.kind).toBe("main")
    expect(child.parentSessionId).toBe(parent.id)
    expect(child.taskId).toBe(task.id)
    expect(child.parentSummary).toBe("Added task metadata")
    expect(child.filesModified).toEqual(["src/session/session.ts"])
    expect(listSessions().map((s) => s.id)).toContain(child.id)
  })

  test("seeds child session with lineage context and prompt", () => {
    const task = createTask({
      title: "Branch context",
      description: "Keep context across branches",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })

    const result = createBranch({
      sessionId: parent.id,
      summary: "Parent did the first half",
      prompt: "Finish the second half",
      profile: "coder",
    })

    const { messages, parts } = loadMessages(result.sessionId)
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => (JSON.parse(p.data) as { text: string }).text)
      .join("\n")
    const lastUser = extractLastUserText(messages, parts)
    const lastText = parts
      .filter((part) => part.type === "text")
      .at(-1)

    expect(text).toContain("Task: Keep context across branches")
    expect(text).toContain("Session")
    expect(text).toContain("Parent did the first half")
    expect(lastUser).toBe("Finish the second half")
    expect(JSON.parse(lastText!.data)).toEqual({
      text: "Finish the second half",
      variant: "steer",
    })
  })

  test("replays recent context without tool/runtime parts", () => {
    const task = createTask({
      title: "Strip tools",
      description: "Strip tools from replayed branch context",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })

    saveUserMessage({ sessionId: parent.id, text: "Inspect src/session/branch.ts" })
    const assistant = createAssistantMessage({ sessionId: parent.id })
    addPart({
      sessionId: parent.id,
      messageId: assistant.id,
      type: "text",
      data: { text: "I inspected the file." },
    })
    addPart({
      sessionId: parent.id,
      messageId: assistant.id,
      type: "tool",
      data: {
        tool: "read",
        callId: "call_1",
        status: "completed",
        input: { path: "src/session/branch.ts" },
        output: "large tool output",
      },
    })
    addPart({
      sessionId: parent.id,
      messageId: assistant.id,
      type: "step-finish",
      data: { reason: "stop", tokens: { input: 100, output: 10 } },
    })
    finishMessage(assistant.id, "stop", undefined, parent.id)

    const recent = loadMessages(parent.id)
    const result = createBranch({
      sessionId: parent.id,
      summary: "Older work summary",
      profile: "coder",
      recentMessages: recent.messages,
      recentParts: recent.parts,
    })

    const child = loadMessages(result.sessionId)
    expect(child.parts.some((p) => p.type === "tool")).toBe(false)
    expect(child.parts.some((p) => p.type === "step-finish")).toBe(false)
    expect(extractLastUserText(child.messages, child.parts)).toBe("Inspect src/session/branch.ts")
  })

  test("walks lineage from root to child", () => {
    const task = createTask({
      title: "Lineage task",
      description: "Lineage task",
      profile: "coder",
    })
    const root = createSession({ taskId: task.id })
    const child = createBranch({
      sessionId: root.id,
      summary: "Root summary",
      prompt: "Next",
      profile: "coder",
    })
    const grandchild = createBranch({
      sessionId: child.sessionId,
      summary: "Child summary",
      prompt: "Next again",
      profile: "coder",
    })

    const lineage = getSessionLineage(grandchild.sessionId)
    const context = buildLineageContext(grandchild.sessionId)

    expect(lineage.map((s) => s.id)).toEqual([root.id, child.sessionId, grandchild.sessionId])
    expect(context).toContain("Root summary")
    expect(context).toContain("Child summary")
  })

  test("sibling branches share frozen parent summary; second branch does not overwrite parent", () => {
    const task = createTask({
      title: "Sibling snapshot",
      description: "Siblings share the same parent summary",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })

    const first = createBranch({
      sessionId: parent.id,
      summary: "First snapshot — written by initial steer",
      prompt: "Path A",
      profile: "coder",
    })
    const parentAfterFirst = getSession(parent.id)
    expect(parentAfterFirst.summary).toBe("First snapshot — written by initial steer")

    // Second branch attempts to overwrite with a different summary.
    const second = createBranch({
      sessionId: parent.id,
      summary: "Second LLM call — should be ignored",
      prompt: "Path B",
      profile: "coder",
    })

    const parentAfterSecond = getSession(parent.id)
    const childA = getSession(first.sessionId)
    const childB = getSession(second.sessionId)

    // Parent summary is frozen after the first branch.
    expect(parentAfterSecond.summary).toBe("First snapshot — written by initial steer")
    // Both siblings share the same parentSummary snapshot.
    expect(childA.parentSummary).toBe("First snapshot — written by initial steer")
    expect(childB.parentSummary).toBe("First snapshot — written by initial steer")
    expect(childA.parentSummary).toBe(childB.parentSummary!)
    // BranchResult also reports the snapshot value, not the discarded input.
    expect(second.summary).toBe("First snapshot — written by initial steer")
  })

  test("throws when parent has no taskId — invariant violation", () => {
    const parent = createSession()
    expect(() =>
      createBranch({
        sessionId: parent.id,
        summary: "Should fail",
        prompt: "Anything",
        profile: "coder",
      }),
    ).toThrow(/parent has no taskId/)
  })

  test("child taskId is immutable — branching never rewrites the parent's taskId", () => {
    const task = createTask({
      title: "Immutable taskId",
      description: "Immutable taskId",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })

    const result = createBranch({
      sessionId: parent.id,
      summary: "Snapshot",
      prompt: "Continue",
      profile: "coder",
    })

    // No extra task created — both parent and child share the original.
    expect(listSessions().filter((s) => s.taskId === task.id).length).toBe(2)
    expect(getSession(parent.id).taskId).toBe(task.id)
    expect(getSession(result.sessionId).taskId).toBe(task.id)
  })

  test("detects branch pressure using real tokens before estimates", () => {
    const result = shouldBranchWithRealTokens(
      "",
      [{ role: "user", content: "x".repeat(10000) }],
      { context: 10000, output: 1000 },
      0.9,
      [
        {
          id: "p1",
          messageId: "m1",
          sessionId: "s1",
          type: "step-finish",
          data: JSON.stringify({ reason: "stop", tokens: { input: 9500 } }),
        },
      ],
    )

    expect(result).toBe(true)
  })

  test("BRANCH_FALLBACK_SUMMARY contains an explicit fallback marker, not user text", () => {
    expect(BRANCH_FALLBACK_SUMMARY).toContain("Fallback context")
    expect(BRANCH_FALLBACK_SUMMARY).not.toContain("Latest user request")
  })

  test("child created with BRANCH_FALLBACK_SUMMARY gets correct context", () => {
    const task = createTask({
      title: "Fallback branch",
      description: "Branch with fallback summary",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })

    saveUserMessage({ sessionId: parent.id, text: "Inspect src/session/branch.ts" })
    const assistant = createAssistantMessage({ sessionId: parent.id })
    addPart({
      sessionId: parent.id,
      messageId: assistant.id,
      type: "text",
      data: { text: "Here is the file content." },
    })
    finishMessage(assistant.id, "stop", undefined, parent.id)

    const recent = loadMessages(parent.id)
    const result = createBranch({
      sessionId: parent.id,
      summary: BRANCH_FALLBACK_SUMMARY,
      prompt: "Continue the work",
      profile: "coder",
      recentMessages: recent.messages,
      recentParts: recent.parts,
    })

    const child = getSession(result.sessionId)
    expect(child.parentSessionId).toBe(parent.id)
    expect(child.taskId).toBe(task.id)
    expect(child.parentSummary).toBe(BRANCH_FALLBACK_SUMMARY)

    const { messages, parts } = loadMessages(result.sessionId)
    const allText = parts
      .filter((p) => p.type === "text")
      .map((p) => (JSON.parse(p.data) as { text: string }).text)
      .join("\n")
    expect(allText).toContain("Fallback context")

    const lastUser = extractLastUserText(messages, parts)
    expect(lastUser).toBe("Continue the work")

    // Recent messages are replayed
    expect(allText).toContain("Inspect src/session/branch.ts")
    expect(allText).toContain("Here is the file content.")
  })

  test("/steer command text is not used as fallback summary", () => {
    const task = createTask({
      title: "Steer command",
      description: "Ensure /steer command is not leaked into summary",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })

    // Simulate the last user text being a /steer command
    saveUserMessage({ sessionId: parent.id, text: "/steer fix the auth bug" })

    const recent = loadMessages(parent.id)
    const result = createBranch({
      sessionId: parent.id,
      summary: BRANCH_FALLBACK_SUMMARY,
      prompt: "fix the auth bug",
      profile: "coder",
      recentMessages: recent.messages,
      recentParts: recent.parts,
    })

    const child = getSession(result.sessionId)
    // The parentSummary stored on the child is the fallback marker, not the command
    expect(child.parentSummary).toBe(BRANCH_FALLBACK_SUMMARY)
    expect(child.parentSummary).not.toContain("/steer")
    expect(child.parentSummary).not.toContain("Latest user request")
  })
})
