// Live, bounded speed benchmark. Does not mutate profiles or print credentials.
import { resolveAgent } from "../packages/quark/src/agent/agent"
import { resolveModelRuntime } from "../packages/runner/src/provider/resolver"
import { withFastMode } from "../packages/runner/src/provider/fast-mode"
import { writeFileSync } from "node:fs"

const profile = resolveAgent("general")
if (profile.model !== "openai/gpt-6-luna" || profile.thinkingEffort !== "xhigh") throw new Error("Expected general to use openai/gpt-6-luna + xhigh")
const resolved = await resolveModelRuntime(profile.model)
const reasoning = resolved.provider.adapter.encodeReasoning?.({ model: resolved.catalogModel, config: {
  effort: profile.thinkingEffort, mode: profile.thinkingMode ?? "standard", modeExplicit: profile.thinkingMode !== undefined,
} })
console.log(JSON.stringify({ model: profile.model, effectiveProvider: resolved.provider.definition.id, effort: profile.thinkingEffort,
  note: "Same profile system prompt; fixed coding prompt; no tool calls. Three pairs, alternating order. No warmup; cache/order effects possible." }))
const prompt = "Review this TypeScript function: function unique(xs: number[]): number[] { return xs.filter((x, i) => xs.indexOf(x) === i) }. Explain its time complexity, give an O(n) replacement preserving order, and mention one edge case. Keep the whole answer under 150 words. Do not use tools."
const results: Record<string, unknown>[] = []
for (let pair = 1; pair <= 3; pair++) {
  for (const fast of pair % 2 ? [false, true] : [true, false]) {
    const started = performance.now()
    let firstTextMs: number | null = null
    let output = ""
    let metadata: unknown
    let usage: unknown
    try {
      const response = await resolved.languageModel.doStream({
        prompt: [{ role: "system", content: profile.instructions }, { role: "user", content: [{ type: "text", text: prompt }] }],
        providerOptions: withFastMode(resolved.provider.definition, reasoning, fast),
        abortSignal: AbortSignal.timeout(180000),
      })
      const reader = response.stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value.type === "error") throw value.error
          if (value.type === "text-delta") {
            firstTextMs ??= performance.now() - started
            output += value.delta
          }
          if (value.type === "finish") { usage = value.usage; metadata = value.providerMetadata }
        }
      } finally { reader.releaseLock() }
      const result = { pair, mode: fast ? "fast" : "normal", firstTextMs, totalMs: performance.now() - started, outputChars: output.length, usage, metadata }
      results.push(result)
      console.log(JSON.stringify(result))
    } catch (error) {
      console.log(JSON.stringify({ pair, mode: fast ? "fast" : "normal", error: error instanceof Error ? error.message : String(error) }))
      process.exitCode = 1
      break
    }
    writeFileSync("/tmp/quark-speed-results.json", JSON.stringify(results, null, 2))
  }
  if (process.exitCode) break
}
