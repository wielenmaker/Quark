// Tests for issue #166 — invalid thinking config should produce a clean
// startup error instead of an unhandled exception.
//
// These tests spawn the CLI binary as a subprocess with a temp project
// directory that contains an invalid .quark/config.yaml and verify:
//   1. stderr contains a clear error message (not a stack trace)
//   2. Exit code is non-zero (1)
//   3. The agent does NOT proceed to generate output
//
// These are TDD failing tests — they will FAIL until the production fix
// is applied to wrap resolveProfile() in proper error handling.

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Project root for spawning CLI
// ---------------------------------------------------------------------------
const PROJECT_ROOT = resolve(import.meta.dir, "../..")

// ---------------------------------------------------------------------------
// Temp project directory for isolated .quark/config.yaml
// ---------------------------------------------------------------------------
let tempProjectDir: string

beforeAll(() => {
  tempProjectDir = mkdtempSync(join(tmpdir(), "quark-issue-166-"))
})

afterAll(() => {
  rmSync(tempProjectDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a .quark/config.yaml inside the temp project dir. */
function writeProjectConfig(yaml: string) {
  const quarkDir = join(tempProjectDir, ".quark")
  mkdirSync(quarkDir, { recursive: true })
  writeFileSync(join(quarkDir, "config.yaml"), yaml, "utf-8")
}

/** Spawn the CLI entry point with given args, cwd = temp project dir. */
function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: [
      "bun",
      "--preload",
      join(PROJECT_ROOT, "preload.ts"),
      join(PROJECT_ROOT, "src", "cli.ts"),
      ...args,
    ],
    cwd: tempProjectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Prevent QUARK_DEBUG noise
      QUARK_DEBUG: "",
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI with invalid thinking config (issue #166)", () => {
  test("uses the model default and warns when profile has unsupported thinking effort", () => {
    writeProjectConfig(`
profiles:
  finder:
    model: opencode/deepseek-v4-flash
    thinking_effort: xhigh
`)

    const result = runCli(["--profile", "finder", "--prompt", "hello"])

    const stderr = result.stderr.toString()

    expect(result.exitCode).toBe(0)
    expect(stderr).not.toContain("at validateThinkingEffort")
  })

  test("uses none and warns when profile model does not support thinking", () => {
    writeProjectConfig(`
profiles:
  bad:
    model: copilot/gpt-4o
    thinking_effort: high
`)

    const result = runCli(["--profile", "bad", "--prompt", "hello"])

    const stderr = result.stderr.toString()

    expect(result.exitCode).toBe(0)
    expect(stderr).toContain("Thinking configuration")
    expect(stderr).toContain("gpt-4o")
    expect(stderr).toContain('Using default "none"')
    expect(stderr).not.toContain("at validateThinkingEffort")
  })

  test("valid thinking config does NOT cause a spurious error", () => {
    // deepseek-v4-pro supports: none, high, max
    writeProjectConfig(`
profiles:
  finder:
    model: opencode/deepseek-v4-pro
    thinking_effort: high
`)

    const result = runCli(["--profile", "finder", "--prompt", "hello"])

    const stderr = result.stderr.toString()

    // This test may fail for other reasons (no API key configured), but
    // it must NOT fail with a thinking-config error.
    expect(stderr).not.toContain("Invalid thinking effort")
    expect(stderr).not.toContain("Thinking is not supported")
    expect(stderr).not.toContain("at validateThinkingEffort")
  })

  test("uses the model default when an inactive profile has invalid thinking", () => {
    writeProjectConfig(`
profiles:
  badprofile:
    model: opencode/deepseek-v4-flash
    thinking_effort: xhigh
`)

    const result = runCli(["--profile", "coder", "--prompt", "hello"])

    const stderr = result.stderr.toString()

    expect(result.exitCode).toBe(0)
    expect(stderr).toContain("Thinking configuration")
    expect(stderr).toContain("profiles.badprofile.thinking_effort")
    expect(stderr).toContain('Using default "none"')
    expect(stderr).not.toContain("at validateThinkingEffort")
  })
})
