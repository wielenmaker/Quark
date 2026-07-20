import { z } from "zod"
import { resolveSubagentCommand } from "../../subagent/executable"

export const MAX_ATTEMPTS = 3
export const PLANNER_TOOLS = "read,grep,glob,skill,websearch,webfetch"
export const VERIFIER_TOOLS = "read,grep,glob,bash,skill"

const plannerResponseSchema = z.object({
  plan: z.string().trim().min(1),
  acceptance_criteria: z.string().trim().min(1),
}).strict()

const verifierResponseSchema = z.object({
  passed: z.boolean(),
  reason: z.string().trim().min(1),
}).strict()

export interface PlannerResponse {
  plan: string
  acceptance_criteria: string
}

export interface VerifierResponse {
  passed: boolean
  reason: string
}

export interface ShipAgentLoopResult {
  passed: boolean
  attempts: number
  reason: string
}

export interface ShipAgentLoopInput {
  implement: (input: { attempt: number; feedback?: string }) => Promise<void>
  verify: (input: { attempt: number }) => Promise<VerifierResponse>
}

function jsonCandidate(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end <= start) throw new Error("response did not contain a JSON object")
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

export function parsePlannerResponse(text: string): PlannerResponse {
  const parsed = plannerResponseSchema.parse(jsonCandidate(text))
  if (!/^\s*Title\s*:/im.test(parsed.plan)) {
    throw new Error("plan must contain a Title field")
  }
  if (!/^\s*Description\s*:/im.test(parsed.plan)) {
    throw new Error("plan must contain a Description field")
  }
  if (!/^\s*Relevant files\s*:/im.test(parsed.plan)) {
    throw new Error("plan must contain a Relevant files field")
  }
  if (!/^\s*Feature\s*:/im.test(parsed.acceptance_criteria)) {
    throw new Error("acceptance_criteria must contain a Gherkin Feature")
  }
  if (!/^\s*Scenario(?: Outline)?\s*:/im.test(parsed.acceptance_criteria)) {
    throw new Error("acceptance_criteria must contain at least one Gherkin Scenario")
  }
  if (!/^\s*Given\b/im.test(parsed.acceptance_criteria)
    || !/^\s*When\b/im.test(parsed.acceptance_criteria)
    || !/^\s*Then\b/im.test(parsed.acceptance_criteria)) {
    throw new Error("acceptance_criteria must contain Given, When, and Then steps")
  }
  return parsed
}

export function parseVerifierResponse(text: string): VerifierResponse {
  return verifierResponseSchema.parse(jsonCandidate(text))
}

/** Run the fixed three-attempt implementation/verification loop used by `/ship`. */
export async function runShipAgentLoop(input: ShipAgentLoopInput): Promise<ShipAgentLoopResult> {
  let feedback: string | undefined
  let lastReason = "Implementation did not pass verification"

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await input.implement({ attempt, feedback })
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
      feedback = lastReason
      continue
    }

    let verdict: VerifierResponse
    try {
      verdict = await input.verify({ attempt })
    } catch (error) {
      verdict = {
        passed: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    lastReason = verdict.reason
    if (verdict.passed) return { passed: true, attempts: attempt, reason: verdict.reason }
    feedback = verdict.reason
  }

  return { passed: false, attempts: MAX_ATTEMPTS, reason: lastReason }
}

export function plannerPrompt(featureRequest: string): string {
  return [
    "Understand the feature request and explore the current project before planning.",
    "Return only one flat JSON object with exactly two string fields: plan and acceptance_criteria.",
    "Do not use Markdown fences and do not add any other fields.",
    "The plan string must use this shape:",
    "Title: <short title>",
    "Description: <implementation-ready description>",
    "Relevant files:",
    "- <path>",
    "The acceptance_criteria string must be valid Gherkin with Feature, Scenario, Given, When, and Then.",
    "Do not include test commands.",
    "",
    `Feature request: ${featureRequest}`,
  ].join("\n")
}

export function implementationPrompt(
  featureRequest: string,
  plan: string,
  acceptanceCriteria: string,
): string {
  return [
    "Implement the following feature in the current worktree.",
    "Make the smallest complete change and add appropriate tests.",
    "The relevant files in the plan are guidance; inspect other files when necessary.",
    "Do not commit, push, create a pull request, or modify the plan or acceptance criteria.",
    "",
    "Feature request:",
    featureRequest,
    "",
    "Plan:",
    plan,
    "",
    "Acceptance criteria:",
    acceptanceCriteria,
  ].join("\n")
}

export function repairPrompt(reason: string): string {
  return [
    "The independent verifier rejected the current implementation.",
    `Reason: ${reason}`,
    "Inspect the existing worktree, repair the implementation, and run appropriate checks.",
    "Do not commit, push, or create a pull request.",
  ].join("\n")
}

export function verifierPrompt(
  featureRequest: string,
  acceptanceCriteria: string,
  baseSha: string,
): string {
  return [
    "Act as an independent verifier. Do not edit, create, or delete files.",
    "Inspect the implementation and its git diff, and run relevant project checks when useful.",
    `The implementation branch started at commit ${baseSha}.`,
    "Return only one flat JSON object with exactly passed (boolean) and reason (short string).",
    "Do not use Markdown fences or add other fields.",
    "Set passed to true only when the implementation meets all acceptance criteria.",
    "",
    "Feature request:",
    featureRequest,
    "",
    "Acceptance criteria:",
    acceptanceCriteria,
  ].join("\n")
}

export async function runAgent(input: {
  cwd: string
  profile: string
  prompt: string
  sessionId?: string
  tools?: string
  imagesFile?: string
}): Promise<string> {
  const runtime = resolveSubagentCommand()
  const args = [
    ...runtime.args,
    "--profile", input.profile,
    "--prompt", input.prompt,
    ...(input.imagesFile ? ["--images-file", input.imagesFile] : []),
    ...(input.sessionId ? ["--session", input.sessionId] : ["--no-store"]),
  ]
  const proc = Bun.spawn([runtime.command, ...args], {
    cwd: input.cwd,
    env: {
      ...process.env,
      QUARK_AUTO_ALLOW: "1",
      ...(input.tools ? { QUARK_AGENT_TOOLS: input.tools } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Agent ${input.profile} exited with ${exitCode}`)
  }
  const response = stdout.trim()
  if (!response) throw new Error(`Agent ${input.profile} returned no response`)
  return response
}
