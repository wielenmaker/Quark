// Headless probe: drive the fake host over real stdio and print the
// session/update notifications. Confirms drafts arrive before the final object.

import * as acp from "@agentclientprotocol/sdk"

const proc = Bun.spawn({
  cmd: ["/tmp/fake-quark-acp"],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

const send = (message: unknown) => proc.stdin.write(JSON.stringify(message) + "\n")
const decoder = new TextDecoder()
const seen: string[] = []
let buffer = ""
let sessionId = ""

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} },
})

const kill = setTimeout(() => proc.kill(), 20_000)

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
      seen.push(`initialize -> protocolVersion ${message.result.protocolVersion}`)
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })
    } else if (message.id === 2) {
      sessionId = message.result.sessionId
      seen.push(`session/new -> ${sessionId}`)
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "run the tests" }] },
      })
    } else if (message.method === "session/update") {
      const update = message.params.update
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const raw = update.rawInput
        const shown =
          raw === undefined
            ? "(no rawInput)"
            : typeof raw === "string"
              ? `STRING ${JSON.stringify(raw)}`
              : `OBJECT ${JSON.stringify(raw)}`
        seen.push(`${update.sessionUpdate} status=${update.status ?? "-"} rawInput=${shown}`)
      } else {
        seen.push(`${update.sessionUpdate}`)
      }
    } else if (message.id === 3) {
      seen.push(`prompt -> stopReason=${message.result?.stopReason}`)
      break
    }
  }
  if (seen.some((line) => line.startsWith("prompt ->"))) break
}

clearTimeout(kill)
proc.kill()
console.log(seen.join("\n"))
console.log("--- stderr ---")
console.log(await new Response(proc.stderr).text())
