import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parsePlannerResponse,
  parseVerifierResponse,
  runShipAgentLoop,
} from "../../src/commands/ship/agents"
import { runShip } from "../../src/commands/ship/orchestrator"
import { resetProfileCache } from "../../src/profile/profile"
import { setSessionStorageRoot } from "../../src/storage/session-path"

const plan = [
  "Title: Add export output",
  "Description: Add verbose output to the export command.",
  "Relevant files:",
  "- src/commands/export.ts",
].join("\n")

const acceptanceCriteria = [
  "Feature: Verbose export output",
  "  Scenario: Show exported path",
  "    Given a completed conversation",
  "    When the user exports it",
  "    Then Quark shows the exported path",
].join("\n")

function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function createShipFixture(
  verifierPassed: boolean,
  options: { prSucceeds?: boolean; dirtyAfterPr?: boolean; authStatusFails?: boolean } = {},
) {
  const prSucceeds = options.prSucceeds ?? true
  const base = mkdtempSync(join(tmpdir(), "quark-ship-"))
  const repository = join(base, "repository")
  const remote = join(base, "remote.git")
  const bin = join(base, "bin")
  const agentLog = join(base, "agent.log")
  const ghLog = join(base, "gh.log")
  mkdirSync(join(repository, ".quark", "profiles"), { recursive: true })
  mkdirSync(bin, { recursive: true })

  writeFileSync(join(repository, ".gitignore"), ".quark/worktrees/\n")
  writeFileSync(join(repository, "README.md"), "# Fixture\n")
  writeFileSync(join(repository, ".quark", "config.yaml"), [
    "version: 2",
    "default_profile: coder",
    "profiles:",
    "  coder:",
    "    name: Coder",
    "    prompt_file: profiles/coder.md",
    "    tools: [read]",
    "  oracle:",
    "    name: Oracle",
    "    prompt_file: profiles/oracle.md",
    "    tools: [read]",
  ].join("\n"))
  writeFileSync(join(repository, ".quark", "profiles", "coder.md"), "Implement features.")
  writeFileSync(join(repository, ".quark", "profiles", "oracle.md"), "Plan features.")

  const agentExecutable = join(bin, "ship-agent")
  writeFileSync(agentExecutable, `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const args = process.argv.slice(2)
const profileIndex = args.indexOf("--profile")
const profile = args[profileIndex + 1]
if (profile === "oracle") {
  const imagesFile = args.indexOf("--images-file")
  appendFileSync(process.env.SHIP_AGENT_LOG, imagesFile === -1 ? "plan\\n" : "plan:" + JSON.parse(readFileSync(args[imagesFile + 1], "utf-8")).length + "\\n")
  console.log(JSON.stringify(${JSON.stringify({ plan, acceptance_criteria: acceptanceCriteria })}))
} else if (args.includes("--session")) {
  appendFileSync(process.env.SHIP_AGENT_LOG, "implement:" + args[args.indexOf("--session") + 1] + "\\n")
  writeFileSync(join(process.cwd(), "shipped.txt"), "implemented\\n")
  console.log("Implemented")
} else {
  appendFileSync(process.env.SHIP_AGENT_LOG, "verify:" + (args.includes("--no-store") ? "fresh" : "persisted") + "\\n")
  console.log(JSON.stringify({ passed: ${verifierPassed}, reason: ${JSON.stringify(verifierPassed ? "All scenarios pass" : "Required behavior is still missing")} }))
}
`)
  chmodSync(agentExecutable, 0o755)

  const ghExecutable = join(bin, "gh")
  writeFileSync(ghExecutable, `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIP_GH_LOG"
if [ "$1" = "auth" ] && [ "${options.authStatusFails ? "1" : "0"}" = "1" ]; then
  printf '%s\\n' "not logged in" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ "${prSucceeds ? "1" : "0"}" = "1" ]; then
    ${options.dirtyAfterPr ? 'printf "%s\\n" "cleanup blocker" > cleanup-blocker.txt' : ":"}
    printf '%s\\n' "https://example.test/pull/42"
  else
    printf '%s\\n' "PR creation failed" >&2
    exit 1
  fi
fi
`)
  chmodSync(ghExecutable, 0o755)

  git(["init", "-b", "main"], repository)
  git(["config", "user.email", "ship@example.test"], repository)
  git(["config", "user.name", "Ship Test"], repository)
  git(["add", "-A"], repository)
  git(["commit", "-m", "fixture"], repository)
  git(["init", "--bare", remote])
  git(["remote", "add", "origin", remote], repository)

  const previous = {
    cwd: process.cwd(),
    path: process.env.PATH,
    executable: process.env.QUARK_SUBAGENT_EXECUTABLE,
    agentLog: process.env.SHIP_AGENT_LOG,
    ghLog: process.env.SHIP_GH_LOG,
  }
  process.chdir(repository)
  process.env.PATH = `${bin}:${previous.path ?? ""}`
  process.env.QUARK_SUBAGENT_EXECUTABLE = agentExecutable
  process.env.SHIP_AGENT_LOG = agentLog
  process.env.SHIP_GH_LOG = ghLog
  setSessionStorageRoot(join(base, "sessions"))
  resetProfileCache()

  return {
    base,
    repository,
    remote,
    agentLog,
    ghLog,
    cleanup(worktreePath?: string) {
      if (worktreePath && existsSync(worktreePath)) {
        Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], {
          cwd: repository,
          stdout: "ignore",
          stderr: "ignore",
        })
      }
      process.chdir(previous.cwd)
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.executable === undefined) delete process.env.QUARK_SUBAGENT_EXECUTABLE
      else process.env.QUARK_SUBAGENT_EXECUTABLE = previous.executable
      if (previous.agentLog === undefined) delete process.env.SHIP_AGENT_LOG
      else process.env.SHIP_AGENT_LOG = previous.agentLog
      if (previous.ghLog === undefined) delete process.env.SHIP_GH_LOG
      else process.env.SHIP_GH_LOG = previous.ghLog
      setSessionStorageRoot(undefined)
      resetProfileCache()
      rmSync(base, { recursive: true, force: true })
    },
  }
}

describe("/ship structured responses", () => {
  test("accepts the Oracle's exact flat two-string response", () => {
    expect(parsePlannerResponse(JSON.stringify({
      plan,
      acceptance_criteria: acceptanceCriteria,
    }))).toEqual({ plan, acceptance_criteria: acceptanceCriteria })
  })

  test("rejects nested or additional Oracle fields", () => {
    expect(() => parsePlannerResponse(JSON.stringify({
      plan: { title: "Nested" },
      acceptance_criteria: acceptanceCriteria,
    }))).toThrow()
    expect(() => parsePlannerResponse(JSON.stringify({
      plan,
      acceptance_criteria: acceptanceCriteria,
      test_commands: ["bun test"],
    }))).toThrow()
  })

  test("rejects malformed JSON and incomplete Gherkin", () => {
    expect(() => parsePlannerResponse("not json")).toThrow("JSON object")
    expect(() => parsePlannerResponse(JSON.stringify({
      plan,
      acceptance_criteria: "Feature: Missing scenarios",
    }))).toThrow("Scenario")
  })

  test("accepts only the verifier's passed and reason fields", () => {
    expect(parseVerifierResponse('{"passed":true,"reason":"All scenarios pass"}'))
      .toEqual({ passed: true, reason: "All scenarios pass" })
    expect(() => parseVerifierResponse('{"passed":false,"reason":"Failed","failedCriteria":[]}'))
      .toThrow()
  })
})

describe("/ship implementation and verification budget", () => {
  test("stops immediately after verification passes", async () => {
    let implementations = 0
    let verifications = 0
    const result = await runShipAgentLoop({
      implement: async () => { implementations++ },
      verify: async () => {
        verifications++
        return { passed: true, reason: "Meets all acceptance criteria" }
      },
    })

    expect(result).toEqual({
      passed: true,
      attempts: 1,
      reason: "Meets all acceptance criteria",
    })
    expect(implementations).toBe(1)
    expect(verifications).toBe(1)
  })

  test("sends each short verifier reason to the next repair and stops at three attempts", async () => {
    const feedback: Array<string | undefined> = []
    let verifications = 0
    const reasons = ["Missing test", "Wrong empty state", "Output still differs"]
    const result = await runShipAgentLoop({
      implement: async (input) => { feedback.push(input.feedback) },
      verify: async () => ({ passed: false, reason: reasons[verifications++]! }),
    })

    expect(result).toEqual({ passed: false, attempts: 3, reason: "Output still differs" })
    expect(feedback).toEqual([undefined, "Missing test", "Wrong empty state"])
    expect(verifications).toBe(3)
  })

  test("uses an implementation failure as bounded repair feedback", async () => {
    const feedback: Array<string | undefined> = []
    let implementations = 0
    const result = await runShipAgentLoop({
      implement: async (input) => {
        feedback.push(input.feedback)
        implementations++
        if (implementations === 1) throw new Error("Coder process failed")
      },
      verify: async () => ({ passed: true, reason: "Repair passes" }),
    })

    expect(result.passed).toBe(true)
    expect(result.attempts).toBe(2)
    expect(feedback).toEqual([undefined, "Coder process failed"])
  })
})

describe("/ship lifecycle", () => {
  test("rejects an empty request before touching the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "quark-ship-empty-"))
    try {
      await expect(runShip({ featureRequest: "   ", rootProjectDir: root }))
        .rejects.toThrow("Usage: /ship <feature-request>")
      expect(Bun.spawnSync(["find", root, "-mindepth", "1"], { stdout: "pipe" }).stdout.toString())
        .toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not require GitHub authentication during preflight", async () => {
    const fixture = createShipFixture(true, { authStatusFails: true })
    let worktreePath: string | undefined
    try {
      const result = await runShip({
        featureRequest: "add verbose export output",
        rootProjectDir: fixture.repository,
      })
      worktreePath = result.worktreePath

      expect(result.passed).toBe(true)
    } finally {
      fixture.cleanup(worktreePath)
    }
  })

  test("passes submitted images to the Oracle planner only", async () => {
    const fixture = createShipFixture(true)
    let worktreePath: string | undefined
    try {
      const result = await runShip({
        featureRequest: "add verbose export output",
        rootProjectDir: fixture.repository,
        images: [{ mime: "image/png", data: "aW1hZ2U=" }],
      })
      worktreePath = result.worktreePath

      expect(result.passed).toBe(true)
      expect(readFileSync(fixture.agentLog, "utf-8")).toContain("plan:1")
    } finally {
      fixture.cleanup(worktreePath)
    }
  })

  test("publishes, records the PR, and cleans the worktree and artifacts after a pass", async () => {
    const fixture = createShipFixture(true)
    let worktreePath: string | undefined
    try {
      const result = await runShip({
        featureRequest: "add verbose export output",
        rootProjectDir: fixture.repository,
      })
      worktreePath = result.worktreePath

      expect(result).toMatchObject({ passed: true, prUrl: "https://example.test/pull/42" })
      expect(worktreePath && existsSync(worktreePath)).toBe(false)
      expect(existsSync(join(fixture.repository, ".git", "quark", "ship", result.runId))).toBe(false)
      expect(git(["--git-dir", fixture.remote, "show-ref", `refs/heads/${result.branch}`])).not.toBe("")
      expect(readFileSync(fixture.agentLog, "utf-8").trim().split("\n")).toEqual([
        "plan",
        `implement:${result.implementationSessionId}`,
        "verify:fresh",
      ])
      expect(readFileSync(fixture.ghLog, "utf-8")).toContain("pr create --draft")
    } finally {
      fixture.cleanup(worktreePath)
    }
  })

  test("preserves recovery state and skips publishing after three failed verifications", async () => {
    const fixture = createShipFixture(false)
    let worktreePath: string | undefined
    try {
      const result = await runShip({
        featureRequest: "add verbose export output",
        rootProjectDir: fixture.repository,
      })
      worktreePath = result.worktreePath

      expect(result.passed).toBe(false)
      expect(result.reason).toContain("after 3 attempts")
      expect(result.reason).toContain("Required behavior is still missing")
      expect(result.implementationSessionId).toBeString()
      expect(worktreePath && existsSync(worktreePath)).toBe(true)
      expect(existsSync(join(fixture.repository, ".git", "quark", "ship", result.runId, "state.json"))).toBe(true)
      expect(readFileSync(fixture.agentLog, "utf-8").trim().split("\n")).toEqual([
        "plan",
        `implement:${result.implementationSessionId}`, "verify:fresh",
        `implement:${result.implementationSessionId}`, "verify:fresh",
        `implement:${result.implementationSessionId}`, "verify:fresh",
      ])
      expect(existsSync(fixture.ghLog) ? readFileSync(fixture.ghLog, "utf-8") : "").not.toContain("pr create")
      expect(Bun.spawnSync(
        ["git", "--git-dir", fixture.remote, "show-ref", `refs/heads/${result.branch}`],
        { stdout: "pipe", stderr: "pipe" },
      ).exitCode).not.toBe(0)
    } finally {
      fixture.cleanup(worktreePath)
    }
  })

  test("preserves the pushed worktree and artifacts when PR creation fails", async () => {
    const fixture = createShipFixture(true, { prSucceeds: false })
    let worktreePath: string | undefined
    try {
      const result = await runShip({
        featureRequest: "add verbose export output",
        rootProjectDir: fixture.repository,
      })
      worktreePath = result.worktreePath

      expect(result.passed).toBe(false)
      expect(result.reason).toContain("PR creation failed")
      expect(worktreePath && existsSync(worktreePath)).toBe(true)
      expect(existsSync(join(fixture.repository, ".git", "quark", "ship", result.runId, "state.json"))).toBe(true)
      expect(git(["--git-dir", fixture.remote, "show-ref", `refs/heads/${result.branch}`])).not.toBe("")
    } finally {
      fixture.cleanup(worktreePath)
    }
  })

  test("reports cleanup trouble as a warning without failing a created PR", async () => {
    const fixture = createShipFixture(true, { dirtyAfterPr: true })
    let worktreePath: string | undefined
    try {
      const result = await runShip({
        featureRequest: "add verbose export output",
        rootProjectDir: fixture.repository,
      })
      worktreePath = result.worktreePath

      expect(result.passed).toBe(true)
      expect(result.prUrl).toBe("https://example.test/pull/42")
      expect(result.reason).toContain("cleanup warning")
      expect(worktreePath && existsSync(worktreePath)).toBe(true)
      expect(existsSync(join(fixture.repository, ".git", "quark", "ship", result.runId))).toBe(false)
    } finally {
      fixture.cleanup(worktreePath)
    }
  })
})
