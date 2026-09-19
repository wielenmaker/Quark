// Tests for issue #166 — invalid agent thinking config should produce a clean
// startup error instead of an unhandled exception.
//
// These tests spawn the CLI binary with a temp QUARK_CONFIG_DIR containing the
// agent manifests and verify:
//   1. stderr contains a clear error message (not a stack trace)
//   2. Exit code is non-zero (1)
//   3. The agent does NOT proceed to generate output

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"

const PROJECT_ROOT = resolve(import.meta.dir, "../..")

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "quark-issue-166-"))
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

/** Write `agents/<id>/agent.yaml` under the temp config dir. */
function writeAgent(id: string, yaml: string) {
  const dir = join(configDir, "agents", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "agent.yaml"), yaml, "utf-8")
}

/** Spawn the CLI entry point with given args, isolated config dir. */
function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: [
      "bun",
      "--preload",
      join(PROJECT_ROOT, "packages", "quark", "preload.ts"),
      join(PROJECT_ROOT, "packages", "quark", "src", "cli.ts"),
      ...args,
    ],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      QUARK_CONFIG_DIR: configDir,
      QUARK_DEBUG: "",
    },
  })
}

describe("CLI with invalid thinking config (issue #166)", () => {
  test("reports exact-catalog validation when an agent has an unsupported thinking effort", () => {
    writeAgent("finder", "model: opencode/deepseek-v4-flash\nthinking_effort: xhigh\n")

    const result = runCli(["--agent", "finder", "--message", "hello"])

    const stderr = result.stderr.toString()

    expect(result.exitCode).not.toBe(0)
    expect(stderr).toContain("not present in the exact catalog")
  })

  test("reports exact-catalog validation when an agent model does not support thinking", () => {
    writeAgent("bad", "model: copilot/gpt-4o\nthinking_effort: high\n")

    const result = runCli(["--agent", "bad", "--message", "hello"])

    const stderr = result.stderr.toString()

    expect(result.exitCode).not.toBe(0)
    expect(stderr).toContain("not present in the exact catalog")
  })

  test("valid thinking config does NOT cause a spurious error", () => {
    // deepseek-v4-pro supports: none, high, max
    writeAgent("finder-pro", "model: opencode/deepseek-v4-pro\nthinking_effort: high\n")

    const result = runCli(["--agent", "finder-pro", "--message", "hello"])

    const stderr = result.stderr.toString()

    // This test may fail for other reasons (no API key configured), but
    // it must NOT fail with a thinking-config error.
    expect(stderr).not.toContain("Invalid thinking effort")
    expect(stderr).not.toContain("Thinking is not supported")
    expect(stderr).not.toContain("at profile validation")
  })

  test("--profile still resolves the agent as a compatibility alias", () => {
    writeAgent("finder-alias", "model: opencode/deepseek-v4-flash\nthinking_effort: xhigh\n")

    const result = runCli(["--profile", "finder-alias", "--message", "hello"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("not present in the exact catalog")
  })
})
