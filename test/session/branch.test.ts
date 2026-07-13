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
  type MessageRow,
  type PartRow,
} from "../../src/session/message"
import {
  buildBranchMessage,
  buildLineageContext,
  createBranch,
  extractLastUserText,
  getSessionLineage,
  shouldBranchWithRealTokens,
  autoBranch,
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

  test("does not seed child session with messages", () => {
    const task = createTask({
      title: "Branch context",
      description: "Keep context across branches",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })

    const result = createBranch({
      sessionId: parent.id,
      summary: "Parent did the first half",
      profile: "coder",
    })

    const { messages } = loadMessages(result.sessionId)
    expect(messages.length).toBe(0)
  })

  test("buildBranchMessage composes summary, recent context, and goal", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        providerId: null,
        modelId: null,
        finish: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        id: "m2",
        sessionId: "s1",
        role: "assistant",
        providerId: "copilot",
        modelId: "gpt-5",
        finish: "tool-calls",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
    ]
    const parts: PartRow[] = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "Inspect src/session/branch.ts" }) },
      { id: "p2", messageId: "m2", sessionId: "s1", type: "text", data: JSON.stringify({ text: "I inspected the file." }) },
      {
        id: "p3",
        messageId: "m2",
        sessionId: "s1",
        type: "tool",
        data: JSON.stringify({
          tool: "read",
          callId: "call_1",
          status: "completed",
          input: { path: "src/session/branch.ts" },
          output: "large tool output",
        }),
      },
    ]

    const text = buildBranchMessage("Older work summary", messages, parts, "Refactor auth")

    expect(text).toContain("Conversation summary:")
    expect(text).toContain("Older work summary")
    expect(text).toContain("Recent context:")
    expect(text).toContain("User: Inspect src/session/branch.ts")
    expect(text).toContain("Assistant: I inspected the file.")
    expect(text).toContain("→ read")
    expect(text).not.toContain("large tool output")
    expect(text).toContain("Goal:")
    expect(text).toContain("Refactor auth")
  })

  test("autoBranch saves composed message when parent summary is frozen", async () => {
    const task = createTask({
      title: "Auto branch",
      description: "Auto branch saves composed message",
      profile: "coder",
    })
    const parent = createSession({ taskId: task.id })
    updateSession(parent.id, { summary: "Frozen summary" })

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
    finishMessage(assistant.id, "stop", undefined, parent.id)

    const { messages, parts } = loadMessages(parent.id)
    const fakeModel = {} as any
    const result = await autoBranch({
      sessionId: parent.id,
      messages,
      parts,
      model: fakeModel,
      profile: "coder",
    })

    const child = loadMessages(result.sessionId)
    expect(child.messages.length).toBe(1)
    const text = child.parts
      .filter((p) => p.type === "text")
      .map((p) => (JSON.parse(p.data) as { text: string }).text)
      .join("")
    expect(text).toContain("Frozen summary")
    expect(text).toContain("User: Inspect src/session/branch.ts")
    expect(text).toContain("→ read")
    expect(text).not.toContain("large tool output")
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
      profile: "coder",
    })
    const grandchild = createBranch({
      sessionId: child.sessionId,
      summary: "Child summary",
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
      profile: "coder",
    })
    const parentAfterFirst = getSession(parent.id)
    expect(parentAfterFirst.summary).toBe("First snapshot — written by initial steer")

    // Second branch attempts to overwrite with a different summary.
    const second = createBranch({
      sessionId: parent.id,
      summary: "Second LLM call — should be ignored",
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
})
