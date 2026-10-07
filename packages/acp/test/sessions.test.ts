// Focused tests for the ACP session bridge (QUA-248).
//
// The ACP App is a fake that records handlers; runners are fakes with a real
// `bus` and a controllable `prompt`. The SDK dependency is real: no module
// mock, so these tests cannot leak an SDK stand-in into sibling test files.

import { expect, mock, test } from "bun:test"
import { MemorySessionStore, createSession, type SessionStore } from "@quark/runner"

const { createSessionHandlers, registerSessions } = await import("../src/sessions")

type Wire = { sessionId: string; prompt: Array<Record<string, unknown>> }

function makeRunner(
  options: { sessionId?: string; manual?: boolean; store?: SessionStore; failFirst?: boolean } = {},
) {
  const calls: Record<string, any>[] = []
  const cancelled: string[] = []
  const listeners = new Map<string, Set<(data: any) => void>>()
  const gates: Array<() => void> = []
  let failed = false

  const runner: Record<string, any> = {
    bus: {
      on(name: string, fn: (data: any) => void) {
        const set = listeners.get(name) ?? new Set()
        set.add(fn)
        listeners.set(name, set)
      },
      off(name: string, fn: (data: any) => void) {
        listeners.get(name)?.delete(fn)
      },
      emit(name: string, data: any) {
        for (const fn of listeners.get(name) ?? []) fn(data)
      },
    },
    store: options.store,
    prompt(input: Record<string, any>) {
      calls.push(input)
      if (options.failFirst && !failed) {
        failed = true
        throw new Error("runner setup failed")
      }
      const sessionId = (input.sessionId as string | undefined) ?? options.sessionId ?? "runner-1"
      // The real engine announces creation synchronously, before awaiting.
      runner.bus.emit("session-created", { sessionId })
      if (options.manual) {
        return new Promise<{ sessionId: string }>((resolve) => {
          gates.push(() => resolve({ sessionId }))
        })
      }
      return Promise.resolve({ sessionId })
    },
    cancel(id: string) {
      cancelled.push(id)
    },
    isActive: () => false,
    hasActiveRun: () => false,
  }
  return { runner, calls, cancelled, release: () => gates.splice(0).forEach((g) => g()) }
}

const callCtx = () => ({ signal: new AbortController().signal, client: {} as any })
const newSessionParams = (over: Record<string, unknown> = {}) => ({ cwd: "/workspace", mcpServers: [], ...over }) as any

test("session/new allocates unique ids and defers runner creation", () => {
  const created: string[] = []
  const store = new MemorySessionStore()
  const { runner } = makeRunner({ store })
  const bridge = createSessionHandlers({ store, createRunner: (cwd) => (created.push(cwd), runner as any) })

  const a = bridge.newSession(newSessionParams())
  const b = bridge.newSession(newSessionParams({ cwd: "/other" }))
  expect(a.sessionId).not.toBe(b.sessionId)
  expect(created).toEqual([])
  // The id is a promise, not a record: nothing is persisted until a prompt.
  expect(store.list()).toEqual([])
})

test("session/new rejects MCP servers and additional directories explicitly", () => {
  const store = new MemorySessionStore()
  const bridge = createSessionHandlers({ store, createRunner: () => makeRunner({ store }).runner as any })
  expect(() => bridge.newSession(newSessionParams({ mcpServers: [{ name: "x" }] }))).toThrow(/MCP/)
  expect(() => bridge.newSession(newSessionParams({ additionalDirectories: ["/x"] }))).toThrow(
    /additionalDirectories/,
  )
})

test("the ACP id becomes the persisted session id on the first prompt", async () => {
  const store = new MemorySessionStore()
  const { runner, calls } = makeRunner({ store })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())

  await bridge.prompt(
    {
      sessionId,
      prompt: [
        { type: "text", text: "hello" },
        { type: "resource_link", name: "a.ts", uri: "file:///a.ts" },
      ],
    } as any,
    callCtx(),
  )

  // The client's thread id names a real persisted session.
  expect(store.get(sessionId)?.directory).toBe("/workspace")
  expect(bridge.runnerSessionId(sessionId)).toBe(sessionId)
  expect(calls[0]!.sessionId).toBe(sessionId)
  expect(calls[0]!.targetWorkspace).toBe("/workspace")
  expect(calls[0]!.parts[0]).toEqual({ type: "text", text: "hello" })
  expect(calls[0]!.parts[1].text).toContain("file:///a.ts")
})

test("prompt resumes the persisted id on later turns", async () => {
  const store = new MemorySessionStore()
  const { runner, calls } = makeRunner({ sessionId: "runner-42", store })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())
  const ctx = callCtx()

  await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] } as any, ctx)
  await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] } as any, ctx)

  expect(calls[0]!.sessionId).toBe(sessionId)
  expect(calls[1]!.sessionId).toBe(sessionId)
  expect(bridge.runnerSessionId(sessionId)).toBe(sessionId)
  expect(store.list().map((s) => s.id)).toEqual([sessionId])
})

test("switching profile rebuilds the runner for it on the same persisted session", async () => {
  const store = new MemorySessionStore()
  const profiles: (string | null)[] = []
  const first = makeRunner({ store })
  const second = makeRunner({ store })
  const bridge = createSessionHandlers({
    store,
    createRunner: (_cwd, _mcp, profile) => {
      profiles.push(profile)
      return (profile === "finder" ? second.runner : first.runner) as any
    },
  })
  const { sessionId } = bridge.newSession(newSessionParams())
  const ctx = callCtx()

  await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] } as any, ctx)
  expect(profiles).toEqual([null])
  expect(bridge.getProfileOverride(sessionId)).toBeNull()

  bridge.setProfileOverride(sessionId, "finder")
  await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] } as any, ctx)

  // The new profile's runner took the second turn, on the same persisted session.
  expect(profiles).toEqual([null, "finder"])
  expect(first.calls).toHaveLength(1)
  expect(second.calls).toHaveLength(1)
  expect(second.calls[0]!.sessionId).toBe(sessionId)
  expect(store.list().map((session) => session.id)).toEqual([sessionId])
})

test("switching profile mid-turn is refused, leaving the running generation in place", async () => {
  const store = new MemorySessionStore()
  const profiles: (string | null)[] = []
  const { runner, release } = makeRunner({ store, manual: true })
  const bridge = createSessionHandlers({
    store,
    createRunner: (_cwd, _mcp, profile) => {
      profiles.push(profile)
      return runner as any
    },
  })
  const { sessionId } = bridge.newSession(newSessionParams())
  const running = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] } as any, callCtx())

  expect(() => bridge.setProfileOverride(sessionId, "finder")).toThrow(/in progress/)
  expect(bridge.getProfileOverride(sessionId)).toBeNull()

  release()
  await running
  // Idle again: the switch is accepted and applies to the next turn.
  bridge.setProfileOverride(sessionId, "finder")
  expect(bridge.getProfileOverride(sessionId)).toBe("finder")
  const next = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] } as any, callCtx())
  release()
  await next
  expect(profiles).toEqual([null, "finder"])
})

test("a failed first prompt leaves no empty session and the id can be retried", async () => {
  const store = new MemorySessionStore()
  const { runner } = makeRunner({ store, failFirst: true })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())
  const ctx = callCtx()

  await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] } as any, ctx)).rejects.toThrow(
    /runner setup failed/,
  )
  expect(store.get(sessionId)).toBeNull()
  expect(store.replay(sessionId).messages).toEqual([])
  expect(bridge.runnerSessionId(sessionId)).toBeNull()

  // The next prompt persists a fresh record and succeeds.
  await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "y" }] } as any, ctx)).resolves.toEqual({
    stopReason: "end_turn",
  })
  expect(store.get(sessionId)?.directory).toBe("/workspace")
  expect(bridge.runnerSessionId(sessionId)).toBe(sessionId)
})

test("session/new re-mints when a UUID collides with a persisted session", () => {
  const store = new MemorySessionStore()
  createSession({ id: "collide-1", directory: "/elsewhere" }, store)
  const real = crypto.randomUUID.bind(crypto)
  let calls = 0
  crypto.randomUUID = () => (++calls === 1 ? "collide-1" : real())
  try {
    const bridge = createSessionHandlers({ store, createRunner: () => makeRunner({ store }).runner as any })
    const { sessionId } = bridge.newSession(newSessionParams())
    expect(sessionId).not.toBe("collide-1")
    // The pre-existing session is untouched, not reused.
    expect(store.get("collide-1")?.directory).toBe("/elsewhere")
  } finally {
    crypto.randomUUID = real
  }
})

test("a runner with a different store is refused on the first prompt", async () => {
  const store = new MemorySessionStore()
  const other = new MemorySessionStore()
  const { runner } = makeRunner({ store: other })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())

  await expect(
    bridge.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] } as any, callCtx()),
  ).rejects.toThrow(/store mismatch/)
  expect(store.list()).toEqual([])
})

test("unknown session and unsupported prompt blocks are rejected", async () => {
  const store = new MemorySessionStore()
  const { runner, calls } = makeRunner({ store })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const ctx = callCtx()
  await expect(bridge.prompt({ sessionId: "nope", prompt: [{ type: "text", text: "x" }] } as any, ctx)).rejects.toThrow(
    /unknown session/,
  )

  const { sessionId } = bridge.newSession(newSessionParams())
  await expect(
    bridge.prompt({ sessionId, prompt: [{ type: "image", mimeType: "image/png", data: "..." }] } as any, ctx),
  ).rejects.toThrow(/unsupported prompt content block "image"/)
  expect(calls).toEqual([])
})

test("concurrent prompts on one session are rejected until the turn ends", async () => {
  const store = new MemorySessionStore()
  const { runner, release } = makeRunner({ store, manual: true })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())
  const ctx = callCtx()

  const running = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] } as any, ctx)
  await expect(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] } as any, ctx)).rejects.toThrow(
    /already in progress/,
  )

  release()
  await running
  // Idle again: a fresh turn is accepted.
  const next = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "three" }] } as any, ctx)
  release()
  await expect(next).resolves.toEqual({ stopReason: "end_turn" })
})

test("cancel targets the runner session and reports a cancelled stop reason", async () => {
  const store = new MemorySessionStore()
  const { runner, cancelled, release } = makeRunner({ sessionId: "runner-7", store, manual: true })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())
  const running = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "stop me" }] } as any, callCtx())

  bridge.cancel({ sessionId })
  expect(cancelled).toEqual([sessionId])
  release()
  await expect(running).resolves.toEqual({ stopReason: "cancelled" })
})

test("title changes forward to the client for the session's lifetime", async () => {
  const store = new MemorySessionStore()
  const { runner, release } = makeRunner({ store, manual: true })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())
  const notify = mock(() => Promise.resolve())
  const ctx = { signal: new AbortController().signal, client: { notify } as any }

  const turn = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "fix the row" }] } as any, ctx)
  // The runner sets a fallback title from the first message while the turn is
  // live, then refines it once the turn settles: both are forwarded.
  runner.bus.emit("session-title-changed", { sessionId, title: "Fix the sidebar row" })
  release()
  await turn
  runner.bus.emit("session-title-changed", { sessionId, title: "Sidebar row fix" })
  // A cleared title and a child session's title must not reach the client.
  runner.bus.emit("session-title-changed", { sessionId, title: null })
  runner.bus.emit("session-title-changed", { sessionId: "child-1", title: "Sub-agent title" })
  await Promise.resolve()

  expect(notify.mock.calls).toEqual([
    [
      "session/update",
      {
        sessionId,
        update: { sessionUpdate: "session_info_update", title: "Fix the sidebar row" },
      },
    ],
    [
      "session/update",
      {
        sessionId,
        update: { sessionUpdate: "session_info_update", title: "Sidebar row fix" },
      },
    ],
  ])
})

test("onTurnStart receives the runner and ACP client context", async () => {
  const store = new MemorySessionStore()
  const { runner } = makeRunner({ store })
  const turns: any[] = []
  const bridge = createSessionHandlers({
    store,
    createRunner: () => runner as any,
    onTurnStart: (turn) => turns.push(turn),
  })
  const { sessionId } = bridge.newSession(newSessionParams())
  const ctx = callCtx()
  await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as any, ctx)

  expect(turns).toHaveLength(1)
  expect(turns[0]!.runner).toBe(runner)
  expect(turns[0]!.client).toBe(ctx.client)
  expect(turns[0]!.acpSessionId).toBe(sessionId)
  expect(turns[0]!.runnerSessionId).toBe(sessionId)
})

test("dispose cancels active turns, awaits them, and is idempotent", async () => {
  const store = new MemorySessionStore()
  const { runner, cancelled, release } = makeRunner({ sessionId: "runner-9", store, manual: true })
  const bridge = createSessionHandlers({ store, createRunner: () => runner as any })
  const { sessionId } = bridge.newSession(newSessionParams())
  const running = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] } as any, callCtx())

  // The abort is synchronous, but teardown waits for the in-flight turn.
  const disposing = bridge.dispose()
  expect(cancelled).toEqual([sessionId])
  let resolved = false
  void disposing.then(() => (resolved = true))
  await Promise.resolve()
  expect(resolved).toBe(false)

  release()
  await running
  await disposing
  expect(bridge.runnerSessionId(sessionId)).toBeNull()
  await bridge.dispose() // idempotent
})

test("registerSessions installs session/new and session/prompt on the app", async () => {
  const store = new MemorySessionStore()
  const { runner } = makeRunner({ store })
  const handlers = new Map<string, (ctx: any) => Promise<any> | any>()
  const app = {
    onRequest(method: string, handler: (ctx: any) => Promise<any> | any) {
      handlers.set(method, handler)
      return app
    },
  }
  const bridge = registerSessions(app as any, { store, createRunner: () => runner as any })
  expect([...handlers.keys()]).toEqual(["session/new", "session/prompt"])

  const created = await handlers.get("session/new")!({ params: newSessionParams() })
  const response = await handlers.get("session/prompt")!({
    params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "via app" }] } as Wire,
    signal: new AbortController().signal,
    client: {},
  })
  expect(response).toEqual({ stopReason: "end_turn" })
  expect(bridge.runnerSessionId(created.sessionId)).toBe(created.sessionId)
})
