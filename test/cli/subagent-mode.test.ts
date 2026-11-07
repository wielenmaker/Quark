import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

function run(args: string[], configDir: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, resolve("packages/quark/src/cli.ts"), ...args],
    env: { ...process.env, QUARK_CONFIG_DIR: configDir },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
}

test("CLI advertises worker mode and rejects disk resume without launching a TUI", () => {
  const dir = mkdtempSync(join(tmpdir(), "quark-subagent-cli-"))
  try {
    expect(run(["--help"], dir).stdout.toString()).toContain("--sub-agent")
    const resume = run(["--sub-agent", "--session", "sa-expired"], dir)
    expect(resume.exitCode).toBe(1)
    expect(resume.stderr.toString()).toContain("live stdin connection")
    expect(readdirSync(dir)).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("CLI validates worker profile instead of silently falling back to coder", () => {
  const dir = mkdtempSync(join(tmpdir(), "quark-subagent-cli-"))
  try {
    writeFileSync(join(dir, "config.yaml"), "version: 3\nmodels:\n  small: ollama/test\nproviders: {}\n")
    const result = run(["--sub-agent", "--agent", "nonexistent"], dir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("Unknown subagent profile")
    expect(readdirSync(dir)).toEqual(["config.yaml"])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
