import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { createSession } from "../../session/session"
import { bus, type ShipPhaseId, type ShipUpdate } from "../../session/events"
import { loadProfileConfig } from "../../profile/profile"
import { createWorktree, removeWorktree } from "../../worktree/worktree"
import {
  implementationPrompt,
  MAX_ATTEMPTS,
  parsePlannerResponse,
  parseVerifierResponse,
  plannerPrompt,
  PLANNER_TOOLS,
  repairPrompt,
  runAgent,
  runShipAgentLoop,
  verifierPrompt,
  VERIFIER_TOOLS,
  type PlannerResponse,
  type VerifierResponse,
} from "./agents"

export interface ShipImage {
  mime: string
  data: string
}

export interface ShipResult {
  passed: boolean
  runId: string
  branch?: string
  worktreePath?: string
  implementationSessionId?: string
  prUrl?: string
  reason?: string
}

interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "feature"
}

export function createShipIdentity(featureRequest: string, now = Date.now()): {
  runId: string
  branch: string
} {
  const slug = slugify(featureRequest)
  const hash = createHash("sha256")
    .update(`${featureRequest}\0${now}`)
    .digest("hex")
    .slice(0, 8)
  const runId = `${slug}-${hash}`
  return { runId, branch: `ship/${runId}` }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<ProcessResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function requireProcess(command: string, args: string[], cwd: string): Promise<string> {
  const result = await runProcess(command, args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} exited with ${result.exitCode}`)
  }
  return result.stdout
}

async function artifactDirectory(rootProjectDir: string, runId: string): Promise<string> {
  const gitPath = await requireProcess(
    "git",
    ["rev-parse", "--git-path", `quark/ship/${runId}`],
    rootProjectDir,
  )
  return isAbsolute(gitPath) ? gitPath : resolve(rootProjectDir, gitPath)
}

function persistRun(
  directory: string | undefined,
  snapshot: ShipUpdate,
  details: Record<string, unknown>,
): void {
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "state.json")
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...snapshot, ...details }, null, 2))
  renameSync(temporary, path)
}

function emitSnapshot(snapshot: ShipUpdate): void {
  bus.emit("ship-update", JSON.parse(JSON.stringify(snapshot)) as ShipUpdate)
}

function beginPhase(snapshot: ShipUpdate, id: ShipPhaseId, agent?: string, sessionId?: string): void {
  const phase = snapshot.phases.find((entry) => entry.id === id)!
  phase.status = "running"
  phase.startedAt = Date.now()
  phase.durationMs = undefined
  phase.agent = agent
  phase.sessionId = sessionId
  emitSnapshot(snapshot)
}

function endPhase(snapshot: ShipUpdate, id: ShipPhaseId, status: "pass" | "fail"): void {
  const phase = snapshot.phases.find((entry) => entry.id === id)!
  phase.status = status
  if (phase.startedAt) phase.durationMs = Date.now() - phase.startedAt
  emitSnapshot(snapshot)
}

function titleFromPlan(plan: string, fallback: string): string {
  return plan.match(/^\s*Title\s*:\s*(.+)$/im)?.[1]?.trim() || fallback.slice(0, 72)
}

function workspaceFingerprint(worktreePath: string): string {
  const hash = createHash("sha256")
  const diff = Bun.spawnSync(["git", "-C", worktreePath, "diff", "--binary", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  hash.update(diff.stdout)
  const untracked = Bun.spawnSync(
    ["git", "-C", worktreePath, "ls-files", "--others", "--exclude-standard", "-z"],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString().split("\0").filter(Boolean).sort()
  for (const file of untracked) {
    hash.update(file)
    try { hash.update(readFileSync(join(worktreePath, file))) } catch {}
  }
  return hash.digest("hex")
}

async function publish(input: {
  worktreePath: string
  branch: string
  baseSha: string
  featureRequest: string
  plan: string
  acceptanceCriteria: string
}): Promise<string> {
  const status = await requireProcess("git", ["status", "--porcelain"], input.worktreePath)
  if (status) {
    await requireProcess("git", ["add", "-A"], input.worktreePath)
    await requireProcess(
      "git",
      ["commit", "-m", titleFromPlan(input.plan, input.featureRequest)],
      input.worktreePath,
    )
  }

  const ahead = Number(await requireProcess(
    "git",
    ["rev-list", "--count", `${input.baseSha}..HEAD`],
    input.worktreePath,
  ))
  if (!Number.isFinite(ahead) || ahead === 0) {
    throw new Error("Implementation produced no commits or code changes")
  }

  await requireProcess("git", ["push", "-u", "origin", input.branch], input.worktreePath)
  const body = [
    "## Feature request",
    input.featureRequest,
    "",
    "## Plan",
    input.plan,
    "",
    "## Acceptance criteria",
    "```gherkin",
    input.acceptanceCriteria,
    "```",
    "",
    "Generated by Quark `/ship`.",
  ].join("\n")
  const output = await requireProcess(
    "gh",
    [
      "pr", "create", "--draft",
      "--head", input.branch,
      "--title", titleFromPlan(input.plan, input.featureRequest),
      "--body", body,
    ],
    input.worktreePath,
  )
  return output.split("\n").find((line) => /^https?:\/\//.test(line.trim()))?.trim() || output.trim()
}

export async function runShip(input: {
  featureRequest: string
  rootProjectDir: string
  sourceDir?: string
  sessionId?: string | null
  images?: ShipImage[]
}): Promise<ShipResult> {
  const featureRequest = input.featureRequest.trim()
  if (!featureRequest) throw new Error("Usage: /ship <feature-request>")

  const { runId, branch } = createShipIdentity(featureRequest)
  const snapshot: ShipUpdate = {
    sessionId: input.sessionId ?? "ship",
    runId,
    request: featureRequest,
    status: "running",
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    branch,
    phases: (["preflight", "plan", "implement", "verify", "publish"] as ShipPhaseId[])
      .map((id) => ({ id, status: "pending" })),
  }
  let artifacts: string | undefined
  let worktreePath: string | undefined
  let implementationSessionId: string | undefined
  let plan: PlannerResponse | undefined
  let plannerImagesFile: string | undefined
  let baseSha = ""
  let lastReason = ""
  const sourceDir = input.sourceDir ?? input.rootProjectDir

  emitSnapshot(snapshot)

  try {
    beginPhase(snapshot, "preflight")
    await requireProcess("git", ["rev-parse", "--show-toplevel"], sourceDir)
    baseSha = await requireProcess("git", ["rev-parse", "HEAD"], sourceDir)
    const profiles = loadProfileConfig().profiles
    if (!profiles.oracle) throw new Error('The "oracle" profile is required for /ship')
    if (!profiles.coder) throw new Error('The "coder" profile is required for /ship')

    artifacts = await artifactDirectory(input.rootProjectDir, runId)
    mkdirSync(artifacts, { recursive: true })
    if (input.images?.length) {
      plannerImagesFile = join(artifacts, "planner-images.json")
      writeFileSync(plannerImagesFile, JSON.stringify(input.images))
    }
    const worktree = await createWorktree({
      rootProjectDir: input.rootProjectDir,
      branch,
      startPoint: baseSha,
    })
    worktreePath = worktree.path
    snapshot.worktreePath = worktreePath
    endPhase(snapshot, "preflight", "pass")
    persistRun(artifacts, snapshot, { featureRequest, baseSha })

    beginPhase(snapshot, "plan", "oracle")
    plan = parsePlannerResponse(await runAgent({
      cwd: worktreePath,
      profile: "oracle",
      prompt: plannerPrompt(featureRequest),
      tools: PLANNER_TOOLS,
      imagesFile: plannerImagesFile,
    }))
    endPhase(snapshot, "plan", "pass")
    persistRun(artifacts, snapshot, { featureRequest, baseSha, ...plan })

    const implementationSession = createSession({
      directory: worktreePath,
      taskId: `ship_${runId}`,
    })
    implementationSessionId = implementationSession.id
    const activeWorktreePath = worktreePath
    const implementationId = implementationSession.id
    const planned = plan

    const loopResult = await runShipAgentLoop({
      implement: async ({ attempt, feedback }) => {
        snapshot.attempt = attempt
        beginPhase(snapshot, "implement", "coder", implementationId)
        try {
          await runAgent({
            cwd: activeWorktreePath,
            profile: "coder",
            sessionId: implementationId,
            prompt: attempt === 1
              ? implementationPrompt(featureRequest, planned.plan, planned.acceptance_criteria)
              : repairPrompt(feedback ?? "The previous implementation attempt failed."),
          })
          endPhase(snapshot, "implement", "pass")
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          snapshot.reason = reason
          endPhase(snapshot, "implement", "fail")
          persistRun(artifacts, snapshot, { featureRequest, baseSha, ...plan, implementationSessionId })
          throw error
        }
      },
      verify: async () => {
        beginPhase(snapshot, "verify", "coder")
        const before = workspaceFingerprint(activeWorktreePath)
        let verdict: VerifierResponse
        try {
          verdict = parseVerifierResponse(await runAgent({
            cwd: activeWorktreePath,
            profile: "coder",
            prompt: verifierPrompt(featureRequest, planned.acceptance_criteria, baseSha),
            tools: VERIFIER_TOOLS,
          }))
          const after = workspaceFingerprint(activeWorktreePath)
          if (before !== after) {
            verdict = {
              passed: false,
              reason: "Verifier modified the implementation while evaluating it",
            }
          }
        } catch (error) {
          verdict = {
            passed: false,
            reason: error instanceof Error ? error.message : String(error),
          }
        }
        snapshot.reason = verdict.passed ? undefined : verdict.reason
        endPhase(snapshot, "verify", verdict.passed ? "pass" : "fail")
        persistRun(artifacts, snapshot, { featureRequest, baseSha, ...plan, implementationSessionId })
        return verdict
      },
    })
    lastReason = loopResult.reason

    if (!loopResult.passed) {
      throw new Error(`Agent failed to implement the feature after ${MAX_ATTEMPTS} attempts. ${lastReason}`)
    }

    beginPhase(snapshot, "publish")
    const prUrl = await publish({
      worktreePath,
      branch,
      baseSha,
      featureRequest,
      plan: plan.plan,
      acceptanceCriteria: plan.acceptance_criteria,
    })
    snapshot.prUrl = prUrl

    let cleanupWarning: string | undefined
    try {
      await removeWorktree({ rootProjectDir: input.rootProjectDir, worktreePath })
    } catch (error) {
      cleanupWarning = error instanceof Error ? error.message : String(error)
    }
    try {
      rmSync(artifacts, { recursive: true, force: true })
    } catch (error) {
      cleanupWarning = [cleanupWarning, error instanceof Error ? error.message : String(error)]
        .filter(Boolean).join("; ")
    }

    snapshot.status = "passed"
    snapshot.reason = cleanupWarning ? `Pull request created; cleanup warning: ${cleanupWarning}` : undefined
    endPhase(snapshot, "publish", "pass")
    emitSnapshot(snapshot)
    return {
      passed: true,
      runId,
      branch,
      worktreePath,
      implementationSessionId,
      prUrl,
      reason: snapshot.reason,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const running = snapshot.phases.find((phase) => phase.status === "running")
    if (running) endPhase(snapshot, running.id, "fail")
    snapshot.status = "failed"
    snapshot.reason = reason
    persistRun(artifacts, snapshot, {
      featureRequest,
      baseSha,
      ...(plan ?? {}),
      implementationSessionId,
    })
    emitSnapshot(snapshot)
    return {
      passed: false,
      runId,
      branch,
      worktreePath,
      implementationSessionId,
      reason,
    }
  }
}
