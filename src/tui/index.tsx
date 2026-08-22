// @jsxImportSource @opentui/solid
// TUI entry point — renders the OpenTUI/SolidJS app and wires it to the backend
//
// Usage: bun src/tui/index.tsx
// Usage: bun src/tui/index.tsx --profile researcher

import { render } from "@opentui/solid"
import { createCliRenderer, RGBA } from "@opentui/core"
import { App, type CommandResult } from "./components/App"
import { bootstrap } from "../bootstrap"
import { prompt, cancel, isActive, resolveModel, runSeededSession } from "../session/prompt"
import { createSession, listSessions, listProjectSessions, getSession, setSessionTitle, setSessionPinned, deleteSession } from "../session/session"
import { loadMessages, toModelMessages } from "../session/message"
import { buildSystem } from "../session/system"
import { getModelLimit, refreshLMStudio } from "../provider/models"
import { buildModelPickerOptions } from "./model-picker"
import { estimateTokens, getLastInputTokens } from "../session/context"
import { compactBranch, createSteerBranch, type BranchResult } from "../session/branch"
import { bus } from "../session/events"
import { agentFromProfile, type AgentConfig } from "../agent"
import { discoverSkills, loadSkill } from "../skill/skill"
import { dbToTuiMessages } from "./state"
import { loadConfig, parseModelSpec, resetConfigCache, CONFIG_PATH } from "../config/config"
import { resolveProfile, readPromptFile, listProfiles, resetProfileCache } from "../profile/profile"
import { detectFromConfigOrOS } from "./terminal-bg"
import { createGhosttyTitleController, isGhostty } from "./ghostty-title"
import { applyTheme, setTerminalBg, lightTheme, darkTheme } from "./theme"
import { writeClipboard } from "./clipboard"
import { buildEditorArgv, resolveEditor, type FileTarget } from "./editor"
import { clearCache as clearSkillCache } from "../skill/skill"
import { register, clear as clearRegistry } from "../tool/registry"
import { buildSkillTool } from "../tool/skill"
import { resetBootstrap } from "../bootstrap"
import { dismiss, getActive, info as notifyInfo } from "../notification/notification"
import { undoLatest } from "../commands/undo"
import { exportSessionToMarkdown } from "../commands/export"
import { runGoal } from "../commands/goal/orchestrator"
import { authStatus } from "../commands/auth"
import { firstRunAuthMessage, formatAuthStatuses } from "./auth-status"
import { listTasks } from "../task/task"
import { listWorktrees, filterToProjectWorktrees, getBranchFromPath, getWorktreeBranch, resolveWorktree, createWorktree } from "../worktree/worktree"
import * as path from "path"
import * as fs from "fs"
import type { SessionScope } from "./session-tree-picker"

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
function parseArg(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const idx = args.indexOf(flag)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return undefined
}

// Theme detection is deferred until after the renderer is created so we can
// use renderer.getPalette() (OpenTUI's native terminal palette query).
// The --theme flag still overrides everything.
const themeArg = parseArg("--theme")

// ---------------------------------------------------------------------------
// Parse --profile flag from CLI args
// ---------------------------------------------------------------------------
function parseProfileArg(): string | undefined {
  return parseArg("--profile")
}

// ---------------------------------------------------------------------------
// Profile-aware agent setup
// ---------------------------------------------------------------------------
const profileArg = parseProfileArg()
let profile
try {
  profile = resolveProfile(profileArg)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Configuration error: ${message}`)
  process.exit(1)
}
const promptResult = readPromptFile(profile)
let activeAgent: AgentConfig = agentFromProfile(profile, promptResult.content)

// Initialize the backend (DB + tools) with profile-bound skills
await bootstrap({ profileTools: profile.tools, boundSkills: profile.skills })

// Session starts null — created lazily on first message by prompt()
let currentSession: { id: string } | null = null

// Listen for lazy session creation from prompt()
bus.on("session-created", ({ sessionId }) => {
  currentSession = { id: sessionId }
  process.env.QUARK_SESSION_ID = sessionId
})

// Discover skills and determine model name at startup
const skills = discoverSkills()
const modelName = activeAgent.model
const startupAuthMessage = firstRunAuthMessage(modelName, await authStatus())
if (startupAuthMessage) setImmediate(() => notifyInfo("Provider authentication", startupAuthMessage, 8000))

// Populate LM Studio model cache (non-blocking)
refreshLMStudio()

// Runtime-only model override — set by /model picker, NOT persisted to config
let modelOverride: string | null = null

// Worktree state
const rootProjectDir = process.cwd()
const worktreeBase = path.join(rootProjectDir, ".quark", "worktrees")
let activeWorktree: { id: string; path: string; branch: string | null; shortHash: string; isRoot: boolean } | null = null
let activeBranch: string | null = getBranchFromPath(rootProjectDir)

async function switchToWorktree(id: string): Promise<{ success: boolean; error?: string }> {
  if (currentSession?.id && isActive(currentSession.id)) {
    return { success: false, error: "Cancel the running agent before switching worktrees" }
  }

  const all = listWorktrees(rootProjectDir)
  const projectWorktrees = filterToProjectWorktrees(all, rootProjectDir, worktreeBase)
  const target = resolveWorktree(projectWorktrees, id)

  if (!target) {
    return { success: false, error: `Worktree not found: ${id}` }
  }

  if (target.prunable || target.missing) {
    return { success: false, error: `Worktree is unavailable: ${target.path}` }
  }

  try {
    process.chdir(target.path)
  } catch {
    return { success: false, error: `Cannot access worktree directory: ${target.path}` }
  }

  // Reset session state
  currentSession = null
  delete process.env.QUARK_SESSION_ID

  // Reset caches
  resetConfigCache()
  resetProfileCache()
  clearSkillCache()

  // Re-bootstrap with new cwd
  clearRegistry()
  resetBootstrap()
  const nextProfile = resolveProfile(activeAgent.id)
  const nextPromptResult = readPromptFile(nextProfile)
  activeAgent = agentFromProfile(nextProfile, nextPromptResult.content)
  await bootstrap({ profileTools: nextProfile.tools, boundSkills: nextProfile.skills })

  modelOverride = null

  // Update worktree state
  const branch = target.branch ?? getWorktreeBranch(target)
  activeWorktree = target.isRoot
    ? null
    : { id: target.id, path: target.path, branch, shortHash: target.shortHash, isRoot: false }
  activeBranch = branch

  // Emit events
  const discoveredSkills = discoverSkills()
  const currentModel = modelOverride ?? activeAgent.model

  bus.emit("session-reset", { sessionId: null })
  bus.emit("model-switched", {
    modelSpec: currentModel,
    thinkingEffort: modelOverride ? "none" : activeAgent.thinkingEffort ?? "none",
    thinkingMode: modelOverride ? undefined : activeAgent.thinkingMode,
  })
  bus.emit("worktree-switched", {
    cwd: target.path,
    activeWorktree,
    activeBranch,
    modelSpec: currentModel,
    skillCount: discoveredSkills.length,
  })

  return { success: true }
}

function handleSubmit(text: string, sessionId: string | null, images?: { mime: string; data: string }[], context?: string) {
  const sid = sessionId ?? currentSession?.id

  const parts: { type: "text"; text: string }[] = []
  if (context) {
    parts.push({ type: "text", text: context })
  }
  parts.push({ type: "text", text })

  prompt({
    sessionId: sid,
    parts,
    images,
    model: modelOverride ?? undefined,
    agent: activeAgent,
  }).catch((err) => {
    bus.emit("error", { sessionId: sid ?? "unknown", error: err })
  })
}

function handleCancel(sessionId: string) {
  ghosttyTitle.markStopped(sessionId)
  cancel(sessionId)
}

function handleThinkingEffortChange(thinkingEffort: string) {
  activeAgent = { ...activeAgent, thinkingEffort }
}

function activateBranch(branch: BranchResult, goal: string, label: string): void {
  currentSession = { id: branch.sessionId }
  process.env.QUARK_SESSION_ID = branch.sessionId
  const child = loadMessages(branch.sessionId)
  const tuiMessages = dbToTuiMessages(child.messages, child.parts)
  const visibleMessages = branch.promptMessageId
    ? tuiMessages.filter((message) => message.id === branch.promptMessageId)
    : tuiMessages
  const modelMessages = toModelMessages(child.messages, child.parts)
  const system = buildSystem(activeAgent)
  const systemStr = Array.isArray(system) ? system.join("\n") : system
  const estimatedTokens = estimateTokens(systemStr, modelMessages)
  bus.emit("session-switch", {
    kind: branch.promptMessageId ? "branch" : "replace",
    sessionId: branch.sessionId,
    messages: visibleMessages as any,
    estimatedTokens,
    ...(branch.promptMessageId
      ? { divider: { id: `branch:${branch.sessionId}`, goal, label } }
      : {}),
  })
}

function runBranchGoal(branch: BranchResult, goal: string): void {
  if (!branch.promptMessageId) throw new Error("Branch was created without a prompt message")
  runSeededSession({
    sessionId: branch.sessionId,
    userMessageId: branch.promptMessageId,
    userText: goal,
    model: modelOverride ?? undefined,
    agent: activeAgent,
  }).then(({ sessionId }) => {
    currentSession = { id: sessionId }
    process.env.QUARK_SESSION_ID = sessionId
  }).catch((err) => {
    bus.emit("error", { sessionId: branch.sessionId, error: err })
  })
}

async function handleWorktreeCommand(args: string, sid: string | null): Promise<CommandResult> {
  const parts = args.trim().split(/\s+/)
  const subCmd = parts[0]

  if (subCmd === "create") {
    const branch = parts.slice(1).join(" ")
    if (!branch) {
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error("Usage: /worktree create <branch>") })
      return { handled: true }
    }

    try {
      const created = await createWorktree({ rootProjectDir, branch })
      const result = await switchToWorktree(created.id)
      if (result.success) {
        notifyInfo("Worktree", `Created and switched to: ${created.id}`, 3000)
        return { handled: true, next: "sessions-picker" }
      }
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(result.error ?? "Unknown error") })
    } catch (err) {
      bus.emit("error", { sessionId: sid ?? "unknown", error: err instanceof Error ? err : new Error(String(err)) })
    }
    return { handled: true }
  }

  if (args.trim()) {
    const result = await switchToWorktree(args.trim())
    if (result.success) {
      return { handled: true, next: "sessions-picker" }
    }
    bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(result.error ?? "Unknown error") })
    return { handled: true }
  }

  return { handled: false }
}

async function handleCommand(command: string, args: string, sessionId: string | null): Promise<CommandResult> {
  const sid = sessionId ?? currentSession?.id ?? null

  // /new and /clear work even without an active session
  if (command === "new") {
    const newSession = createSession()
    currentSession = { id: newSession.id }
    process.env.QUARK_SESSION_ID = newSession.id
    bus.emit("session-reset", { sessionId: newSession.id })
    notifyInfo("Session", `New session started`, 2000)
    return { handled: true }
  }

  if (command === "clear") {
    currentSession = null
    bus.emit("session-reset", { sessionId: null })
    return { handled: true }
  }

  // /model and /profile work even without an active session
  if (command === "model") {
    if (!args) {
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error("Use /model to open the model picker") })
      return { handled: true }
    }
    modelOverride = args.trim()
    bus.emit("model-switched", { modelSpec: modelOverride, thinkingEffort: "none" })
    notifyInfo("Model", `Switched to: ${modelOverride}`, 3000)
    return { handled: true }
  }

  if (command === "profile") {
    if (!args) {
      const available = listProfiles()
      const current = activeAgent.id
      const lines = available.map((p) => {
        const marker = p === current ? " ← active" : ""
        return `${p}${marker}`
      })
      notifyInfo("Profiles", lines.join("\n"), 6000)
      return { handled: true }
    }

    const targetId = args.trim()
    const available = listProfiles()
    if (!available.includes(targetId)) {
      bus.emit("error", {
        sessionId: sid ?? "unknown",
        error: new Error(`Profile "${targetId}" not found. Available: ${available.join(", ")}`),
      })
      return { handled: true }
    }

    // Switch profile: resolve, rebuild agent, re-register skill tool
    // NOTE: We do NOT create a new session - messages are preserved
    resetProfileCache()
    clearSkillCache()
    const newProfile = resolveProfile(targetId)
    const newPromptResult = readPromptFile(newProfile)
    activeAgent = agentFromProfile(newProfile, newPromptResult.content)
    modelOverride = null
    bus.emit("model-switched", {
      modelSpec: activeAgent.model,
      thinkingEffort: activeAgent.thinkingEffort ?? "none",
      thinkingMode: activeAgent.thinkingMode,
    })

    // Tear down and re-bootstrap with the new profile's tools and skills
    clearRegistry()
    resetBootstrap()
    await bootstrap({ profileTools: newProfile.tools, boundSkills: newProfile.skills })

    // Show toast notification for profile switch (no message in conversation)
    notifyInfo("Profile", `Switched to: ${newProfile.name}`, 3000)

    return { handled: true }
  }

  if (command === "auth") {
    const statuses = await authStatus()
    notifyInfo("Provider authentication", formatAuthStatuses(statuses).join("\n"), 8000)
    return { handled: true }
  }

  // /skills works even without an active session
  if (command === "skills") {
    if (!args) {
      notifyInfo("Skills", "Use /skills to open the skill picker", 3000)
      return { handled: true }
    }

    const skillName = args.trim()

    if (activeAgent.skills.includes(skillName)) {
      notifyInfo("Skills", `Skill "${skillName}" is already active`, 3000)
      return { handled: true }
    }

    const skill = loadSkill(skillName)
    if (!skill) {
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(`Skill "${skillName}" not found`) })
      return { handled: true }
    }

    // Temporarily add the skill to the current agent's skill list
    activeAgent.skills = [...activeAgent.skills, skillName]

    // Re-register the skill tool with expanded boundSkills so the agent can load it
    clearRegistry()
    resetBootstrap()
    await bootstrap({ profileTools: activeAgent.tools, boundSkills: activeAgent.skills })

    notifyInfo("Skills", `Added skill: ${skillName}`, 3000)
    return { handled: true }
  }

  if (command === "rename-session") {
    try {
      const input = JSON.parse(args) as { id?: string; title?: string }
      const title = input.title?.trim()
      const session = listProjectWorktreeSessions().find((item) => item.id === input.id)
      if (!session || !title) throw new Error("Invalid session rename")
      setSessionTitle(session.id, title)
      notifyInfo("Session", `Renamed to: ${title}`, 2000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(message) })
    }
    return { handled: true }
  }

  if (command === "delete-session") {
    try {
      const input = JSON.parse(args) as { id?: string }
      const sessions = listProjectWorktreeSessions()
      const session = sessions.find((item) => item.id === input.id)
      if (!session) throw new Error("Session not found")
      if (session.id === currentSession?.id) throw new Error("The current session cannot be deleted")
      if (sessions.some((item) => item.parentSessionId === session.id)) {
        throw new Error("Delete this session's child branches first")
      }
      deleteSession(session.id)
      notifyInfo("Session", "Session deleted", 2000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(message) })
    }
    return { handled: true }
  }

  if (command === "pin-session") {
    try {
      const input = JSON.parse(args) as { id?: string; pinned?: boolean }
      const session = listProjectWorktreeSessions().find((item) => item.id === input.id)
      if (!session || typeof input.pinned !== "boolean") throw new Error("Session not found")
      setSessionPinned(session.id, input.pinned)
      notifyInfo("Session", input.pinned ? "Session pinned" : "Session unpinned", 1500)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(message) })
    }
    return { handled: true }
  }

  // /sessions works even without an active session (picker can be opened any time)
  if (command === "sessions") {
    if (!args) {
      const sessions = listProjectSessions()
      const tasks = new Map(listTasks().map((task) => [task.id, task]))
      if (sessions.length === 0) {
        bus.emit("error", { sessionId: sid ?? "unknown", error: new Error("No sessions found") })
        return { handled: true }
      }

      const lines = sessions.map((s) => {
        const isCurrent = s.id === sid
        const date = new Date(s.timeUpdated).toLocaleString()
        const title = s.title ?? "(untitled)"
        const task = s.taskId ? tasks.get(s.taskId)?.title : undefined
        const marker = isCurrent ? " ← current" : ""
        return `  ${s.id.slice(0, 8)}  ${title}${task ? `  ·  ${task}` : ""}  ${date}${marker}`
      })
      const header = `Sessions (${sessions.length}):\n`
      bus.emit("user-message", {
        sessionId: sid ?? "unknown",
        messageId: `sessions-list-${Date.now()}`,
        text: header + lines.join("\n") + "\n\nUse /sessions <id-prefix> to switch",
      })
      return { handled: true }
    }

    const sessions = listProjectWorktreeSessions()
    const match = sessions.find((s) => s.id.startsWith(args))
    if (!match) {
      bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(`No session matching "${args}"`) })
      return { handled: true }
    }

    if (match.directory && path.resolve(match.directory) !== path.resolve(process.cwd())) {
      const worktree = getProjectWorktrees().find((item) =>
        path.resolve(item.path) === path.resolve(match.directory!))
      if (!worktree) {
        bus.emit("error", { sessionId: sid ?? "unknown", error: new Error("Session worktree is unavailable") })
        return { handled: true }
      }
      const result = await switchToWorktree(worktree.id)
      if (!result.success) {
        bus.emit("error", { sessionId: sid ?? "unknown", error: new Error(result.error ?? "Cannot switch worktree") })
        return { handled: true }
      }
    }

    currentSession = match
    process.env.QUARK_SESSION_ID = match.id
    const { messages, parts } = loadMessages(match.id)
    const tuiMessages = dbToTuiMessages(messages, parts)
    // Prefer real API token count from DB; fall back to chars/4 heuristic
    const lastReal = getLastInputTokens(parts)
    let switchEstimatedTokens: number
    if (lastReal > 0) {
      switchEstimatedTokens = lastReal
    } else {
      const switchModelMessages = toModelMessages(messages, parts)
      const switchSystem = buildSystem(activeAgent)
      const switchSystemStr = Array.isArray(switchSystem) ? switchSystem.join("\n") : switchSystem
      switchEstimatedTokens = estimateTokens(switchSystemStr, switchModelMessages)
    }
    bus.emit("session-switch", { kind: "replace", sessionId: match.id, messages: tuiMessages as any, estimatedTokens: switchEstimatedTokens })
    return { handled: true }
  }

  // /settings — open config in $EDITOR (works without an active session)
  if (command === "settings") {
    await openEditor(sid)
    return { handled: true }
  }

  // /reload-config — reload config without restarting (works without an active session)
  if (command === "reload-config") {
    for (const n of getActive()) {
      if (n.title === "Thinking configuration") dismiss(n.id)
    }
    resetConfigCache()
    resetProfileCache()
    const reloadedProfile = resolveProfile(activeAgent.id)
    const reloadedPrompt = readPromptFile(reloadedProfile)
    activeAgent = agentFromProfile(reloadedProfile, reloadedPrompt.content)
    const currentModel = modelOverride ?? activeAgent.model
    bus.emit("model-switched", {
      modelSpec: currentModel,
      thinkingEffort: modelOverride ? "none" : activeAgent.thinkingEffort ?? "none",
      thinkingMode: modelOverride ? undefined : activeAgent.thinkingMode,
    })
    refreshLMStudio()
    notifyInfo("Config", "Config reloaded", 3000)
    return { handled: true }
  }

  if (command === "worktree") {
    return handleWorktreeCommand(args, sid)
  }

  // All other commands require an active session
  if (!sid) {
    bus.emit("error", { sessionId: "unknown", error: new Error("No active session — send a message first") })
    return { handled: true }
  }

  switch (command) {
    case "export": {
      try {
        const result = exportSessionToMarkdown(sid)
        notifyInfo("Export", `Saved ${result.messageCount} message(s) to ${result.filePath}`, 5000)
      } catch (err) {
        bus.emit("error", {
          sessionId: sid,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
      return { handled: true }
    }

    case "undo": {
      const result = await undoLatest(sid)
      if (!result) {
        notifyInfo("Undo", "Nothing to undo — no tracked file changes", 3000)
        return { handled: true }
      }

      const parts: string[] = []
      if (result.restored.length > 0) {
        parts.push(`${result.restored.length} file(s) restored`)
      }
      if (result.deleted.length > 0) {
        parts.push(`${result.deleted.length} file(s) deleted`)
      }

      bus.emit("undo-applied", {
        sessionId: sid,
        keepMessagesUpTo: result.messageId,
        restored: result.restored.length,
        deleted: result.deleted.length,
      })

      notifyInfo("Undo", parts.join(", "), 3000)
      return { handled: true }
    }

    case "compact": {
      bus.emit("steer-start", { sessionId: sid })
      let branchReady = false
      try {
        const goal = args.trim()
        const { messages, parts } = loadMessages(sid)
        const model = await resolveModel(loadConfig().small_model)
        const branch = await compactBranch({
          sessionId: sid,
          messages,
          parts,
          model,
          profile: activeAgent.id,
          prompt: goal || undefined,
        })

        bus.emit("steer-end", { sessionId: sid })
        branchReady = true
        activateBranch(branch, goal || "Compacted history", "Compacted")
        if (goal) runBranchGoal(branch, goal)
        notifyInfo("Compact", "Branched with compacted history", 3000)
      } catch (err) {
        bus.emit("error", {
          sessionId: sid,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      } finally {
        if (!branchReady) bus.emit("steer-end", { sessionId: sid })
      }
      return { handled: true }
    }

    case "steer": {
      const goal = args.trim()
      bus.emit("steer-start", { sessionId: sid })
      let steeringEnded = false
      try {
        const { messages, parts } = loadMessages(sid)
        const branch = createSteerBranch({
          sessionId: sid,
          prompt: goal || undefined,
          profile: activeAgent.id,
          messages,
          parts,
        })

        bus.emit("steer-end", { sessionId: sid })
        steeringEnded = true
        activateBranch(branch, goal, "Steered")
        if (goal) runBranchGoal(branch, goal)
        notifyInfo("Steer", "Branched to new session", 3000)
      } catch (err) {
        bus.emit("error", {
          sessionId: sid,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      } finally {
        if (!steeringEnded) bus.emit("steer-end", { sessionId: sid })
      }
      return { handled: true }
    }

    case "goal": {
      if (!args.trim()) {
        bus.emit("error", { sessionId: sid, error: new Error("Usage: /goal <goal description>") })
        return { handled: true }
      }

      bus.emit("steer-start", { sessionId: sid })
      try {
        await runGoal({ goal: args.trim() })
      } catch (err) {
        bus.emit("error", {
          sessionId: sid,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      } finally {
        bus.emit("steer-end", { sessionId: sid })
      }
      return { handled: true }
    }

    default:
      return { handled: false }
  }
}

// The editor inherits the terminal directly, so it renders in the same window
// like `git commit` opening vim. This is shared by /settings and file links.
let openingEditor = false
async function openEditor(sid: string | null, target: FileTarget = { filePath: CONFIG_PATH }): Promise<void> {
  if (openingEditor) return
  openingEditor = true
  const editor = resolveEditor(loadConfig().editor)

  renderer.suspend()
  try {
    if (!fs.existsSync(target.filePath)) throw new Error(`File not found: ${target.filePath}`)
    const proc = Bun.spawn(buildEditorArgv(editor, target), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`${editor} exited with code ${code}`)
  } catch (err) {
    setImmediate(() => {
      bus.emit("error", {
        sessionId: sid ?? "unknown",
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })
  } finally {
    renderer.resume()
    ghosttyTitle.refresh()
    openingEditor = false
  }
}

function getProjectWorktrees() {
  return filterToProjectWorktrees(listWorktrees(rootProjectDir), rootProjectDir, worktreeBase)
}

function listProjectWorktreeSessions() {
  const directories = new Set(getProjectWorktrees()
    .filter((worktree) => !worktree.prunable && !worktree.missing)
    .map((worktree) => path.resolve(worktree.path)))
  return listSessions().filter((session) =>
    session.directory ? directories.has(path.resolve(session.directory)) : false)
}

function handleGetSessions(scope: SessionScope = "worktree") {
  const tasks = new Map(listTasks().map((task) => [task.id, task]))
  const sessions = scope === "project" ? listProjectWorktreeSessions() : listProjectSessions()
  return sessions.map((session) => ({
    ...session,
    taskTitle: session.taskId ? tasks.get(session.taskId)?.title : undefined,
    running: isActive(session.id),
  }))
}

function handleGetWorktrees() {
  const currentPath = process.cwd()
  return getProjectWorktrees()
    .filter((wt) => !wt.prunable)
    .map((wt) => ({
    id: wt.id,
    path: wt.path,
    branch: wt.branch ?? getWorktreeBranch(wt),
    shortHash: wt.shortHash,
    isRoot: wt.isRoot,
    isCurrent: path.resolve(wt.path) === path.resolve(currentPath),
    prunable: wt.prunable,
    missing: wt.missing,
    sessionCount: listProjectSessions(wt.path).length,
  }))
}

function handleGetModels() {
  return buildModelPickerOptions(loadConfig().models)
}

function handleGetCurrentModel() {
  return modelOverride ?? activeAgent.model
}

function handleGetProfiles() {
  return listProfiles().map((id) => ({ id, name: id }))
}

function handleGetCurrentProfile() {
  return activeAgent.id
}

function handleGetSkills() {
  return discoverSkills().map((s) => ({ id: s.name, name: s.name }))
}

function handleGetCurrentSkill() {
  return ""
}

function handleCreateAsyncSession(): string {
  const sess = createSession({ ephemeral: true })
  return sess.id
}

// Pre-create the renderer so module-level code (e.g. openEditor) can
// suspend/resume it when shelling out to an external editor.
const renderer = await createCliRenderer({
  targetFps: 60,
  exitOnCtrlC: false,
  consoleOptions: {
    keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
    onCopySelection: (text) => {
      writeClipboard(text).catch((err) => {
        console.error(`Failed to copy console selection: ${err}`)
      })
    },
  },
})

const ghosttyTitle = createGhosttyTitleController({
  bus,
  renderer,
  getSession,
  initialSessionId: currentSession?.id,
  enabled: isGhostty(),
})

// ---------------------------------------------------------------------------
// Theme detection — deferred until after renderer creation so we can use
// renderer.getPalette() for reliable terminal background detection.
// Tier 1: --theme CLI flag (user override)
// Tier 2: renderer.getPalette() (OpenTUI native, uses OSC queries)
// Tier 3: terminal config file parsing (Ghostty, Kitty, iTerm2)
// Tier 4: macOS system dark-mode preference
// Tier 5: hard-coded dark fallback
// ---------------------------------------------------------------------------
const envTheme = process.env.QUARK_THEME
if (themeArg === "light" || themeArg === "dark") {
  applyTheme(themeArg === "light" ? lightTheme : darkTheme)
} else if (envTheme === "light" || envTheme === "dark") {
  applyTheme(envTheme === "light" ? lightTheme : darkTheme)
} else {
  let bg: RGBA | undefined
  try {
    const palette = await renderer.getPalette({ timeout: 1200 })
    if (palette.defaultBackground) {
      bg = RGBA.fromHex(palette.defaultBackground)
    }
  } catch { /* palette detection failed — fall through */ }

  if (!bg) {
    bg = detectFromConfigOrOS()
  }

  setTerminalBg(bg)
}

render(() => (
  <App
    onSubmit={handleSubmit}
    onCancel={handleCancel}
    onThinkingEffortChange={handleThinkingEffortChange}
    onCommand={handleCommand}
    onCreateAsyncSession={handleCreateAsyncSession}
    onOpenFile={(target) => { void openEditor(currentSession?.id ?? null, target) }}
    getSessions={handleGetSessions}
    getWorktrees={handleGetWorktrees}
    getModels={handleGetModels}
    getCurrentModel={handleGetCurrentModel}
    getProfiles={handleGetProfiles}
    getCurrentProfile={handleGetCurrentProfile}
    getSkills={handleGetSkills}
    getCurrentSkill={handleGetCurrentSkill}
    initialSessionId={currentSession?.id}
    initialModelName={modelName}
    initialSkillCount={skills.length}
    initialThinkingEffort={activeAgent.thinkingEffort}
  />
), renderer)
