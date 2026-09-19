// CLI interactive launch — flags must reach the TUI, never be silently dropped.
//
// `quark --agent X` (no message) spawns the TUI with `bun`. We put a fake
// `bun` first on PATH that prints its argv, so the test observes exactly what
// the CLI forwards without launching a real terminal UI.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const PROJECT_ROOT = resolve(import.meta.dir, "../..")

let fakeBinDir: string
const originalPath = process.env.PATH

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "quark-fake-bun-"))
  const fakeBun = join(fakeBinDir, "bun")
  writeFileSync(fakeBun, "#!/bin/sh\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\"; done\n")
  chmodSync(fakeBun, 0o755)
})

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(fakeBinDir, { recursive: true, force: true })
})

function runCli(args: string[]) {
  return Bun.spawnSync({
    // Absolute interpreter: the fake `bun` on PATH must only affect the CLI's
    // own child_process call, not this test's outer spawn.
    cmd: [
      process.execPath,
      "--preload", join(PROJECT_ROOT, "packages", "quark", "preload.ts"),
      join(PROJECT_ROOT, "packages", "quark", "src", "cli.ts"),
      ...args,
    ],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    },
  })
}

describe("CLI interactive launch forwards flags to the TUI", () => {
  test("--agent, --model, and --session are passed through", () => {
    const result = runCli([
      "--agent", "researcher",
      "--model", "ollama/test-model",
      "--session", "abc",
    ])

    const forwarded = result.stdout.toString().split("\n")
    expect(forwarded).toContain("--agent")
    expect(forwarded).toContain("researcher")
    expect(forwarded).toContain("--model")
    expect(forwarded).toContain("ollama/test-model")
    expect(forwarded).toContain("--session")
    expect(forwarded).toContain("abc")
  })

  test("--profile remains a compatibility alias for --agent", () => {
    const result = runCli(["--profile", "researcher"])

    const forwarded = result.stdout.toString().split("\n")
    expect(forwarded).toContain("--agent")
    expect(forwarded).toContain("researcher")
    expect(forwarded).not.toContain("--profile")
  })

  test("a bare interactive launch forwards none of the flags", () => {
    const result = runCli([])

    const forwarded = result.stdout.toString()
    expect(forwarded).not.toContain("--agent")
    expect(forwarded).not.toContain("--model")
    expect(forwarded).not.toContain("--session")
  })
})
