// Verification-only fake model stream for the real @quark/acp server.
// It speaks the real ACP protocol over stdio but "generates" a tool call
// slowly, so the zed-ui card can show the argument draft being typed.
//
// Not production code. Delete after the visual check.

import { runAcpStdio } from "../packages/acp/src/index"
import { createSession, MemorySessionStore, createHookRegistry, type Runner } from "@quark/runner"

const store = new MemorySessionStore()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function makeRunner(): Runner {
  const listeners = new Map<string, Set<(data: any) => void>>()
  const emit = (name: string, data: unknown) => {
    for (const fn of [...(listeners.get(name) ?? [])]) fn(data)
  }

  const runner = {
    bus: {
      on(name: string, fn: (data: any) => void) {
        const set = listeners.get(name) ?? new Set()
        set.add(fn)
        listeners.set(name, set)
      },
      off(name: string, fn: (data: any) => void) {
        listeners.get(name)?.delete(fn)
      },
      emit,
    },
    hooks: createHookRegistry(),
    store,
    async prompt(input: any) {
      const sessionId = input.sessionId ?? "verify-session"
      if (!store.get(sessionId)) {
        createSession({ id: sessionId, directory: process.cwd() }, store)
      }
      emit("session-created", { sessionId })

      const messageId = "verify-message"
      emit("text-delta", {
        sessionId,
        messageId,
        partId: "p1",
        delta: "Let me run the tests. ",
        text: "Let me run the tests. ",
      })
      await sleep(500)

      const tool = "bash"
      const callId = "call_verify"
      emit("tool-start", { sessionId, messageId, partId: "t1", tool, callId })
      await sleep(500)

      // Type the arguments character by character, like a model streaming deltas.
      const argsText = `{"command":"cargo test --release"}`
      let accumulated = ""
      for (const char of argsText) {
        accumulated += char
        emit("tool-input-draft", {
          sessionId,
          messageId,
          partId: "t1",
          tool,
          callId,
          text: accumulated,
        })
        if (!process.env.FAKE_BURST) await sleep(260)
      }

      // The model finished: final parsed arguments replace the draft.
      emit("tool-input", {
        sessionId,
        messageId,
        partId: "t1",
        tool,
        callId,
        input: { command: "cargo test --release" },
      })
      emit("tool-running", { sessionId, messageId, callId })

      // Stream the "terminal" output the way the real bash tool now does.
      let streamed = ""
      for (let line = 1; line <= 18; line += 1) {
        const chunk = `line ${line}: build output sample text\n`
        streamed += chunk
        emit("tool-output-delta", { sessionId, messageId, callId, delta: chunk })
        await sleep(250)
      }
      await sleep(1000)

      emit("tool-end", {
        sessionId,
        messageId,
        partId: "t1",
        tool,
        callId,
        status: "completed",
        output: streamed,
      })
      return { sessionId }
    },
    cancel() {},
    isActive: () => false,
    hasActiveRun: () => false,
  }
  return runner as unknown as Runner
}

await runAcpStdio({
  store,
  createRunner: () => makeRunner(),
  log: (message) => process.stderr.write(`[fake quark acp] ${message}\n`),
})
