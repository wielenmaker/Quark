// End-to-end: the real CLI runs a main agent whose model calls the `subagent`
// tool twice in one turn — first to create a live child, then to resume it by
// its returned sa-... id. A scripted OpenAI-compatible server stands in for the
// provider so the whole flow is deterministic and offline.
//
// Covers: CLI worker mode, supervisor spawn/registry, visible sa- id, in-process
// resume, and the guarantee that no subagent session lands on disk.

import { expect, test } from "bun:test"
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const EVENT = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return { id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] }
}

let callSeq = 0
function toolCall(name: string, args: object) {
  return chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_e2e_${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls")
}

function textChunks(text: string) {
  return [chunk({ role: "assistant", content: text }, null), chunk({}, "stop"), { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]
}

/** The scripted provider: decide the response from the request conversation. */
function script(messages: Array<{ role: string; content: unknown }>, toolText: string): Record<string, unknown>[] {
  const texts = messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "")
  const lastUser = texts[texts.length - 1] ?? ""
  // The child reports how many user messages it holds — 2 only if the same
  // live conversation was resumed rather than restarted.
  if (lastUser.includes("CHILD")) return textChunks(`child saw ${texts.length} user messages`)
  if (toolText === "") return [toolCall("subagent", { profile: "worker-e2e", prompt: "CHILD hello" })]
  if (!toolText.includes("child saw 2")) {
    const id = /sa-[0-9a-f-]{10,}/.exec(toolText)?.[0]
    if (!id) return textChunks("MAIN missing id")
    return [toolCall("subagent", { resume: id, prompt: "CHILD again" })]
  }
  return textChunks("MAIN done")
}

function startServer() {
  const calls: Array<Record<string, unknown>> = []
  const toolResults: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", created: 0, owned_by: "fake" }] })
      }
      const body = await request.json() as { messages?: Array<{ role: string; content: unknown }> }
      const messages = body.messages ?? []
      const toolText = messages.filter((m) => m.role === "tool").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
      if (toolText) toolResults.push(toolText)
      // Record every subagent tool call the real main agent issued (create, then resume).
      for (const m of messages) {
        if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
          for (const call of (m as any).tool_calls) {
            if (call?.function?.name === "subagent" && !calls.some((seen) => seen.__id === call.id)) {
              calls.push({ __id: call.id, ...JSON.parse(call.function.arguments) })
            }
          }
        }
      }
      const events = script(messages, toolText)
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const event of events) {
              controller.enqueue(new TextEncoder().encode("usage" in event ? EVENT({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage: event.usage }) : EVENT(event)))
            }
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { server, calls, toolResults }
}

test("live subagent: create, return sa-id, resume in the same process, nothing persisted", async () => {
  const root = join(tmpdir(), `quark-e2e-${Date.now()}`)
  const home = join(root, "home")
  const config = join(root, "config")
  mkdirSync(join(config, "profile"), { recursive: true })
  mkdirSync(home, { recursive: true })
  const { server, calls, toolResults } = startServer()
  try {
    writeFileSync(join(config, "config.yaml"), [
      "version: 3",
      "models:",
      "  small: fake/fake-model",
      "providers:",
      "  fake:",
      `    base_url: http://127.0.0.1:${server.port}/v1`,
      "    api_key: test-key",
      "",
    ].join("\n"))
    // The resolver validates models against the models.dev snapshot, so seed a
    // minimal one that contains the fake provider + model.
    mkdirSync(join(home, ".config", "quark"), { recursive: true })
    writeFileSync(join(home, ".config", "quark", "models-catalog.json"), JSON.stringify({
      version: 1,
      source: "e2e",
      fetchedAt: Date.now(),
      catalog: {
        fake: {
          id: "fake", name: "Fake", npm: "@ai-sdk/openai-compatible", env: ["FAKE_KEY"], doc: "https://example.com",
          models: {
            "fake-model": {
              id: "fake-model", name: "Fake Model", description: "offline", attachment: false, reasoning: false,
              tool_call: true, release_date: "2025-01-01", last_updated: "2025-01-01",
              modalities: { input: ["text"], output: ["text"] }, open_weights: false,
              limit: { context: 100_000, output: 4_000 },
            },
          },
        },
      },
    }))
    writeFileSync(join(config, "profile", "main-e2e.yaml"), "name: MainE2E\nmodel:\n  id: fake/fake-model\ntools: []\nsubagents: [worker-e2e]\nprompt: You are a test agent.\n")
    writeFileSync(join(config, "profile", "worker-e2e.yaml"), "name: WorkerE2E\nmodel:\n  id: fake/fake-model\ntools: []\nprompt: You are the child.\n")

    const proc = Bun.spawn({
      cmd: [process.execPath, "--preload", resolve("packages/quark/preload.ts"), resolve("packages/quark/src/cli.ts"), "--agent", "main-e2e", "-m", "MAIN go"],
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, QUARK_CONFIG_DIR: config },
      stdout: "pipe", stderr: "pipe",
    })
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 60_000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(killTimer)
    expect(exitCode, stderr).toBe(0)

    // The main agent finished, and the CLI exited on its own (no live child
    // keeping the process alive) — exitCode 0 was asserted above.
    expect(stdout).toContain("MAIN done")

    // The real main agent first created a child, then resumed it by the id it
    // read back from the tool result.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ profile: "worker-e2e", prompt: "CHILD hello" })
    const id = /Keep talking to WorkerE2E with (sa-[0-9a-f-]{10,})/.exec(toolResults[0] ?? "")?.[1]
    expect(id).toBeTruthy()
    expect(calls[1]).toEqual({ __id: expect.any(String), resume: id, prompt: "CHILD again" })

    // The child's own answers reached the main agent's transcript; the second
    // saw two user messages, proving the same conversation was continued.
    expect(toolResults[0]).toContain("child saw 1 user messages")
    expect(toolResults[1]).toContain("child saw 2 user messages")

    // No subagent session or checkpoint ever reached disk.
    const sessionsDir = join(home, ".config", "quark", "session")
    const entries = existsSync(sessionsDir) ? readdirSync(join(sessionsDir, "runners"), { recursive: true }) as string[] : []
    expect(entries.filter((entry) => String(entry).includes("sa-"))).toEqual([])
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
