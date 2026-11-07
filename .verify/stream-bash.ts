// Direct check: the bash tool streams output while the command runs.
// Runs the tool in-process with a fake bus — no model, no ACP.

import tool from "/Users/mac/.config/quark/tools/bash.ts"

const events: Array<{ t: number; delta: string }> = []
const bus = {
  on() {},
  off() {},
  emit(name: string, data: any) {
    if (name === "tool-output-delta") events.push({ t: Date.now(), delta: data.delta })
  },
}

const started = Date.now()
const result = await tool.execute(
  { command: "for i in 1 2 3 4 5; do echo tick $i; sleep 0.25; done" },
  {
    workspace: "/tmp",
    sessionId: "s1",
    messageId: "m1",
    callId: "c1",
    abort: new AbortController().signal,
    bus,
  },
)

console.log(`deltas: ${events.length}`)
for (const event of events) {
  console.log(`  +${event.t - started}ms ${JSON.stringify(event.delta)}`)
}
console.log(`total ms: ${Date.now() - started}`)
console.log(`output: ${JSON.stringify(result.output)}`)
console.log(`exitCode: ${result.metadata.exitCode}`)

// Second run: a nonzero exit rejects, so the runner marks the call failed
// (red ✗) and the model receives the output as an error.
try {
  const failed = await tool.execute(
    { command: "echo before-fail; exit 3" },
    { workspace: "/tmp", sessionId: "s1", messageId: "m1", callId: "c2", abort: new AbortController().signal, bus },
  )
  console.log(`failed: resolved unexpectedly: ${JSON.stringify(failed.output)}`)
} catch (error: any) {
  console.log(`failed: threw ${JSON.stringify(String(error?.message ?? error))}`)
}
