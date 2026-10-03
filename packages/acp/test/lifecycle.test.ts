// Lifecycle replay tests: `session/load` restores the conversation history AND
// the context-window meter (a trailing `usage_update`); `session/resume`
// restores only the meter, since it replays no history by contract.

import { expect, test } from "bun:test"
import { MemorySessionStore, createSession } from "@quark/runner"
import { createSessionLifecycle } from "../src/lifecycle"
import type { SessionBridge } from "../src/sessions"

function seedSession(store: MemorySessionStore, contextWindow?: number) {
  const session = createSession({ directory: "/workspace" }, store)
  if (contextWindow !== undefined) {
    store.append(session.id, [
      {
        v: 1,
        ts: Date.now(),
        sessionId: session.id,
        type: "part",
        messageId: "m1",
        partId: "p1",
        partType: "step-finish",
        data: { reason: "stop", tokens: { input: 1234 }, contextWindow },
      },
    ] as any)
  }
  return session
}

function makeHarness(store: MemorySessionStore) {
  // Only `adopt`/`isActive` are exercised by resume/load; the bridge is
  // otherwise irrelevant to replay.
  const sessions = {
    adopt: () => {},
    isActive: () => false,
  } as unknown as SessionBridge
  const lifecycle = createSessionLifecycle(sessions, { store })
  const notifications: Array<{ method: string; params: any }> = []
  const client = {
    notify(method: string, params: any) {
      notifications.push({ method, params })
      return Promise.resolve()
    },
  }
  const usageUpdates = () =>
    notifications.filter((n) => n.params?.update?.sessionUpdate === "usage_update")
  return { lifecycle, notifications, client, usageUpdates }
}

test("session/load replays the last usage after the history", async () => {
  const store = new MemorySessionStore()
  const session = seedSession(store, 200_000)
  const { lifecycle, notifications, client, usageUpdates } = makeHarness(store)

  await lifecycle.loadSession(
    { sessionId: session.id, cwd: "/workspace", mcpServers: [] } as any,
    client as any,
  )

  expect(usageUpdates()).toHaveLength(1)
  expect(usageUpdates()[0].params.update).toEqual({
    sessionUpdate: "usage_update",
    used: 1234,
    size: 200_000,
  })
  // It arrives last: after whatever history the session replayed.
  expect(notifications[notifications.length - 1]).toBe(usageUpdates()[0])
})

test("session/load stays silent for sessions without a persisted window", async () => {
  const store = new MemorySessionStore()
  const session = seedSession(store)
  const { lifecycle, client, usageUpdates } = makeHarness(store)

  await lifecycle.loadSession(
    { sessionId: session.id, cwd: "/workspace", mcpServers: [] } as any,
    client as any,
  )

  expect(usageUpdates()).toHaveLength(0)
})

test("session/resume replays only the usage, no history", async () => {
  const store = new MemorySessionStore()
  const session = seedSession(store, 200_000)
  const { lifecycle, notifications, client } = makeHarness(store)

  await lifecycle.resumeSession(
    { sessionId: session.id, cwd: "/workspace", mcpServers: [] } as any,
    client as any,
  )

  expect(notifications).toHaveLength(1)
  expect(notifications[0].params.update).toEqual({
    sessionUpdate: "usage_update",
    used: 1234,
    size: 200_000,
  })
})
