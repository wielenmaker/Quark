// tool-input-draft — the model's tool arguments must stream to the bus while
// they are still being written, not only as the parsed object at the end.
//
// The stream is injected, so this exercises the processor's delta handling
// without any provider/network.

import { describe, expect, test } from "bun:test"
import { processStream, type StreamFn } from "../../packages/runner/src/session/processor"
import { TypedBus } from "../../packages/runner/src/session/events"
import { MemorySessionStore } from "../../packages/runner/src/session/store"
import { createSession } from "../../packages/runner/src/session/session"
import { createAssistantMessage } from "../../packages/runner/src/session/message"

describe("tool-input-draft", () => {
  test("relays accumulated argument text while the model writes a tool call", async () => {
    const session = createSession()
    const store = new MemorySessionStore()
    store.create(session)
    const message = createAssistantMessage({
      sessionId: session.id,
      providerId: "test",
      modelId: "test-model",
    })
    const bus = new TypedBus()

    const stream: StreamFn = () => ({
      fullStream: (async function* () {
        yield { type: "tool-input-start", id: "call-1", toolName: "bash" }
        yield { type: "tool-input-delta", id: "call-1", delta: '{"command":"car' }
        yield { type: "tool-input-delta", id: "call-1", delta: 'go test"}' }
        yield {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "bash",
          input: { command: "cargo test" },
        }
      })(),
    })

    const drafts: string[] = []
    const finals: Record<string, unknown>[] = []
    bus.on("tool-input-draft", (data) => drafts.push(data.text))
    bus.on("tool-input", (data) => finals.push(data.input))

    const result = await processStream({
      model: {} as any,
      system: [],
      messages: [],
      tools: {},
      abort: new AbortController().signal,
      msg: message,
      sessionId: session.id,
      userMessageId: "user-message",
      bus,
      store,
      stream,
    })

    expect(result).toBe("stop")
    // One draft per delta, with the full accumulated text — not the chunk.
    expect(drafts).toEqual(['{"command":"car', '{"command":"cargo test"}'])
    // The final object still arrives unchanged, after the drafts.
    expect(finals).toEqual([{ command: "cargo test" }])
  })
})
