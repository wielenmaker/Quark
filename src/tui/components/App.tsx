// @jsxImportSource @opentui/solid
// App — root TUI component (OpenTUI/SolidJS)
//
// Fullscreen layout: the app fills the entire terminal.
// Messages render in a native <scrollbox> with smooth scrolling.
// Input/autocomplete/footer are pinned at the bottom.

import type { Component } from "solid-js"
import { For, Index, createSignal, createEffect, createMemo, onCleanup, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid"
import { MacOSScrollAccel } from "@opentui/core"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { createAppState, dispatch, type AppState } from "../state"
import { wireEvents } from "../events"
import { bus } from "../../session/events"
import { ready as modelsReady, getModelLimit } from "../../provider/models"
import { MessageItem } from "./message-item"
import { getContinuingToolCallId, mergeToolActivityMessages } from "./tool-activity"
import { SteerDivider } from "./steer-divider"
import { Prompt } from "./prompt"
import { Autocomplete, type PickerItem, type AutocompleteMode } from "./autocomplete"
import { CommandPalette, type PaletteMode } from "./command-palette"
import { preservePaletteSelectionIndex, searchPaletteEntries, type PaletteEntry } from "../palette-index"
import { QuestionPrompt, createQuestionKeyHandler } from "./question-prompt"
import { FooterBar } from "./footer-bar"
import { Notifications } from "./notifications"
import { colors } from "../theme"
import { respondQuestion } from "../../tool/question"
import { getFiles, fuzzyFilter, clearFileCache } from "../../shared/filelist"
import { filterCommands, type SlashCommand } from "../commands"
import {
  buildSessionTreeRows,
  firstSelectableSessionRow,
  moveSessionRowSelection,
  searchSessionTree,
  type SessionTreeInput,
  type SessionTreeRow,
} from "../session-tree-picker"
import {
  buildWorktreeRows,
  firstSelectableWorktreeRow,
  moveWorktreeRowSelection,
  type WorktreePickerRow,
} from "../worktree-picker"
import { generateId } from "ai"
import * as fs from "fs"
import * as path from "path"
import { readClipboard } from "../clipboard"
import { writeClipboard } from "../clipboard"
import { collectStatistics, renderStatisticsChart } from "../../commands/statistics"
import { StatisticsPanel } from "./statistics-panel"
import { AsyncPanel } from "./async-panel"
import { info as notifyInfo, warn as notifyWarn } from "../../notification/notification"
import { getNextModel, getPrevModel } from "../model-cycle"
import { buildPickerItems, pickerModeForCommand, type ChoicePickerMode } from "../picker-items"
import type { FileTarget } from "../editor"
import { authStatus, loginApiKey, loginOAuth } from "../../commands/auth"
import { loadConfig } from "../../config/config"
import { buildConnectProviderRows, safeConnectError, type ConnectProviderRow } from "../connect-provider"

/** Command handler result */
export type CommandResult =
  | { handled: true; next?: "sessions-palette" | "conversation"; error?: string }
  | { handled: false }

interface AppProps {
  onSubmit: (text: string, sessionId: string | null, images?: { mime: string; data: string }[], context?: string) => void
  onCancel: (sessionId: string) => void
  onThinkingEffortChange?: (effort: string) => void
  onCommand?: (command: string, args: string, sessionId: string | null) => Promise<CommandResult> | CommandResult | void
  onCreateAsyncSession?: () => string
  onOpenFile?: (target: FileTarget) => void
  getSessions?: () => SessionTreeInput[]
  getWorktrees?: () => {
    id: string
    path: string
    branch: string | null
    shortHash: string
    isRoot: boolean
    isCurrent: boolean
    prunable: boolean
    missing: boolean
    sessionCount: number
    timeUpdated: number
  }[]
  getModels?: () => { id: string; name: string; detail?: string }[]
  getCurrentModel?: () => string
  getProfiles?: () => { id: string; name: string }[]
  getCurrentProfile?: () => string
  getPaletteEntries?: () => PaletteEntry[] | Promise<PaletteEntry[]>
  initialSessionId?: string
  initialMessages?: TuiMessage[]
  initialModelName?: string
  initialSkillCount?: number
  initialThinkingEffort?: string
}

interface QueuedUserMessage {
  id: string
  text: string
  images?: { mime: string; data: string; label: string }[]
  context?: string
}

// ---------------------------------------------------------------------------
// @ mention state machine
// ---------------------------------------------------------------------------

interface MentionState {
  active: boolean
  atIndex: number
  query: string
  items: string[]
  selectedIndex: number
}

const MENTION_INACTIVE: MentionState = {
  active: false,
  atIndex: -1,
  query: "",
  items: [],
  selectedIndex: 0,
}

// ---------------------------------------------------------------------------
// / slash command state machine
// ---------------------------------------------------------------------------

interface SlashState {
  active: boolean
  mode: "commands" | ChoicePickerMode
  query: string
  items: SlashCommand[]
  pickerItems: PickerItem[]
  selectedIndex: number
}

interface PaletteSearchSnapshot {
  entries: PaletteEntry[]
}

const SLASH_INACTIVE: SlashState = {
  active: false,
  mode: "commands",
  query: "",
  items: [],
  pickerItems: [],
  selectedIndex: 0,
}

const MAX_FILE_ITEMS = 50
const SCROLL_STEP = 3

export const App: Component<AppProps> = (props) => {
  const dims = useTerminalDimensions()
  const renderer = useRenderer()

  // Wire up console copy-to-clipboard — also shows a toast on success
  renderer.console.onCopySelection = async (text: string) => {
    if (!text) return
    await writeClipboard(text)
      .then(() => notifyInfo("Clipboard", "Copied to clipboard", 2000))
      .catch((err) => console.error(`Failed to copy: ${err}`))
    renderer.clearSelection()
  }

  // Copy selection to clipboard helper — used by onMouseUp on the root box
  const copySelection = () => {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text) return
    writeClipboard(text)
      .then(() => notifyInfo("Clipboard", "Copied to clipboard", 2000))
      .catch((err) => console.error(`Failed to copy: ${err}`))
    renderer.clearSelection()
  }

  function exitApp() {
    renderer.destroy()
    process.exit(0)
  }

  // --- App-level state store (messages, session, running, status, etc.) ---
  const state = createAppState({
    sessionId: props.initialSessionId ?? null,
    messages: props.initialMessages ?? [],
    modelName: props.initialModelName ?? "smart",
    skillCount: props.initialSkillCount ?? 0,
    thinkingEffort: props.initialThinkingEffort,
  })

  const activityMessages = createMemo(() => mergeToolActivityMessages(
    state.store.messages,
    new Set(state.store.steerDividers.map((divider) => divider.insertionIndex)),
  ))
  const continuingToolCallId = createMemo(() => getContinuingToolCallId(
    state.store.messages,
    state.store.running,
  ))

  // Wire event bus to state store
  wireEvents(state)

  // Question prompt key handler
  const questionHandler = createQuestionKeyHandler({
    request: () => state.store.question,
    onReply: (answers) => {
      const q = state.store.question
      if (!q) return

      // Show the answer as a user message in the chat
      const answerText = q.questions
        .map((qn, i) => {
          const picked = answers[i]
          return picked?.length ? picked.join(", ") : "(no answer)"
        })
        .join("; ")
      const msgId = generateId()
      dispatch(state, { type: "add-user-message", id: msgId, text: answerText })

      respondQuestion({ requestId: q.requestId, answers })
      dispatch(state, { type: "clear-question" })
      dispatch(state, { type: "set-running", running: true })
    },
    onReject: () => {
      const q = state.store.question
      if (!q) return
      // Cancel the agent loop first — this triggers the AbortSignal
      // which the question tool listens for to cleanly abort.
      props.onCancel(q.sessionId)
      respondQuestion({ requestId: q.requestId, rejected: true })
      dispatch(state, { type: "clear-question" })
    },
  })

  // Update tokenLimit once models.dev data is available
  modelsReady.then(() => {
    const lim = getModelLimit(state.store.status.modelName)
    const limit = lim?.context ?? lim?.input
    if (limit) state.setStore("status", "tokenLimit", limit)
  })

  // --- Refs ---
  let scroll: ScrollBoxRenderable | undefined
  let inputRef: TextareaRenderable | undefined
  let paletteInputRef: TextareaRenderable | undefined
  let sessionActionInputRef: TextareaRenderable | undefined
  let customQuestionRef: TextareaRenderable | undefined

  // --- Local UI signals (not in the global store — ephemeral) ---
  const [mention, setMention] = createSignal<MentionState>(MENTION_INACTIVE)
  const [slash, setSlash] = createSignal<SlashState>(SLASH_INACTIVE)
  // Mirror of input value (kept in sync with inputRef via onInput)
  const [inputValue, setInputValue] = createSignal("")
  const [queuedMessages, setQueuedMessages] = createSignal<QueuedUserMessage[]>([])
  const [selectedQueuedMessageId, setSelectedQueuedMessageId] = createSignal<string | null>(null)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [paletteQuery, setPaletteQuery] = createSignal("")
  const [paletteEntries, setPaletteEntries] = createSignal<PaletteEntry[]>([])
  const [paletteResults, setPaletteResults] = createSignal<PaletteEntry[]>([])
  const [paletteSelectedIndex, setPaletteSelectedIndex] = createSignal(0)
  const [paletteMode, setPaletteMode] = createSignal<PaletteMode>("search")
  const [connectProviders, setConnectProviders] = createSignal<ConnectProviderRow[]>([])
  const [connectProvider, setConnectProvider] = createSignal<ConnectProviderRow | undefined>()
  const [connectApiKey, setConnectApiKey] = createSignal("")
  const [connectDeviceCode, setConnectDeviceCode] = createSignal<{ verificationUri: string; userCode: string } | undefined>()
  const [connectBrowserUrl, setConnectBrowserUrl] = createSignal<string | undefined>()
  const [connectAwaitingBrowserInput, setConnectAwaitingBrowserInput] = createSignal(false)
  const [connectResult, setConnectResult] = createSignal<{ kind: "success" | "info" | "error"; message: string } | undefined>()
  let connectAbortController: AbortController | undefined
  let resolveBrowserPrompt: ((value: string) => void) | undefined
  const [paletteSessionInputs, setPaletteSessionInputs] = createSignal<SessionTreeInput[]>([])
  const [paletteSessionRows, setPaletteSessionRows] = createSignal<SessionTreeRow[]>([])
  const [paletteSessionAction, setPaletteSessionAction] = createSignal<"browse" | "rename">("browse")
  const [sessionActionMenuOpen, setSessionActionMenuOpen] = createSignal(false)
  const [sessionActionQuery, setSessionActionQuery] = createSignal("")
  const [sessionActionSelectedIndex, setSessionActionSelectedIndex] = createSignal(0)
  const [paletteWorktreeInputs, setPaletteWorktreeInputs] = createSignal<WorktreePickerRow[]>([])
  const [paletteWorktreeRows, setPaletteWorktreeRows] = createSignal<WorktreePickerRow[]>([])
  const [worktreeCreateError, setWorktreeCreateError] = createSignal<string | undefined>()
  let paletteGeneration = 0
  let paletteSearchSnapshot: PaletteSearchSnapshot | null = null
  let savedComposer: {
    text: string
    cursorOffset: number
    images: { mime: string; data: string; label: string }[]
    selectedImageIndex: number | null
    historyIndex: number
    historyDraft: string
    scrollTop: number
  } | null = null
  // Statistics panel visibility and content
  const [statisticsContent, setStatisticsContent] = createSignal<string | null>(null)
  // Async panel side-session ID (created lazily on first panel submit)
  const [asyncSessionId, setAsyncSessionId] = createSignal<string | null>(null)

  const clearQueuedMessages = () => {
    setQueuedMessages([])
    setSelectedQueuedMessageId(null)
  }
  const clearQueueOnSessionChange = () => clearQueuedMessages()
  bus.on("session-reset", clearQueueOnSessionChange)
  bus.on("session-switch", clearQueueOnSessionChange)
  bus.on("worktree-switched", clearQueueOnSessionChange)
  onCleanup(() => {
    bus.off("session-reset", clearQueueOnSessionChange)
    bus.off("session-switch", clearQueueOnSessionChange)
    bus.off("worktree-switched", clearQueueOnSessionChange)
  })

  // File cache (loaded lazily on first @ mention)
  let allFiles: string[] | null = null

  // Pending image attachments — cleared on submit
  const [pendingImages, setPendingImages] = createSignal<{ mime: string; data: string; label: string }[]>([])
  // Index of the chip currently selected for deletion (null = none)
  const [selectedImageIndex, setSelectedImageIndex] = createSignal<number | null>(null)

  // ---------------------------------------------------------------------------
  // Message history navigation (↑/↓ like a terminal shell)
  // historyIndex: -1 = not navigating (showing draft or current input)
  //               0  = most recent sent message
  //               n  = n-th message back in history
  // ---------------------------------------------------------------------------
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  // Saved draft text — restored when the user presses ↓ past the most recent entry
  const [historyDraft, setHistoryDraft] = createSignal("")

  // Derive the ordered list of unique user message texts from the store
  // (oldest → newest, so index 0 in reversed view = most recent)
  const userHistory = (): string[] => {
    const texts: string[] = []
    for (const msg of state.store.messages) {
      if (msg.role !== "user") continue
      const textPart = msg.parts.find((p) => p.type === "text")
      if (textPart && textPart.type === "text" && textPart.text.trim()) {
        texts.push(textPart.text)
      }
    }
    // Return reversed so index 0 = most recent
    return texts.reverse()
  }

  // Auto-clear selection when all pending images are gone
  createEffect(() => {
    if (pendingImages().length === 0) setSelectedImageIndex(null)
  })

  // Reset history navigation when the session changes
  createEffect(() => {
    // Track sessionId — reset index and draft whenever it changes
    state.store.sessionId
    setHistoryIndex(-1)
    setHistoryDraft("")
  })

  const ensureFilesLoaded = async (): Promise<string[]> => {
    if (allFiles) return allFiles
    const files = await getFiles()
    allFiles = files
    return files
  }

  // Whether any dropdown or overlay is active
  const dropdownActive = () => mention().active || slash().active || paletteOpen() || statisticsContent() !== null

  // ---------------------------------------------------------------------------
  // Pending image removal
  // ---------------------------------------------------------------------------

  const removeImage = (index: number) => {
    setPendingImages((prev) => {
      const next = prev.filter((_, i) => i !== index)
      // Renumber labels to keep them sequential (Image 1, Image 2, …)
      return next.map((img, i) => ({ ...img, label: `Image ${i + 1}` }))
    })
    setSelectedImageIndex(null)
  }

  // ---------------------------------------------------------------------------
  // Mention updater — called when input value changes
  // ---------------------------------------------------------------------------

  const updateMentionFromValue = async (newValue: string) => {
    const lastAt = newValue.lastIndexOf("@")
    if (lastAt === -1) {
      setMention(MENTION_INACTIVE)
      return
    }

    // @ must be at start or preceded by a space
    if (lastAt > 0 && newValue[lastAt - 1] !== " ") {
      setMention(MENTION_INACTIVE)
      return
    }

    const query = newValue.slice(lastAt + 1)

    // If there's a space after @query, mention is done
    if (query.includes(" ")) {
      setMention(MENTION_INACTIVE)
      return
    }

    // Fresh @ activation — invalidate stale file cache so newly created
    // folders/files appear in the dropdown.
    if (!mention().active) {
      clearFileCache()
      allFiles = null
    }

    const files = await ensureFilesLoaded()
    const filtered = fuzzyFilter(files, query, MAX_FILE_ITEMS)

    setMention({
      active: true,
      atIndex: lastAt,
      query,
      items: filtered,
      selectedIndex: 0,
    })
  }

  // ---------------------------------------------------------------------------
  // Slash updater — called when input value changes
  // ---------------------------------------------------------------------------

  const restoreComposer = (textOverride?: string) => {
    const saved = savedComposer
    savedComposer = null
    paletteSearchSnapshot = null
    setPaletteOpen(false)
    setPaletteQuery("")
    setPaletteEntries([])
    setPaletteResults([])
    setPaletteSelectedIndex(0)
    setPaletteMode("search")
    setConnectProviders([])
    setConnectProvider(undefined)
    setConnectApiKey("")
    setConnectDeviceCode(undefined)
    setConnectBrowserUrl(undefined)
    setConnectAwaitingBrowserInput(false)
    setConnectResult(undefined)
    connectAbortController = undefined
    resolveBrowserPrompt = undefined
    setPaletteSessionInputs([])
    setPaletteSessionRows([])
    setPaletteSessionAction("browse")
    setSessionActionMenuOpen(false)
    setSessionActionQuery("")
    setSessionActionSelectedIndex(0)
    setPaletteWorktreeInputs([])
    setPaletteWorktreeRows([])
    setWorktreeCreateError(undefined)
    if (!saved) return
    const text = textOverride ?? saved.text
    setPendingImages(saved.images)
    setSelectedImageIndex(saved.selectedImageIndex)
    setHistoryIndex(saved.historyIndex)
    setHistoryDraft(saved.historyDraft)
    setInputText(text)
    if (inputRef) inputRef.cursorOffset = textOverride === undefined ? Math.min(saved.cursorOffset, text.length) : text.length
    if (scroll) scroll.scrollTop = saved.scrollTop
  }

  const openPalette = (snapshot?: { text: string; cursorOffset: number }) => {
    if (!inputRef || !props.getPaletteEntries) return false
    if (state.store.question || state.store.asyncPanel || statisticsContent() !== null) return false
    paletteSearchSnapshot = null
    savedComposer = {
      text: snapshot?.text ?? "",
      cursorOffset: snapshot?.cursorOffset ?? 0,
      images: [...pendingImages()],
      selectedImageIndex: selectedImageIndex(),
      historyIndex: historyIndex(),
      historyDraft: historyDraft(),
      scrollTop: scroll?.scrollTop ?? 0,
    }
    const generation = ++paletteGeneration
    setSlash(SLASH_INACTIVE)
    setMention(MENTION_INACTIVE)
    setInputText("")
    setPaletteQuery("")
    setPaletteEntries([])
    setPaletteResults([])
    setPaletteSelectedIndex(0)
    setPaletteMode("search")
    setConnectProviders([])
    setConnectProvider(undefined)
    setConnectApiKey("")
    setConnectDeviceCode(undefined)
    setConnectBrowserUrl(undefined)
    setConnectAwaitingBrowserInput(false)
    setConnectResult(undefined)
    connectAbortController = undefined
    resolveBrowserPrompt = undefined
    setPaletteSessionInputs([])
    setPaletteSessionRows([])
    setPaletteSessionAction("browse")
    setSessionActionMenuOpen(false)
    setSessionActionQuery("")
    setSessionActionSelectedIndex(0)
    setPaletteWorktreeInputs([])
    setPaletteWorktreeRows([])
    setWorktreeCreateError(undefined)
    setPaletteOpen(true)
    Promise.resolve(props.getPaletteEntries())
      .then((entries) => {
        if (!paletteOpen() || generation !== paletteGeneration) return
        setPaletteEntries(entries)
        const results = searchPaletteEntries(entries, paletteQuery())
        setPaletteResults(results)
        setPaletteSelectedIndex(0)
      })
      .catch((error) => {
        if (paletteOpen() && generation === paletteGeneration) {
          notifyWarn("Command palette", error instanceof Error ? error.message : String(error), 4000)
        }
      })
    return true
  }

  const entityPaletteEntries = (type: "skill" | "model" | "provider") => paletteEntries()
    .filter((entry) => entry.type === type)
    .sort((a, b) => Number(Boolean(b.isCurrent)) - Number(Boolean(a.isCurrent)) || a.label.localeCompare(b.label))

  const savePaletteSearch = () => {
    if (paletteMode() !== "search") return
    paletteSearchSnapshot = { entries: paletteEntries() }
  }

  const restorePaletteSearch = () => {
    const snapshot = paletteSearchSnapshot
    if (!snapshot) return false
    paletteSearchSnapshot = null
    paletteGeneration++
    setPaletteMode("search")
    setPaletteQuery("")
    paletteInputRef?.clear()
    setPaletteEntries(snapshot.entries)
    setPaletteResults([])
    setPaletteSelectedIndex(0)
    setPaletteSessionInputs([])
    setPaletteSessionRows([])
    setPaletteSessionAction("browse")
    setPaletteWorktreeInputs([])
    setPaletteWorktreeRows([])
    setWorktreeCreateError(undefined)
    return true
  }

  const openEntityPalette = (mode: "skills" | "models", type: "skill" | "model") => {
    setPaletteMode(mode)
    setPaletteQuery("")
    paletteInputRef?.clear()
    setPaletteResults(entityPaletteEntries(type))
    setPaletteSelectedIndex(0)
  }

  const openConnectProviders = async () => {
    const generation = paletteGeneration
    setPaletteMode("connect-providers")
    setPaletteQuery("")
    paletteInputRef?.clear()
    setPaletteSelectedIndex(0)
    setConnectProvider(undefined)
    setConnectApiKey("")
    setConnectDeviceCode(undefined)
    setConnectBrowserUrl(undefined)
    setConnectAwaitingBrowserInput(false)
    setConnectResult(undefined)
    const providers = await (async () => {
      try {
        return buildConnectProviderRows(await authStatus(), loadConfig().providers)
      } catch {
        return buildConnectProviderRows([], loadConfig().providers)
      }
    })()
    if (!paletteOpen() || paletteMode() !== "connect-providers" || generation !== paletteGeneration) return
    const entries = providers.map((provider): PaletteEntry => ({
      key: `provider:${provider.id}`,
      type: "provider",
      id: provider.id,
      label: provider.name,
      detail: `${provider.detail}${provider.status ? ` · ${provider.status}` : ""}`,
      searchText: [provider.name, provider.id, provider.detail, provider.status ?? ""],
      action: { type: "provider", providerId: provider.id },
    }))
    setConnectProviders(providers)
    setPaletteEntries(entries)
    setPaletteResults(entries)
  }

  const finishConnect = async (provider: ConnectProviderRow) => {
    const refreshed = await authStatus()
    const status = refreshed.find((item) => item.providerId.toLowerCase() === provider.id.toLowerCase())
    setConnectResult(status?.origin === "environment"
      ? { kind: "info", message: `✓ Stored credential for ${provider.name}; its environment credential remains active` }
      : { kind: "success", message: `✓ Connected to ${provider.name}` })
    setPaletteMode("connect-result")
    setTimeout(() => {
      if (paletteOpen() && paletteMode() === "connect-result") restoreComposer()
    }, 1200)
  }

  const failConnect = (provider: ConnectProviderRow, error: unknown) => {
    setConnectApiKey("")
    setPaletteQuery("")
    setConnectResult({ kind: "error", message: safeConnectError(error) })
    notifyWarn(`Connect ${provider.name}`, safeConnectError(error), 4000)
  }

  const authorizeProvider = async (provider: ConnectProviderRow, method?: "browser" | "device") => {
    connectAbortController = new AbortController()
    setConnectDeviceCode(undefined)
    setConnectBrowserUrl(undefined)
    setConnectAwaitingBrowserInput(false)
    setPaletteQuery("")
    setPaletteMode("connect-authorizing")
    try {
      await loginOAuth({
        providerId: provider.id,
        persistence: "store",
        method,
        signal: connectAbortController.signal,
        onDeviceCode: ({ verificationUri, userCode }) => setConnectDeviceCode({ verificationUri, userCode }),
        onBrowserUrl: (url) => setConnectBrowserUrl(url),
        onBrowserPrompt: () => {
          setConnectAwaitingBrowserInput(true)
          return new Promise<string>((resolve) => { resolveBrowserPrompt = resolve })
        },
      })
      await finishConnect(provider)
    } catch (error) {
      if (connectAbortController?.signal.aborted) return
      failConnect(provider, error)
      setPaletteMode(provider.id === "codex" ? "connect-codex-method" : "connect-providers")
    } finally {
      connectAbortController = undefined
      resolveBrowserPrompt = undefined
      setConnectAwaitingBrowserInput(false)
    }
  }

  const chooseConnectProvider = async () => {
    const providerId = paletteResults()[paletteSelectedIndex()]?.action.type === "provider"
      ? paletteResults()[paletteSelectedIndex()]?.action.providerId
      : undefined
    const provider = connectProviders().find((item) => item.id === providerId)
    if (!provider) return
    setConnectProvider(provider)
    setConnectResult(undefined)
    if (provider.kind === "custom") {
      setConnectResult({
        kind: "info",
        message: provider.environmentVariable
          ? `Set ${provider.environmentVariable} to change this provider's API key`
          : "Configure api_key_env, then set that environment variable",
      })
      setPaletteMode("connect-result")
    } else if (provider.kind === "none") {
      setConnectResult({ kind: "success", message: `✓ ${provider.name} needs no authentication` })
      setPaletteMode("connect-result")
    } else if (provider.kind === "api-key") {
      setConnectApiKey("")
      setPaletteQuery("")
        setPaletteMode("connect-api-key")
    } else if (provider.id === "codex") {
      setPaletteSelectedIndex(0)
      setPaletteMode("connect-codex-method")
    } else {
      await authorizeProvider(provider, "device")
    }
  }

  const updatePaletteQuery = () => {
    if (!paletteInputRef) return
    const query = paletteInputRef.plainText
    if (paletteMode() === "connect-api-key") {
      setPaletteQuery(query)
      setConnectApiKey(query)
      return
    }
    if (paletteMode() === "connect-authorizing" && connectAwaitingBrowserInput()) {
      setPaletteQuery(query)
      return
    }
    if (paletteMode().startsWith("connect-") && paletteMode() !== "connect-providers") return
    if (paletteMode() === "sessions") {
      setPaletteQuery(query)
      if (paletteSessionAction() === "rename") return
      const result = searchSessionTree(paletteSessionInputs(), query)
      const rows = buildSessionTreeRows(result.sessions, state.store.sessionId)
      setPaletteSessionRows(rows)
      setPaletteSelectedIndex(firstSelectableSessionRow(rows, result.firstMatchId ?? state.store.sessionId))
      return
    }
    if (paletteMode() === "worktree-create") {
      setPaletteQuery(query)
      setWorktreeCreateError(undefined)
      return
    }
    if (paletteMode() === "worktrees") {
      const normalized = query.trim().toLowerCase()
      const rows = normalized
        ? paletteWorktreeInputs().filter((row) => row.label.toLowerCase().includes(normalized))
        : paletteWorktreeInputs()
      setPaletteQuery(query)
      setPaletteWorktreeRows(rows)
      setPaletteSelectedIndex(firstSelectableWorktreeRow(rows))
      return
    }
    const selectedKey = paletteResults()[paletteSelectedIndex()]?.key
    const entityType = paletteMode() === "skills" ? "skill" : paletteMode() === "models" ? "model" : paletteMode() === "connect-providers" ? "provider" : undefined
    const entries = entityType
      ? paletteEntries().filter((entry) => entry.type === entityType)
      : paletteEntries()
    const results = entityType && !query.trim()
      ? entityPaletteEntries(entityType)
      : searchPaletteEntries(entries, query)
    setPaletteQuery(query)
    setPaletteResults(results)
    setPaletteSelectedIndex(Math.max(0, preservePaletteSelectionIndex(selectedKey, results)))
  }

  // ---------------------------------------------------------------------------
  // Input change handler
  // ---------------------------------------------------------------------------

  const handleInputChange = () => {
    // Get the actual text from the textarea ref
    if (!inputRef) return
    const newValue = inputRef.plainText

    const s = slash()

    // Choice pickers: filter the list by what the user types
    if (s.mode === "profiles" && s.active) {
      const options = getChoiceOptions(s.mode)
      if (!options) return
      const query = newValue
      const pickerItems = buildPickerItems(options, getCurrentChoice(s.mode), query)
      setSlash((prev) => ({ ...prev, query, pickerItems, selectedIndex: 0 }))
      setInputValue(newValue)
      return
    }

    setInputValue(newValue)

    if (newValue === "/" && openPalette()) return

    // Explicit slash commands remain submittable, but command discovery belongs to the palette.
    if (newValue.startsWith("/")) {
      setSlash(SLASH_INACTIVE)
      setMention(MENTION_INACTIVE)
    } else {
      setSlash(SLASH_INACTIVE)
      updateMentionFromValue(newValue)
    }
  }

  // ---------------------------------------------------------------------------
  // Set input value imperatively (after tab-completing a mention/command)
  // ---------------------------------------------------------------------------

  const setInputText = (text: string) => {
    if (inputRef) {
      if (text === "") {
        inputRef.clear()
      } else {
        inputRef.setText(text)
        inputRef.gotoBufferEnd()
      }
    }
    setInputValue(text)
  }

  const openSessionsPalette = (
    preferredSessionId?: string,
    query = "",
  ): boolean => {
    if (!props.getSessions) return false
    if (state.store.question || state.store.asyncPanel || statisticsContent() !== null) return false
    if (!paletteOpen()) {
      savedComposer = {
        text: "",
        cursorOffset: 0,
        images: [...pendingImages()],
        selectedImageIndex: selectedImageIndex(),
        historyIndex: historyIndex(),
        historyDraft: historyDraft(),
        scrollTop: scroll?.scrollTop ?? 0,
      }
    }
    const sessions = props.getSessions()
    const sid = state.store.sessionId
    const result = searchSessionTree(sessions, query)
    const sessionRows = buildSessionTreeRows(result.sessions, sid)
    setSlash(SLASH_INACTIVE)
    setMention(MENTION_INACTIVE)
    setInputText("")
    setPaletteMode("sessions")
    setPaletteQuery(query)
    setPaletteEntries([])
    setPaletteResults([])
    setPaletteSessionInputs(sessions)
    setPaletteSessionRows(sessionRows)
    setPaletteSessionAction("browse")
    setSessionActionMenuOpen(false)
    setSessionActionQuery("")
    setSessionActionSelectedIndex(0)
    setPaletteSelectedIndex(firstSelectableSessionRow(
      sessionRows,
      preferredSessionId ?? result.firstMatchId ?? sid,
    ))
    setPaletteOpen(true)
    return true
  }

  const selectedSession = () => {
    const selected = paletteSessionRows()[paletteSelectedIndex()]
    if (selected?.type !== "session" && selected?.type !== "orphan") return undefined
    return paletteSessionInputs().find((session) => session.id === selected.id)
  }

  const sessionActions = () => {
    const session = selectedSession()
    if (!session) return []
    const query = sessionActionQuery().trim().toLowerCase()
    return [
      { id: "pin" as const, label: session.pinned ? "Unpin session" : "Pin session" },
      { id: "rename" as const, label: "Rename session" },
    ].filter((action) => !query || action.label.toLowerCase().includes(query))
  }

  const closeSessionActions = () => {
    setSessionActionMenuOpen(false)
    setSessionActionQuery("")
    setSessionActionSelectedIndex(0)
  }

  const openSessionActions = () => {
    if (paletteMode() !== "sessions" || paletteSessionAction() !== "browse" || !selectedSession()) return false
    setSessionActionQuery("")
    setSessionActionSelectedIndex(0)
    setSessionActionMenuOpen(true)
    return true
  }

  const updateSessionActionQuery = () => {
    const query = sessionActionInputRef?.plainText ?? ""
    setSessionActionQuery(query)
    setSessionActionSelectedIndex(0)
  }

  const runSessionAction = async () => {
    const session = selectedSession()
    const action = sessionActions()[sessionActionSelectedIndex()]
    if (!session || !action) return
    if (action.id === "rename") {
      closeSessionActions()
      setPaletteSessionAction("rename")
      setPaletteQuery(session.title ?? "")
      return
    }
    try {
      await props.onCommand?.(
        "pin-session",
        JSON.stringify({ id: session.id, pinned: !session.pinned }),
        state.store.sessionId,
      )
      openSessionsPalette(session.id)
    } catch (error) {
      notifyWarn("Session actions", error instanceof Error ? error.message : String(error), 4000)
    }
  }

  const openWorktreePicker = (): boolean => {
    if (!props.getWorktrees) return false
    if (state.store.question || state.store.asyncPanel || statisticsContent() !== null) return false
    if (!paletteOpen()) {
      savedComposer = {
        text: "",
        cursorOffset: 0,
        images: [...pendingImages()],
        selectedImageIndex: selectedImageIndex(),
        historyIndex: historyIndex(),
        historyDraft: historyDraft(),
        scrollTop: scroll?.scrollTop ?? 0,
      }
    }
    const worktrees = props.getWorktrees()
    const rows = buildWorktreeRows(
      worktrees.map((w) => ({
        id: w.id,
        path: w.path,
        branch: w.branch,
        shortHash: w.shortHash,
        isRoot: w.isRoot,
        isCurrent: w.isCurrent,
        prunable: w.prunable,
        missing: w.missing,
      })),
      state.store.activeWorktree?.id ?? "root",
      Object.fromEntries(worktrees.map((w) => [w.id, w.sessionCount])),
      Object.fromEntries(worktrees.map((w) => [w.id, w.timeUpdated])),
    )
    setSlash(SLASH_INACTIVE)
    setMention(MENTION_INACTIVE)
    setInputText("")
    paletteInputRef?.clear()
    setPaletteMode("worktrees")
    setPaletteQuery("")
    setPaletteEntries([])
    setPaletteResults([])
    const pickerRows: WorktreePickerRow[] = [{ type: "create", label: "+ Create worktree" }, ...rows]
    setPaletteWorktreeInputs(pickerRows)
    setPaletteWorktreeRows(pickerRows)
    setWorktreeCreateError(undefined)
    setPaletteSelectedIndex(firstSelectableWorktreeRow(pickerRows))
    setPaletteOpen(true)
    return true
  }

  const getChoiceOptions = (_mode: ChoicePickerMode) => props.getProfiles?.()

  const getCurrentChoice = (_mode: ChoicePickerMode) => props.getCurrentProfile?.() ?? ""

  const openChoicePicker = (mode: ChoicePickerMode): boolean => {
    const options = getChoiceOptions(mode)
    if (!options) return false
    setSlash({
      active: true,
      mode,
      query: "",
      items: [],
      pickerItems: buildPickerItems(options, getCurrentChoice(mode)),
      selectedIndex: 0,
    })
    setInputText("")
    return true
  }

  // ---------------------------------------------------------------------------
  // Execute a slash command
  // ---------------------------------------------------------------------------

  const executeCommand = (commandId: string, args: string) => {
    if (commandId === "help") {
      const helpLines = filterCommands("", 99)
        .map((cmd) => `  /${cmd.id}${cmd.usage ? " " + cmd.usage : ""} — ${cmd.description}`)
        .join("\n")
      const helpText = `Available commands:\n${helpLines}`
      const msgId = generateId()
      dispatch(state, { type: "add-user-message", id: msgId, text: helpText })
      return
    }

    if (commandId === "exit") {
      if (state.store.running && state.store.sessionId) {
        props.onCancel(state.store.sessionId)
      }
      exitApp()
      return
    }

    if (commandId === "connect" && !args && paletteOpen()) {
      void openConnectProviders()
      return
    }

    if (commandId === "sessions" && !args && openSessionsPalette()) {
      return
    }

    if (commandId === "worktree" && !args && openWorktreePicker()) {
      return
    }

    if (commandId === "statistics") {
      const stats = collectStatistics()
      const chart = renderStatisticsChart(stats)
      setStatisticsContent(chart)
      return
    }

    if (commandId === "async-msg") {
      clearQueuedMessages()
      dispatch(state, { type: "open-async-panel", sessionId: null, title: "msg" })
      return
    }

    // Delegate to backend handler
    if (props.onCommand) {
      Promise.resolve(props.onCommand(commandId, args, state.store.sessionId))
        .then((res) => {
          if (res?.handled && res.next === "sessions-palette") {
            openSessionsPalette()
          }
        })
    }
  }

  // ---------------------------------------------------------------------------
  // Handle dropdown navigation (arrow keys, tab, enter, escape)
  // Called from the global keyboard handler when a dropdown is active.
  // Returns true if the key was consumed.
  // ---------------------------------------------------------------------------

  const handleDropdownKey = (
    name: string,
    isTab: boolean,
    isReturn: boolean,
    isEscape: boolean,
  ): boolean => {
    const s = slash()
    if (s.active) {
      if (name === "up") {
        setSlash((prev) => ({
          ...prev,
          selectedIndex: Math.max(0, prev.selectedIndex - 1),
        }))
        return true
      }

      if (name === "down") {
        const totalItems = s.mode === "commands"
          ? s.items.length
          : s.pickerItems.length
        setSlash((prev) => {
          if (totalItems === 0) return prev
          return {
            ...prev,
            selectedIndex: Math.min(totalItems - 1, prev.selectedIndex + 1),
          }
        })
        return true
      }

      if (isTab || isReturn) {
        // --- Choice picker mode ---
        if (s.mode === "profiles") {
          const selected = s.pickerItems[s.selectedIndex]
          if (selected) {
            setSlash(SLASH_INACTIVE)
            setInputText("")
            props.onCommand?.("profile", selected.id, state.store.sessionId)
          }
          return true
        }

        // --- Command mode ---
        if (s.items.length > 0) {
          const selected = s.items[s.selectedIndex]
          if (selected) {
            // /model and /profile → transition to picker (Tab or Enter)
            const pickerMode = pickerModeForCommand(selected.id)
            if (pickerMode && (isReturn || isTab) && openChoicePicker(pickerMode)) {
              return true
            }

            // Tab → fill in command + space for arg typing
            // Enter → execute the command directly (no second Enter required)
            if (isTab) {
              const newValue = `/${selected.id} `
              setInputText(newValue)
              setSlash(SLASH_INACTIVE)
            } else {
              // isReturn: execute immediately
              setSlash(SLASH_INACTIVE)
              setInputText("")
              executeCommand(selected.id, "")
            }
          }
        }
        return true
      }

      if (isEscape) {
        setSlash(SLASH_INACTIVE)
        setInputText("")
        return true
      }

      return false
    }

    // --- @ mention dropdown ---
    const m = mention()
    if (!m.active) return false

    if (name === "up") {
      setMention((prev) => ({
        ...prev,
        selectedIndex: Math.max(0, prev.selectedIndex - 1),
      }))
      return true
    }

    if (name === "down") {
      setMention((prev) => {
        if (prev.items.length === 0) return prev
        return {
          ...prev,
          selectedIndex: Math.min(prev.items.length - 1, prev.selectedIndex + 1),
        }
      })
      return true
    }

    if (isTab || isReturn) {
      if (m.items.length > 0) {
        const selected = m.items[m.selectedIndex]
        if (selected) {
          const currentInput = inputValue()
          const before = currentInput.slice(0, m.atIndex)
          const newValue = `${before}@${selected} `
          setInputText(newValue)
          setMention(MENTION_INACTIVE)
        }
      }
      return true
    }

    if (isEscape) {
      setMention(MENTION_INACTIVE)
      return true
    }

    return false
  }

  // ---------------------------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------------------------

  const prepareSubmission = (text: string): QueuedUserMessage | undefined => {
    setMention(MENTION_INACTIVE)
    setSlash(SLASH_INACTIVE)
    // Reset history navigation on submit
    setHistoryIndex(-1)
    setHistoryDraft("")

    // Intercept slash commands: /command args
    if (text.startsWith("/")) {
      const spaceIndex = text.indexOf(" ")
      const commandId = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
      const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim()

      if (commandId) {
        executeCommand(commandId, args)
        setInputText("")
        return undefined
      }
    }

    // Extract @file and @directory mentions — reference paths only, no content
    const mentionedPaths = extractMentions(text)

    let context = ""
    for (const mentionPath of mentionedPaths) {
      try {
        const absPath = path.resolve(process.cwd(), mentionPath)
        const stat = fs.statSync(absPath)
        if (stat.isDirectory()) {
          // Directory mentions only reference the path — no content loaded
          context += `\n<directory path="${mentionPath}" />\n`
        } else {
          // File mentions only reference the path — no content loaded
          context += `\n<file path="${mentionPath}" />\n`
        }
      } catch {
        // Path not readable — skip silently
      }
    }

    const imgs = pendingImages()

    setInputText("")
    setPendingImages([])

    // Auto-scroll to bottom
    scroll?.scrollBy({ x: 0, y: Infinity })

    return {
      id: generateId(),
      text,
      images: imgs.length > 0 ? [...imgs] : undefined,
      context: context || undefined,
    }
  }

  const sendSubmission = (message: QueuedUserMessage) => {
    props.onSubmit(
      message.text,
      state.store.sessionId,
      message.images?.map((image) => ({ mime: image.mime, data: image.data })),
      message.context,
    )
  }

  const handleSubmit = (text: string) => {
    const message = prepareSubmission(text)
    if (!message) return
    if (state.store.running) {
      setQueuedMessages((messages) => [...messages, message])
    } else {
      sendSubmission(message)
    }
  }

  let dequeuePending = false
  const [dequeueTick, setDequeueTick] = createSignal(0)
  createEffect(() => {
    dequeueTick()
    if (
      dequeuePending
      || state.store.running
      || state.store.question
      || state.store.asyncPanel
      || queuedMessages().length === 0
    ) return

    dequeuePending = true
    queueMicrotask(() => {
      let next: QueuedUserMessage | undefined
      if (!state.store.running && !state.store.question && !state.store.asyncPanel) {
        setQueuedMessages((messages) => {
          next = messages[0]
          if (next?.id === selectedQueuedMessageId()) setSelectedQueuedMessageId(null)
          return next ? messages.slice(1) : messages
        })
        if (next) sendSubmission(next)
      }
      queueMicrotask(() => {
        dequeuePending = false
        setDequeueTick((tick) => tick + 1)
      })
    })
  })

  const selectQueuedMessage = (direction: 1 | -1) => {
    const messages = queuedMessages()
    if (messages.length === 0) return
    const selectedIndex = messages.findIndex((message) => message.id === selectedQueuedMessageId())
    const nextIndex = selectedIndex === -1
      ? (direction === 1 ? 0 : messages.length - 1)
      : (selectedIndex + direction + messages.length) % messages.length
    setSelectedQueuedMessageId(messages[nextIndex].id)
  }

  const removeSelectedQueuedMessage = () => {
    const selectedId = selectedQueuedMessageId()
    if (!selectedId) return
    setQueuedMessages((messages) => {
      const selectedIndex = messages.findIndex((message) => message.id === selectedId)
      if (selectedIndex === -1) return messages
      const next = messages.filter((message) => message.id !== selectedId)
      setSelectedQueuedMessageId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null)
      return next
    })
  }

  const sendSelectedQueuedMessageNow = () => {
    const selectedId = selectedQueuedMessageId()
    if (!selectedId || !state.store.running || !state.store.sessionId) return
    setQueuedMessages((messages) => {
      const selectedIndex = messages.findIndex((message) => message.id === selectedId)
      if (selectedIndex <= 0) return messages
      const selected = messages[selectedIndex]
      return [selected, ...messages.slice(0, selectedIndex), ...messages.slice(selectedIndex + 1)]
    })
    setSelectedQueuedMessageId(null)
    // Keep the normal loop-end dispatcher as the serialization boundary.
    props.onCancel(state.store.sessionId)
  }

  // ---------------------------------------------------------------------------
  // Compute autocomplete mode for the Autocomplete component
  // ---------------------------------------------------------------------------

  const autocompleteMode = (): AutocompleteMode | null => {
    const s = slash()
    if (s.active) {
      if (s.mode === "profiles") {
        return { type: s.mode, items: s.pickerItems, selectedIndex: s.selectedIndex }
      }
      return { type: "commands", items: s.items, selectedIndex: s.selectedIndex, query: s.query }
    }

    const m = mention()
    if (m.active) {
      return { type: "files", items: m.items, selectedIndex: m.selectedIndex, query: m.query }
    }

    return null
  }

  const runPaletteSelection = async () => {
    if (paletteMode() === "connect-providers") {
      await chooseConnectProvider()
      return
    }
    if (paletteMode() === "connect-api-key") {
      const provider = connectProvider()
      if (!provider) return
      const apiKey = connectApiKey()
      if (!apiKey.trim()) {
        failConnect(provider, new Error("empty"))
        return
      }
      try {
        await loginApiKey({ providerId: provider.id, apiKey, persistence: "store" })
        setConnectApiKey("")
        setPaletteQuery("")
            await finishConnect(provider)
      } catch (error) {
        failConnect(provider, error)
      }
      return
    }
    if (paletteMode() === "connect-codex-method") {
      const provider = connectProvider()
      if (provider) await authorizeProvider(provider, paletteSelectedIndex() === 0 ? "browser" : "device")
      return
    }
    if (paletteMode() === "connect-authorizing") {
      if (connectAwaitingBrowserInput() && resolveBrowserPrompt) {
        const resolve = resolveBrowserPrompt
        resolveBrowserPrompt = undefined
        setConnectAwaitingBrowserInput(false)
        resolve(paletteQuery())
        setPaletteQuery("")
          }
      return
    }
    if (paletteMode() === "connect-result") {
      restoreComposer()
      return
    }
    if (paletteMode() === "worktree-create") {
      const branch = paletteQuery().trim()
      if (!branch) {
        setWorktreeCreateError("Branch name is required")
        return
      }
      try {
        const result = await props.onCommand?.("worktree", `create ${branch}`, state.store.sessionId)
        if (result?.handled && result.next === "conversation") {
          restoreComposer("")
        } else {
          setWorktreeCreateError(result?.handled ? result.error ?? "Could not create worktree" : "Could not create worktree")
        }
      } catch (error) {
        setWorktreeCreateError(error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (paletteMode() === "sessions") {
      const selected = paletteSessionRows()[paletteSelectedIndex()]
      if (selected?.type !== "session" && selected?.type !== "orphan") return
      try {
        if (paletteSessionAction() === "rename") {
          const title = paletteQuery().trim()
          if (!title) return
          await props.onCommand?.(
            "rename-session",
            JSON.stringify({ id: selected.id, title }),
            state.store.sessionId,
          )
          openSessionsPalette(selected.id)
          return
        }
        clearQueuedMessages()
        await props.onCommand?.("sessions", selected.id, state.store.sessionId)
        restoreComposer()
      } catch (error) {
        notifyWarn("Command palette", error instanceof Error ? error.message : String(error), 4000)
      }
      return
    }
    if (paletteMode() === "worktrees") {
      const selected = paletteWorktreeRows()[paletteSelectedIndex()]
      if (selected?.type === "create") {
        paletteInputRef?.clear()
        setPaletteQuery("")
        setWorktreeCreateError(undefined)
        setPaletteMode("worktree-create")
        return
      }
      if (selected?.type !== "worktree") return
      try {
        clearQueuedMessages()
        const result = await props.onCommand?.("worktree", selected.id, state.store.sessionId)
        if (result?.handled && result.next === "sessions-palette") {
          openSessionsPalette()
        } else {
          restoreComposer()
        }
      } catch (error) {
        notifyWarn("Command palette", error instanceof Error ? error.message : String(error), 4000)
      }
      return
    }

    const entry = paletteResults()[paletteSelectedIndex()]
    if (!entry) return
    if (entry.isUnavailable) {
      notifyInfo("Command palette", `${entry.label} is unavailable`, 2500)
      return
    }

    const action = entry.action
    try {
      if (action.type === "tool") {
        notifyInfo("Command palette", "Tool mentions are not supported yet", 2500)
        return
      }
      if (action.type === "model") {
        await props.onCommand?.("model", action.modelId, state.store.sessionId)
        restoreComposer()
        return
      }
      if (action.type === "skill") {
        await props.onCommand?.("skills", action.skillId, state.store.sessionId)
        restoreComposer()
        return
      }
      const command = filterCommands("", 99).find((item) => item.id === action.commandId)
      if (action.commandId === "connect") {
        savePaletteSearch()
        await openConnectProviders()
        return
      }
      if (action.commandId === "skills") {
        savePaletteSearch()
        openEntityPalette("skills", "skill")
        return
      }
      if (action.commandId === "model") {
        savePaletteSearch()
        openEntityPalette("models", "model")
        return
      }
      if (action.commandId === "sessions") {
        savePaletteSearch()
        if (!openSessionsPalette()) paletteSearchSnapshot = null
        return
      }
      if (action.commandId === "worktree") {
        savePaletteSearch()
        if (!openWorktreePicker()) paletteSearchSnapshot = null
        return
      }
      const pickerMode = pickerModeForCommand(action.commandId)
      if (pickerMode) {
        restoreComposer()
        openChoicePicker(pickerMode)
        return
      }
      const requiresArgs = command?.usage?.includes("<") || action.commandId === "compact" || action.commandId === "steer"
      if (requiresArgs) {
        restoreComposer(`/${action.commandId} `)
        return
      }
      restoreComposer()
      executeCommand(action.commandId, action.args ?? "")
    } catch (error) {
      notifyWarn("Command palette", error instanceof Error ? error.message : String(error), 4000)
    }
  }

  // ---------------------------------------------------------------------------
  // Global keyboard handler
  // ---------------------------------------------------------------------------

  useKeyboard((evt) => {
    // Global palette chord (Cmd+/ on macOS, Ctrl+/ elsewhere). Handled before
    // the palette block so it also acts as a no-op when the palette is already
    // open, and never lets a slash leak into the composer or a question panel.
    // Two shapes are accepted:
    //   1. Kitty/enhanced protocol: name === "/" with ctrl/super/meta set.
    //   2. Legacy terminals: Ctrl+/ arrives as the bare 0x1f control byte
    //      (name/sequence === "\x1f", all modifiers false — indistinguishable
    //      from Ctrl+_). We only treat this as the chord when no modifiers are
    //      set, matching parseKeypress's legacy decode.
    const isPaletteChord =
      !evt.option
      && (
        (evt.ctrl || evt.super || evt.meta) && evt.name === "/"
        || !evt.ctrl && !evt.super && !evt.meta && evt.name === "\x1f"
      )
    if (isPaletteChord) {
      if (!paletteOpen() && inputRef) {
        openPalette({ text: inputRef.plainText, cursorOffset: inputRef.cursorOffset })
      }
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    if (paletteOpen()) {
      const isSessionActionChord = (evt.ctrl || evt.super || evt.meta) && evt.name === "k"
      if (sessionActionMenuOpen()) {
        if (evt.name === "up") {
          setSessionActionSelectedIndex((index) => Math.max(0, index - 1))
        } else if (evt.name === "down") {
          setSessionActionSelectedIndex((index) => Math.min(Math.max(0, sessionActions().length - 1), index + 1))
        } else if (evt.name === "return") {
          queueMicrotask(() => { void runSessionAction() })
        } else if (evt.name === "escape") {
          closeSessionActions()
        } else {
          return
        }
      } else if (isSessionActionChord && openSessionActions()) {
        // The nested action menu owns the next input and keeps the session search intact.
      } else if (evt.name === "up") {
        setPaletteSelectedIndex((index) => paletteMode() === "sessions"
          ? moveSessionRowSelection(paletteSessionRows(), index, -1)
          : paletteMode() === "worktrees"
            ? moveWorktreeRowSelection(paletteWorktreeRows(), index, -1)
          : Math.max(0, index - 1))
      } else if (evt.name === "down") {
        const maximum = paletteMode() === "connect-codex-method" ? 1 : paletteResults().length - 1
        setPaletteSelectedIndex((index) => paletteMode() === "sessions"
          ? moveSessionRowSelection(paletteSessionRows(), index, 1)
          : paletteMode() === "worktrees"
            ? moveWorktreeRowSelection(paletteWorktreeRows(), index, 1)
          : Math.min(Math.max(0, maximum), index + 1))
      } else if (evt.name === "return") {
        queueMicrotask(() => { void runPaletteSelection() })
      } else if (evt.name === "escape") {
        if (paletteMode() === "connect-authorizing") {
          connectAbortController?.abort()
          resolveBrowserPrompt?.("")
          resolveBrowserPrompt = undefined
          void openConnectProviders()
        } else if (paletteMode() === "connect-api-key" || paletteMode() === "connect-codex-method") {
          setConnectApiKey("")
          setPaletteQuery("")
                void openConnectProviders()
        } else if (paletteMode() === "connect-result") {
          restoreComposer()
        } else if (paletteMode() === "sessions" && paletteSessionAction() === "rename") {
          const selected = paletteSessionRows()[paletteSelectedIndex()]
          openSessionsPalette(selected?.type === "session" || selected?.type === "orphan" ? selected.id : undefined)
        } else if (paletteMode() === "worktree-create") {
          openWorktreePicker()
        } else if (!restorePaletteSearch()) {
          paletteGeneration++
          restoreComposer()
        }
      } else if (evt.name === "tab" || evt.name === "pageup" || evt.name === "pagedown" || evt.name === "home" || evt.name === "end") {
        // Unsupported in v1; consume so underlying global actions cannot run.
      } else {
        return
      }
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    // Arrow keys enter and navigate the queue. Delete removes the selection;
    // Enter interrupts and sends it after the authoritative loop-end.
    if (
      queuedMessages().length > 0
      && state.store.running
      && !state.store.question
      && !state.store.asyncPanel
      && !dropdownActive()
    ) {
      const selectedId = selectedQueuedMessageId()
      if (evt.name === "up") {
        selectQueuedMessage(1)
        evt.preventDefault()
        return
      }
      if (evt.name === "down") {
        if (selectedId) selectQueuedMessage(-1)
        else selectQueuedMessage(1)
        evt.preventDefault()
        return
      }
      if (selectedId) {
        if (evt.name === "backspace" || evt.name === "delete") {
          removeSelectedQueuedMessage()
          evt.preventDefault()
          return
        }
        if (evt.name === "return") {
          sendSelectedQueuedMessageNow()
          evt.preventDefault()
          return
        }
        if (evt.name === "escape") {
          setSelectedQueuedMessageId(null)
          evt.preventDefault()
          return
        }
      }
    }
    // Ctrl+Z / Cmd+Z — undo and move cursor to end
    if ((evt.ctrl || evt.meta || evt.super) && evt.name === "z" && !evt.shift) {
      if (inputRef && !state.store.running) {
        inputRef.undo()
        inputRef.gotoBufferEnd()
        evt.preventDefault()
      }
      return
    }

    // Ctrl+Shift+Z / Cmd+Shift+Z — redo and move cursor to end
    if ((evt.ctrl || evt.meta || evt.super) && (evt.name === "z" || evt.name === "Z") && evt.shift) {
      if (inputRef && !state.store.running) {
        inputRef.redo()
        inputRef.gotoBufferEnd()
        evt.preventDefault()
      }
      return
    }

    // Ctrl+V — check clipboard for image before terminal handles paste
    if (evt.ctrl && evt.name === "v") {
      readClipboard().then((content) => {
        if (!content) return
        setPendingImages((prev) => {
          const label = `Image ${prev.length + 1}`
          return [...prev, { mime: content.mime, data: content.data, label }]
        })
        evt.preventDefault()
      })
      return
    }

    // Image chip navigation — only when there are pending images and no dropdown/agent
    if (pendingImages().length > 0 && !dropdownActive() && !state.store.running) {
      const images = pendingImages()
      const current = selectedImageIndex()

      // Tab cycles through chips: null → 0 → 1 → … → n-1 → null
      if (evt.name === "tab") {
        if (current === null) {
          setSelectedImageIndex(0)
        } else if (current < images.length - 1) {
          setSelectedImageIndex(current + 1)
        } else {
          setSelectedImageIndex(null)
        }
        evt.preventDefault()
        return
      }

      // Backspace or Delete removes the selected chip
      if ((evt.name === "backspace" || evt.name === "delete") && current !== null) {
        removeImage(current)
        evt.preventDefault()
        return
      }

      // Escape clears selection (takes priority over agent-cancel when a chip is selected)
      if (evt.name === "escape" && current !== null) {
        setSelectedImageIndex(null)
        evt.preventDefault()
        return
      }
    }

    // Tab model cycling — when no images, no dropdown, not running
    if (evt.name === "tab" && !evt.shift && !dropdownActive() && !state.store.running && pendingImages().length === 0) {
      if (props.getModels && props.getCurrentModel) {
        const models = props.getModels()
        const next = getNextModel(models, props.getCurrentModel())
        if (next) {
          if (props.onCommand) {
            props.onCommand("model", next, state.store.sessionId)
          }
          bus.emit("model-switched", { modelSpec: next, thinkingEffort: "none" })
        }
      }
      evt.preventDefault()
      return
    }

    // Shift+Tab model cycling (reverse) — when no images, no dropdown, not running
    if (evt.name === "tab" && evt.shift && !dropdownActive() && !state.store.running && pendingImages().length === 0) {
      if (props.getModels && props.getCurrentModel) {
        const models = props.getModels()
        const prev = getPrevModel(models, props.getCurrentModel())
        if (prev) {
          if (props.onCommand) {
            props.onCommand("model", prev, state.store.sessionId)
          }
          bus.emit("model-switched", { modelSpec: prev, thinkingEffort: "none" })
        }
      }
      evt.preventDefault()
      return
    }

    // Question mode: custom text entry is handled by its focused textarea.
    if (state.store.question) {
      if (questionHandler.customMode()) {
        if (evt.name === "return") {
          questionHandler.submitCustom(customQuestionRef?.plainText)
          evt.preventDefault()
          return
        }
        if (evt.name === "escape") {
          questionHandler.handleKey(evt.name)
          evt.preventDefault()
          return
        }
        return
      }

      const consumed = questionHandler.handleKey(evt.name)
      if (consumed) {
        evt.preventDefault()
        return
      }
    }

    // Dropdown navigation — intercept arrow/tab/enter/escape BEFORE input processes them
    if (dropdownActive()) {
      const consumed = handleDropdownKey(
        evt.name,
        evt.name === "tab",
        evt.name === "return",
        evt.name === "escape",
      )
      if (consumed) {
        evt.preventDefault()
        return
      }
    }

    // Arrow key scrolling (only when no dropdown is active)
    if (evt.name === "up") {
      // History navigation: intercept ↑ when not running, cursor is on line 1
      if (!state.store.running && !dropdownActive() && inputRef) {
        const text = inputRef.plainText
        const offset = inputRef.cursorOffset
        const cursorLine = text.slice(0, offset).split("\n").length - 1
        if (cursorLine === 0) {
          const history = userHistory()
          if (history.length > 0) {
            const next = historyIndex() + 1
            if (next < history.length) {
              if (historyIndex() === -1) setHistoryDraft(text)
              setHistoryIndex(next)
              setInputText(history[next])
            }
            evt.preventDefault()
            return
          }
        }
      }
      // When the prompt is focused, let the textarea handle ↑ cursor movement.
      if (inputRef?.focused) return
      scroll?.scrollBy(-SCROLL_STEP)
      evt.preventDefault()
      return
    }
    if (evt.name === "down") {
      // History navigation: intercept ↓ when navigating history and cursor is on last line
      if (!state.store.running && !dropdownActive() && historyIndex() >= 0 && inputRef) {
        const text = inputRef.plainText
        const offset = inputRef.cursorOffset
        const lines = text.split("\n")
        const cursorLine = text.slice(0, offset).split("\n").length - 1
        if (cursorLine === lines.length - 1) {
          const prev = historyIndex() - 1
          if (prev < 0) {
            setHistoryIndex(-1)
            setInputText(historyDraft())
          } else {
            setHistoryIndex(prev)
            setInputText(userHistory()[prev])
          }
          evt.preventDefault()
          return
        }
      }
      // When the prompt is focused, let the textarea handle ↓ cursor movement.
      if (inputRef?.focused) return
      scroll?.scrollBy(SCROLL_STEP)
      evt.preventDefault()
      return
    }

    // Esc closes statistics panel (highest priority)
    if (evt.name === "escape" && statisticsContent() !== null) {
      setStatisticsContent(null)
      evt.preventDefault()
      return
    }

    // Esc closes async panel (takes priority over selection / agent cancel)
    if (evt.name === "escape" && state.store.asyncPanel) {
      const sideId = asyncSessionId()
      dispatch(state, { type: "close-async-panel" })
      if (sideId) props.onCancel(sideId)
      setAsyncSessionId(null)
      evt.preventDefault()
      return
    }

    // When async panel is open, let all other keys pass through to the panel's
    // focused textarea. Only Escape (above) is handled globally.
    if (state.store.asyncPanel) {
      return
    }

    // Esc clears any active selection (takes priority over agent cancel)
    if (evt.name === "escape" && renderer.getSelection()) {
      renderer.clearSelection()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    // Esc cancels running agent (only when no dropdown)
    if (evt.name === "escape" && state.store.running && state.store.sessionId) {
      props.onCancel(state.store.sessionId)
      return
    }

    // Ctrl+T — cycle thinking effort (none → low → medium → high → xhigh → none)
    if (evt.ctrl && evt.name === "t") {
      // Ctrl+Shift+T — toggle show thinking text
      if (evt.shift) {
        dispatch(state, { type: "toggle-show-thinking" })
        evt.preventDefault()
        return
      }
      dispatch(state, { type: "cycle-thinking", modelId: state.store.status.modelName })
      props.onThinkingEffortChange?.(state.store.thinkingEffort)
      evt.preventDefault()
      return
    }

    // Ctrl+C — cancel agent or exit
    if (evt.ctrl && evt.name === "c") {
      if (renderer.getSelection()) {
        renderer.clearSelection()
        return
      }
      if (state.store.running && state.store.sessionId) {
        props.onCancel(state.store.sessionId)
      } else {
        exitApp()
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <box flexDirection="column" width={dims().width} height={dims().height}
      onMouseUp={() => copySelection()}
    >
      {/* Message area — native scrollbox */}
      <scrollbox
        ref={(r: ScrollBoxRenderable) => { scroll = r }}
        stickyScroll={true}
        stickyStart="bottom"
        flexGrow={1}
        flexBasis={0}
        minHeight={0}
        overflow="hidden"
        scrollAcceleration={new MacOSScrollAccel()}
        scrollbarOptions={{ visible: false }}
        opacity={paletteOpen() ? 0.35 : 1}
      >
        <box flexGrow={1} minHeight={0} />
        <Index each={activityMessages()}>
          {(msg, i) => {
            const dividers = state.store.steerDividers.filter((d) => d.insertionIndex === i)
            return (
              <>
                {dividers.map((d) => (
                  <>
                    <SteerDivider goal={d.goal} label={d.label} width={dims().width} />
                    <text> </text>
                  </>
                ))}
                <Show when={msg()}>
                  {(message) => (
                    <MessageItem
                      message={message()}
                      showThinking={state.store.showThinking}
                      continuingToolCallId={continuingToolCallId()}
                      onOpenFile={props.onOpenFile}
                    />
                  )}
                </Show>
              </>
            )
          }}
        </Index>
        <For each={state.store.steerDividers.filter((d) => d.insertionIndex === state.store.messages.length)}>
          {(divider) => (
            <SteerDivider goal={divider.goal} label={divider.label} width={dims().width} />
          )}
        </For>
      </scrollbox>

      {/* Question prompt */}
      <Show when={state.store.question}>
        {(q) => (
          <QuestionPrompt
            request={q()}
            tab={questionHandler.tab}
            selected={questionHandler.selected}
            answers={questionHandler.answers}
            customMode={questionHandler.customMode}
            customText={questionHandler.customText}
            setCustomText={questionHandler.setCustomText}
            submitCustom={questionHandler.submitCustom}
            onCustomRef={(ref: TextareaRenderable) => { customQuestionRef = ref }}
          />
        )}
      </Show>

      {/* Autocomplete stays in flow immediately above the full composer. */}
      <Autocomplete mode={autocompleteMode()} />

      {/* Input area */}
      <Prompt
        onSubmit={handleSubmit}
        onContentChange={handleInputChange}
        onRef={(r: TextareaRenderable) => { inputRef = r }}
        disabled={!!state.store.question}
        focused={!paletteOpen()}
        opacity={paletteOpen() ? 0.35 : 1}
        placeholder=""
        tokensUsed={state.store.status.tokensUsed}
        tokenLimit={state.store.status.tokenLimit}
        cost={state.store.status.cost}
        modelName={state.store.status.modelName}
        skillCount={state.store.status.skillCount}
        images={pendingImages()}
        selectedImageIndex={selectedImageIndex()}
        onRemoveImage={removeImage}
        thinkingEffort={state.store.thinkingEffort}
        width={dims().width}
        queuedMessages={queuedMessages()}
        selectedQueuedMessageId={selectedQueuedMessageId()}
      />

      <CommandPalette
        active={paletteOpen()}
        mode={paletteMode()}
        query={paletteQuery()}
        entries={paletteResults()}
        sessionRows={paletteSessionRows()}
        sessionAction={paletteSessionAction()}
        sessionActionMenu={sessionActionMenuOpen() ? {
          query: sessionActionQuery(),
          actions: sessionActions(),
          selectedIndex: sessionActionSelectedIndex(),
          onInput: updateSessionActionQuery,
          onRef: (ref) => { sessionActionInputRef = ref },
        } : undefined}
        worktreeRows={paletteWorktreeRows()}
        worktreeError={worktreeCreateError()}
        selectedIndex={paletteSelectedIndex()}
        onInput={updatePaletteQuery}
        onRef={(ref) => { paletteInputRef = ref }}
        connect={{
          providers: connectProviders(),
          providerName: connectProvider()?.name,
          environmentCredentialActive: connectProvider()?.credentialOrigin === "environment",
          apiKeyLength: connectApiKey().length,
          deviceCode: connectDeviceCode(),
          browserUrl: connectBrowserUrl(),
          awaitingBrowserInput: connectAwaitingBrowserInput(),
          result: connectResult(),
        }}
      />

      {/* Statistics overlay */}
      <Show when={statisticsContent()}>
        {(content) => (
          <StatisticsPanel content={content()} onClose={() => setStatisticsContent(null)} />
        )}
      </Show>

      {/* Async panel overlay */}
      <Show when={state.store.asyncPanel}>
        {(panel) => (
          <AsyncPanel
            panel={panel()}
            onClose={() => {
              const sideId = asyncSessionId()
              dispatch(state, { type: "close-async-panel" })
              if (sideId) props.onCancel(sideId)
              setAsyncSessionId(null)
            }}
            onToggleCollapse={() => dispatch(state, { type: "toggle-async-collapse" })}
            onSubmit={(text: string) => {
              if (!text.trim()) return
              let sid = asyncSessionId()
              if (!sid) {
                sid = props.onCreateAsyncSession!()
                setAsyncSessionId(sid)
                dispatch(state, { type: "set-async-session-id", sessionId: sid })
              }
              props.onSubmit(text, sid)
            }}
          />
        )}
      </Show>

      {/* Notifications overlay */}
      <Notifications />

      {/* Footer bar */}
      <FooterBar running={state.store.running} steering={state.store.steering} lastDuration={state.store.lastDuration} cwd={state.store.cwd} branch={state.store.activeBranch} />
    </box>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract @file_path mentions from text */
function extractMentions(text: string): string[] {
  const regex = /@([\w.\/\-]+\/?)/g
  const mentions: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) mentions.push(match[1])
  }
  return mentions
}
