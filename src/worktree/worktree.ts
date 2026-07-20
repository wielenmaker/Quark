// Worktree data layer — git worktree discovery, filtering, creation
//
// Uses `git worktree list --porcelain` for authoritative discovery.
// See specs/tui/worktree-picker.md for design.

import * as path from "path"
import * as fs from "fs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  /** Unique identifier: "root" for the main project, sanitized branch name for worktrees */
  id: string
  /** Full filesystem path to the worktree */
  path: string
  /** Short branch name (e.g. "feature/login-auth"), null for detached HEAD */
  branch: string | null
  /** First 7 characters of the HEAD commit hash */
  shortHash: string
  /** True for the main project directory */
  isRoot: boolean
  /** True if this is the currently active worktree */
  isCurrent: boolean
  /** True if `git worktree list --porcelain` output includes "prunable" */
  prunable: boolean
  /** True if the worktree directory does not exist on disk */
  missing: boolean
}

export interface WorktreeCreateArgs {
  /** git worktree add arguments (without the "git worktree add" prefix) */
  args: string[]
  /** Sanitized directory name for the worktree */
  dirName: string
  /** Full path where the worktree will be created */
  fullPath: string
}

// ---------------------------------------------------------------------------
// parseWorktreeList
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` output into structured WorktreeInfo objects.
 *
 * Porcelain format:
 *   worktree <path>
 *   HEAD <full-hash>
 *   branch refs/heads/<name>        (or "detached")
 *   prunable <reason>               (optional)
 *
 * The first entry is always the root/main worktree.
 */
export function parseWorktreeList(raw: string): WorktreeInfo[] {
  const lines = raw.split("\n")
  const result: WorktreeInfo[] = []

  let current: Partial<WorktreeInfo> | null = null

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      // Finalize previous entry
      if (current?.path) {
        result.push(finalizeEntry(current, result.length === 0))
      }
      current = { path: line.slice("worktree ".length) }
    } else if (line.startsWith("HEAD ")) {
      if (current) {
        current.shortHash = line.slice("HEAD ".length, "HEAD ".length + 7)
      }
    } else if (line.startsWith("branch refs/heads/")) {
      if (current) {
        current.branch = line.slice("branch refs/heads/".length)
      }
    } else if (line === "detached") {
      if (current) {
        current.branch = null
      }
    } else if (line.startsWith("prunable")) {
      if (current) {
        current.prunable = true
      }
    }
  }

  // Finalize last entry
  if (current?.path) {
    result.push(finalizeEntry(current, result.length === 0))
  }

  return result
}

function finalizeEntry(raw: Partial<WorktreeInfo>, isFirst: boolean): WorktreeInfo {
  const dirName = path.basename(raw.path!)
  const id = isFirst ? "root" : dirName

  return {
    id,
    path: raw.path!,
    branch: raw.branch ?? null,
    shortHash: raw.shortHash ?? "0000000",
    isRoot: isFirst,
    isCurrent: isFirst,
    prunable: raw.prunable ?? false,
    missing: false,
  }
}

// ---------------------------------------------------------------------------
// filterToProjectWorktrees
// ---------------------------------------------------------------------------

/**
 * Filter worktree list to only those belonging to the current project.
 * Includes the root entry and any worktree whose path starts with worktreeBase.
 */
export function filterToProjectWorktrees(
  all: WorktreeInfo[],
  projectBase: string,
  worktreeBase: string,
): WorktreeInfo[] {
  return all.filter((wt) => {
    if (wt.isRoot) return true
    return wt.path.startsWith(worktreeBase + path.sep) || wt.path === worktreeBase
  })
}

// ---------------------------------------------------------------------------
// sanitizeBranchForPath
// ---------------------------------------------------------------------------

/**
 * Convert a git branch name into a filesystem-safe directory name.
 * Replaces "/" with "-" for flat directory structure.
 */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replaceAll("/", "-")
}

// ---------------------------------------------------------------------------
// getWorktreeBranch
// ---------------------------------------------------------------------------

/**
 * Extract the branch name from a WorktreeInfo, or null for detached HEAD.
 */
export function getWorktreeBranch(wt: WorktreeInfo): string | null {
  return wt.branch
}

// ---------------------------------------------------------------------------
// resolveWorktree
// ---------------------------------------------------------------------------

/**
 * Find a worktree by id or by full path.
 * Returns null if not found.
 */
export function resolveWorktree(
  worktrees: WorktreeInfo[],
  idOrPath: string,
): WorktreeInfo | null {
  return (
    worktrees.find((wt) => wt.id === idOrPath) ??
    worktrees.find((wt) => wt.path === idOrPath) ??
    null
  )
}

/**
 * List all git worktrees for the project root directory.
 *
 * Runs `git worktree list --porcelain` and parses the output.
 * Falls back to an empty array if the command fails.
 */
export function listWorktrees(rootProjectDir: string): WorktreeInfo[] {
  try {
    const proc = Bun.spawnSync(["git", "-C", rootProjectDir, "worktree", "list", "--porcelain"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (proc.exitCode !== 0) return []
    const output = proc.stdout.toString()
    return parseWorktreeList(output).map((worktree) => ({
      ...worktree,
      missing: !fs.existsSync(worktree.path),
    }))
  } catch {
    return []
  }
}

/**
 * Extract the branch name from a worktree path.
 *
 * Runs `git -C <path> rev-parse --abbrev-ref HEAD`.
 * Returns null if the command fails or HEAD is detached.
 */
export function getBranchFromPath(worktreePath: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (proc.exitCode !== 0) return null
    const branch = proc.stdout.toString().trim()
    if (branch === "HEAD") return null // detached
    return branch || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// buildCreateArgs
// ---------------------------------------------------------------------------

/**
 * Build `git worktree add` arguments for creating a new worktree.
 *
 * Always generates args for a new branch (with `-b` flag).
 * The caller can modify args if checking out an existing branch.
 */
export function buildCreateArgs(
  branch: string,
  basePath: string,
): WorktreeCreateArgs {
  const dirName = sanitizeBranchForPath(branch)
  const fullPath = path.join(basePath, dirName)

  return {
    args: ["-b", branch, fullPath],
    dirName,
    fullPath,
  }
}

/**
 * Create a git worktree at `.quark/worktrees/<sanitized-branch>`.
 *
 * Uses `git worktree add -b <branch> <targetPath>` to create a new branch.
 * The worktree directory is the sanitized branch name under `basePath`.
 *
 * Returns a WorktreeInfo for the newly created worktree.
 */
export async function createWorktree(input: {
  rootProjectDir: string
  branch: string
  startPoint?: string
}): Promise<WorktreeInfo> {
  const worktreeBase = path.join(input.rootProjectDir, ".quark", "worktrees")
  const { args, dirName, fullPath } = buildCreateArgs(input.branch, worktreeBase)

  // Add startPoint if provided
  if (input.startPoint) {
    args.push(input.startPoint)
  }

  const proc = Bun.spawn(["git", "worktree", "add", ...args], {
    cwd: input.rootProjectDir,
    stdout: "pipe",
    stderr: "pipe",
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git worktree add failed: ${stderr.trim()}`)
  }

  // Get the HEAD hash of the new worktree
  const headProc = Bun.spawn(["git", "-C", fullPath, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const headExit = await headProc.exited
  const headHash = headExit === 0
    ? (await new Response(headProc.stdout).text()).trim()
    : ""

  return {
    id: dirName,
    path: fullPath,
    branch: input.branch,
    shortHash: headHash.slice(0, 7),
    isRoot: false,
    isCurrent: false,
    prunable: false,
    missing: false,
  }
}

/** Remove a clean worktree after its branch has been published. */
export async function removeWorktree(input: {
  rootProjectDir: string
  worktreePath: string
}): Promise<void> {
  const proc = Bun.spawn(
    ["git", "worktree", "remove", input.worktreePath],
    {
      cwd: input.rootProjectDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${stderr.trim()}`)
  }
}
