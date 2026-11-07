// Probe the REAL quark acp: does the configured model stream tool argument
// deltas (rawInput strings), or send the whole call in one shot?
// One cheap model call. Timestamps are relative to the prompt request.

import * as acp from "@agentclientprotocol/sdk"

const QUARK = "/Users/mac/01-CodeSpace/02-Experiment/Quark"
const proc = Bun.spawn({
  cmd: ["/opt/homebrew/opt/node@24/bin/node", `${QUARK}/packages/quark/dist/cli.js`, "acp"],
  cwd: QUARK,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

const send = (message: unknown) => proc.stdin.write(JSON.stringify(message) + "\n")
const decoder = new TextDecoder()
let buffer = ""
let sessionId = ""
let started = 0
let drafts = 0
let firstDraftAt = 0
let finalAt = 0

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} },
})

const kill = setTimeout(() => {
  console.log("TIMEOUT")
  proc.kill()
}, 90_000)

const t = () => (started ? `${((performance.now() - started) / 1000).toFixed(2)}s` : "?")

for await (const chunk of proc.stdout) {
  buffer += decoder.decode(chunk)
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")
    if (!line) continue
    const message = JSON.parse(line)

    if (message.id === 1) {
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: QUARK, mcpServers: [] },
      })
    } else if (message.id === 2) {
      sessionId = message.result.sessionId
      console.log(`session/new -> ${sessionId}`)
      started = performance.now()
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: process.env.PROBE_PROMPT ?? "Run the bash command `ls` in this directory." }],
        },
      })
    } else if (message.method === "session/update") {
      const update = message.params.update
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const raw = update.rawInput
        if (typeof raw === "string") {
          drafts += 1
          if (!firstDraftAt) firstDraftAt = performance.now()
          console.log(`${t()} DRAFT len=${raw.length} ${JSON.stringify(raw.slice(0, 60))}`)
        } else {
          if (raw !== undefined && raw !== null && typeof raw === "object" && !finalAt) {
            finalAt = performance.now()
          }
          console.log(`${t()} ${update.sessionUpdate} status=${update.status ?? "-"} rawInput=${JSON.stringify(raw)}`)
        }
        if (typeof update.rawOutput === "string") {
          const last = update.rawOutput.trimEnd().split("\n").at(-1) ?? ""
          console.log(`${t()} OUTPUT len=${update.rawOutput.length} last=${JSON.stringify(last)}`)
        }
      } else if (update.sessionUpdate === "agent_message_chunk") {
        const text = update.content?.text ?? ""
        console.log(`${t()} text ${JSON.stringify(text.slice(0, 50))}`)
      } else {
        console.log(`${t()} ${update.sessionUpdate}`)
      }
    } else if (message.method === "session/request_permission") {
      // Auto-allow the first allow option so the probe doesn't hang.
      const options = message.params.options ?? []
      const allow = options.find((o: any) => String(o.optionId).startsWith("allow")) ?? options[0]
      console.log(`${t()} permission request -> answering ${allow?.optionId}`)
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: allow?.optionId } },
      })
    } else if (message.id === 3) {
      console.log(`${t()} prompt done stopReason=${message.result?.stopReason}`)
      break
    }
  }
}

clearTimeout(kill)
proc.kill()
console.log(`\nSUMMARY: drafts=${drafts}`)
if (drafts > 0) {
  console.log(`draft phase: ${((finalAt - firstDraftAt) / 1000).toFixed(2)}s for ${drafts} deltas`)
} else {
  console.log("NO argument deltas — the provider sent the tool call in one shot")
}
console.log("--- stderr ---")
console.log((await new Response(proc.stderr).text()).slice(0, 2000))
