// Focused tests for the QUA-244 runner-bus → session/update bridge.
//
// The runner is a fake with a real (map-backed) bus; the client is a fake whose
// `notify` records calls. `notify` can be gated to prove the queue is flushed
// before the wrapped `prompt` resolves.

import { expect, test } from "bun:test"
import { createUpdateBridge } from "../src/updates"
import type { SessionTurn } from "../src/sessions"

type Handler = (data: any) => void

function makeRunner(prompt?: (input: any) => Promise<{ sessionId: string }>) {
  const listeners = new Map<string, Set<Handler>>()
  const bus = {
    on(name: string, fn: Handler) {
      const set = listeners.get(name) ?? new Set<Handler>()
      set.add(fn)
      listeners.set(name, set)
    },
    off(name: string, fn: Handler) {
      listeners.get(name)?.delete(fn)
    },
    emit(name: string, data: any) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(data)
    },
  }
  const runner: any = {
    bus,
    prompt: prompt ?? (async () => ({ sessionId: "runner-1" })),
  }
  return {
    runner,
    bus,
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
}

function makeClient(gated = false) {
  const notifications: Array<{ method: string; params: any }> = []
  let opened = !gated
  const waiters: Array<() => void> = []
  const client = {
    notify(method: string, params: any) {
      notifications.push({ method, params })
      if (opened) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
  }
  return {
    client,
    notifications,
    release: () => {
      opened = true
      waiters.splice(0).forEach((resolve) => resolve())
    },
  }
}

function turn(runner: any, client: any, runnerSessionId: string | null = null): SessionTurn {
  return {
    acpSessionId: "acp-1",
    runnerSessionId,
    runner,
    signal: new AbortController().signal,
    client,
  } as unknown as SessionTurn
}

const updatesOf = (c: ReturnType<typeof makeClient>) => c.notifications.map((n) => n.params.update)
const textsOf = (c: ReturnType<typeof makeClient>) =>
  updatesOf(c).map((u: any) => u.content?.text)

test("streams text and reasoning deltas as ACP content chunks", async () => {
  const { runner, bus } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("text-delta", { sessionId: "runner-1", messageId: "m1", partId: "p1", delta: "Hel", text: "Hel" })
  bus.emit("reasoning-delta", { sessionId: "runner-1", messageId: "m1", partId: "p2", delta: "why", text: "why" })
  await bridge.onTurnEnd(t)

  // ACP session id, not the runner id; official method constant.
  expect(c.notifications.every((n) => n.method === "session/update")).toBe(true)
  expect(c.notifications.every((n) => n.params.sessionId === "acp-1")).toBe(true)
  expect(updatesOf(c)).toEqual([
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hel" },
      messageId: "m1",
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "why" },
      messageId: "m1",
    },
  ])
})

test("translates the tool lifecycle with names, ids, status and raw input", async () => {
  const { runner, bus } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("tool-start", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "read", callId: "call-1" })
  bus.emit("tool-input", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "read", callId: "call-1", input: { filePath: "/tmp/a.ts" } })
  bus.emit("tool-running", { sessionId: "runner-1", messageId: "m1", callId: "call-1" })
  bus.emit("tool-end", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "read", callId: "call-1", status: "completed", output: "contents" })
  await bridge.onTurnEnd(t)

  // QUA-265: the bridge remaps the raw provider id; one call keeps one ACP id.
  const toolCallId = updatesOf(c)[0].toolCallId
  expect(toolCallId).toBeTruthy()
  expect(toolCallId).not.toBe("call-1")
  expect(updatesOf(c)).toEqual([
    {
      sessionUpdate: "tool_call",
      toolCallId: toolCallId,
      title: "Read",
      name: "read",
      kind: "read",
      status: "pending",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: toolCallId,
      title: "Read /tmp/a.ts",
      rawInput: { filePath: "/tmp/a.ts" },
    },
    { sessionUpdate: "tool_call_update", toolCallId: toolCallId, status: "in_progress" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: toolCallId,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "contents" } }],
      rawOutput: "contents",
    },
  ])
})

test("forwards streamed argument drafts as string rawInput before the final object", async () => {
  const { runner, bus } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("tool-start", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "bash", callId: "call-1" })
  bus.emit("tool-input-draft", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "bash", callId: "call-1", text: '{"command":"car' })
  bus.emit("tool-input-draft", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "bash", callId: "call-1", text: '{"command":"cargo test"}' })
  bus.emit("tool-input", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "bash", callId: "call-1", input: { command: "cargo test" } })
  await bridge.onTurnEnd(t)

  const toolCallId = updatesOf(c)[0].toolCallId
  expect(updatesOf(c).slice(1)).toEqual([
    // Drafts stay strings: clients can tell "still writing" from final args,
    // which always arrive as the argument object.
    { sessionUpdate: "tool_call_update", toolCallId, rawInput: '{"command":"car' },
    { sessionUpdate: "tool_call_update", toolCallId, rawInput: '{"command":"cargo test"}' },
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title: "Bash cargo test",
      rawInput: { command: "cargo test" },
    },
  ])
})

test("maps a failed tool to status failed with the error text", async () => {
  const { runner, bus } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("tool-end", { sessionId: "runner-1", messageId: "m1", partId: "t1", tool: "bash", callId: "c1", status: "error", error: "boom" })
  await bridge.onTurnEnd(t)

  // QUA-265: the raw id never reaches the wire; the failure keeps its ACP id.
  const toolCallId = updatesOf(c)[0].toolCallId
  expect(toolCallId).toBeTruthy()
  expect(toolCallId).not.toBe("c1")
  expect(updatesOf(c)).toEqual([
    {
      sessionUpdate: "tool_call_update",
      toolCallId: toolCallId,
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
      rawOutput: "boom",
    },
  ])
})

test("maps tool ids to ACP kinds and defaults unknown tools to other", async () => {
  const { runner, bus } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  const tools = ["read", "look", "write", "edit", "grep", "glob", "websearch", "webfetch", "bash", "todo", "linear"]
  tools.forEach((tool, i) =>
    bus.emit("tool-start", { sessionId: "runner-1", messageId: "m1", partId: `t${i}`, tool, callId: `c${i}` }),
  )
  await bridge.onTurnEnd(t)

  expect(updatesOf(c).map((u: any) => u.kind)).toEqual([
    "read", "read", "edit", "edit", "search", "search", "search", "fetch", "execute", "think", "other",
  ])
})

test("queues notifications in order and flushes when onTurnEnd settles", async () => {
  const { runner, bus } = makeRunner()
  const c = makeClient(true)
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("text-delta", { sessionId: "runner-1", messageId: "m1", partId: "p1", delta: "a", text: "a" })
  bus.emit("text-delta", { sessionId: "runner-1", messageId: "m1", partId: "p1", delta: "b", text: "ab" })

  let settled = false
  const flushing = bridge.onTurnEnd(t).then(() => {
    settled = true
  })
  await Promise.resolve()
  // The queue is serialized: the second notify waits for the first.
  expect(settled).toBe(false)
  expect(c.notifications).toHaveLength(1)

  c.release()
  await flushing
  expect(settled).toBe(true)
  expect(textsOf(c)).toEqual(["a", "b"])
})

test("ignores sibling sessions and tears down listeners at turn end", async () => {
  const { runner, bus, listenerCount } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const original = runner.prompt
  const t = turn(runner, c.client, "runner-1")
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("text-delta", { sessionId: "other", messageId: "x", partId: "p", delta: "leak", text: "leak" })
  bus.emit("text-delta", { sessionId: "runner-1", messageId: "m1", partId: "p1", delta: "ok", text: "ok" })
  await bridge.onTurnEnd(t)

  expect(textsOf(c)).toEqual(["ok"])
  expect(listenerCount()).toBe(0)
  expect(runner.prompt).toBe(original)

  // Nothing is delivered after the turn ends (no cross-turn/session leak).
  bus.emit("text-delta", { sessionId: "runner-1", messageId: "m1", partId: "p1", delta: "late", text: "late" })
  expect(textsOf(c)).toEqual(["ok"])
})

test("flushes queued updates before a failing prompt rejects", async () => {
  const { runner, bus, listenerCount } = makeRunner(async () => {
    throw new Error("boom")
  })
  const c = makeClient()
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("text-delta", { sessionId: "runner-1", messageId: "m1", partId: "p1", delta: "partial", text: "partial" })
  await expect(runner.prompt({})).rejects.toThrow("boom")
  // sessions.ts runs this in the turn's finally, before the error response.
  await bridge.onTurnEnd(t)

  expect(textsOf(c)).toEqual(["partial"])
  expect(listenerCount()).toBe(0)
})

test("onTurnStart no longer monkey-patches runner.prompt", async () => {
  const { runner, bus } = makeRunner(async () => ({ sessionId: "runner-42" }))
  const c = makeClient()
  const bridge = createUpdateBridge()
  const original = runner.prompt
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-42" })
  // The flush seam is now sessions.ts's `onTurnEnd`, not a prompt wrapper.
  expect(runner.prompt).toBe(original)
  await expect(runner.prompt({})).resolves.toEqual({ sessionId: "runner-42" })
  await bridge.onTurnEnd(t)
})

test("does not translate step-finish (no context-window size on the bus)", async () => {
  const { runner, bus } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  bridge.onTurnStart(turn(runner, c.client))

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("step-finish", { sessionId: "runner-1", messageId: "m1", data: { reason: "stop", tokens: { input: 10, output: 5 } } })
  await runner.prompt({})

  expect(updatesOf(c)).toHaveLength(0)
})

test("onTurnEnd is the parent merge seam: flushes, restores and is idempotent", async () => {
  const { runner, bus, listenerCount } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const original = runner.prompt
  const t = turn(runner, c.client)
  bridge.onTurnStart(t)

  bus.emit("session-created", { sessionId: "runner-1" })
  bus.emit("text-delta", { sessionId: "runner-1", messageId: "m1", partId: "p1", delta: "x", text: "x" })
  await bridge.onTurnEnd(t)

  expect(textsOf(c)).toEqual(["x"])
  expect(listenerCount()).toBe(0)
  expect(runner.prompt).toBe(original)

  await bridge.onTurnEnd(t) // second call is a no-op
})

test("onTurnEnd is a no-op for a turn the default bridge never started", async () => {
  // A caller-supplied onTurnStart replaces the default bridge, so no turn was
  // registered here. sessions.ts still calls onTurnEnd; it must be harmless.
  const { runner } = makeRunner()
  const c = makeClient()
  const bridge = createUpdateBridge()
  const t = turn(runner, c.client)
  await bridge.onTurnEnd(t)
  expect(c.notifications).toHaveLength(0)
  expect(runner.bus).toBeDefined()
})
