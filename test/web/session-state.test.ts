import { afterEach, describe, expect, test } from "bun:test"
import { createWebApp } from "../../web/src/state"
import type { AppStatus, Message, SessionResponse, SessionSummary, StateResponse } from "../../web/src/types"

const status: AppStatus = {
  modelName: "test/model",
  modelLabel: "Test",
  thinkingEffort: "none",
  thinkingLevels: ["none"],
  tokenLimit: 100,
  cwd: "/tmp",
  branch: null,
  profile: "default",
}

function session(id: string, running = false): SessionSummary {
  return { id, title: id, directory: "/tmp", pinned: false, timeUpdated: 1, running }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  close() { this.closed = true }
  emit(type: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) } as MessageEvent<string>)
  }
}

const originalWindow = globalThis.window
const originalEventSource = globalThis.EventSource

function installBrowser() {
  FakeEventSource.instances = []
  Object.assign(globalThis, { window: globalThis, EventSource: FakeEventSource })
}

afterEach(() => {
  Object.assign(globalThis, { window: originalWindow, EventSource: originalEventSource })
})

describe("web session durability", () => {
  test("keeps the root composer empty while listing historical sessions", async () => {
    installBrowser()
    const previous = session("session-1", false)
    const initial: StateResponse = { session: null, sessions: [previous], messages: [], tokensUsed: 0, status }
    const api = {
      state: async () => initial,
      catalog: async () => ({ profiles: [], profile: "default", skills: [], activeSkills: [] }),
    }
    const app = createWebApp(api as any)
    await app.init()

    expect(app.state.session).toBeNull()
    expect(app.state.messages).toEqual([])
    expect(app.state.sessions).toEqual([previous])
    expect(FakeEventSource.instances).toHaveLength(0)
    app.dispose()
  })

  test("replaces a selected conversation with the durable snapshot on connect", async () => {
    installBrowser()
    const active = session("session-1", true)
    const api = {
      loadSession: async () => ({ session: active, messages: [], tokensUsed: 0 }),
    }
    const app = createWebApp(api as any)
    await app.selectSession(active.id)

    const persisted: Message[] = [{ id: "message-1", role: "user", parts: [{ type: "text", text: "persisted" }] }]
    FakeEventSource.instances[0]!.emit("snapshot", {
      session: session("session-1", false),
      messages: persisted,
      tokensUsed: 42,
    })

    expect(app.state.messages).toEqual(persisted)
    expect(app.state.tokensUsed).toBe(42)
    expect(app.state.running).toBe(false)
    app.dispose()
  })

  test("ignores a stale session load that resolves after a newer selection", async () => {
    installBrowser()
    let resolveOld!: (value: SessionResponse) => void
    const oldLoad = new Promise<SessionResponse>((resolve) => { resolveOld = resolve })
    const api = {
      loadSession: (id: string) => id === "old" ? oldLoad : Promise.resolve({ session: session("new"), messages: [], tokensUsed: 0 }),
    }
    const app = createWebApp(api as any)

    const selectingOld = app.selectSession("old")
    await app.selectSession("new")
    resolveOld({ session: session("old"), messages: [], tokensUsed: 0 })
    await selectingOld

    expect(app.state.session?.id).toBe("new")
    app.dispose()
  })
})
