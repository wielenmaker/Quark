// @jsxImportSource @opentui/solid
// App — root TUI component (OpenTUI/SolidJS)
//
// Fullscreen layout: the app fills the entire terminal.
// Messages render in a native <scrollbox> with smooth scrolling.
// Input/autocomplete/footer are pinned at the bottom.

import type { Component } from "solid-js"
import { For, createSignal, createEffect, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid"
import { MacOSScrollAccel } from "@opentui/core"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { createAppState, dispatch, type AppState } from "../state"
import { wireEvents } from "../events"
import { bus } from "../../session/events"
import { ready as modelsReady, getModelLimit } from "../../provider/models"
import { loadConfig } from "../../config/config"
import { MessageItem } from "./message-item"
import { Prompt } from "./prompt"
import { Autocomplete, type PickerItem, type AutocompleteMode } from "./autocomplete"
import { PermissionPrompt } from "./permission-prompt"
import { QuestionPrompt, createQuestionKeyHandler } from "./question-prompt"
import { FooterBar } from "./footer-bar"
import { Notifications } from "./notifications"
import { colors } from "../theme"
import { respond as respondPermission } from "../../permission/permission"
import { respondQuestion } from "../../tool/question"
import { getFiles, fuzzyFilter } from "../../shared/filelist"
import { filterCommands, type SlashCommand } from "../commands"
import {
  buildSessionTreeRows,
  firstSelectableSessionRow,
  moveSessionRowSelection,
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
import { info as notifyInfo, warn as notifyWarn } from "../../notification/notification"
import { getNextModel, getPrevModel } from "../model-cycle"
import { getThinkingNormalizer } from "../../provider/thinking"
import { buildPickerItems, pickerModeForCommand, type ChoicePickerMode } from "../picker-items"

/** Command handler result */
export type CommandResult =
  | { handled: true; next?: "sessions-picker" }
  | { handled: false }

interface AppProps {
  onSubmit: (text: string, sessionId: string | null, images?: { mime: string; data: string }[], context?: string) => void
  onCancel: (sessionId: string) => void
  onCommand?: (command: string, args: string, sessionId: string | null) => Promise<CommandResult> | CommandResult | void
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
  }[]
  getModels?: () => { id: string; name: string }[]
  getCurrentModel?: () => string
  getProfiles?: () => { id: string; name: string }[]
  getCurrentProfile?: () => string
  getSkills?: () => { id: string; name: string }[]
  getCurrentSkill?: () => string
  getTools?: () => { id: string; name: string }[]
  getCurrentTool?: () => string
  initialSessionId?: string
  initialModelName?: string
  initialSkillCount?: number
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
  mode: "commands" | "sessions" | "worktrees" | ChoicePickerMode
  query: string
  items: SlashCommand[]
  pickerItems: PickerItem[]
  sessionRows: SessionTreeRow[]
  worktreeRows: WorktreePickerRow[]
  selectedIndex: number
}

const SLASH_INACTIVE: SlashState = {
  active: false,
  mode: "commands",
  query: "",
  items: [],
  pickerItems: [],
  sessionRows: [],
  worktreeRows: [],
  selectedIndex: 0,
}

const MAX_FILE_ITEMS = 50
const MAX_DROPDOWN_ITEMS = 15
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
    modelName: props.initialModelName ?? "smart",
    skillCount: props.initialSkillCount ?? 0,
  })

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
    const lim = getModelLimit(loadConfig().main_model)
    const limit = lim?.context ?? lim?.input
    if (limit) state.setStore("status", "tokenLimit", limit)
  })

  // --- Refs ---
  let scroll: ScrollBoxRenderable | undefined
  let inputRef: TextareaRenderable | undefined

  // --- Local UI signals (not in the global store — ephemeral) ---
  const [mention, setMention] = createSignal<MentionState>(MENTION_INACTIVE)
  const [slash, setSlash] = createSignal<SlashState>(SLASH_INACTIVE)
  // Mirror of input value (kept in sync with inputRef via onInput)
  const [inputValue, setInputValue] = createSignal("")
  // Statistics panel visibility and content
  const [statisticsContent, setStatisticsContent] = createSignal<string | null>(null)

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
  const dropdownActive = () => mention().active || slash().active || statisticsContent() !== null

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

  const updateSlashFromValue = (newValue: string) => {
    if (!newValue.startsWith("/")) {
      setSlash(SLASH_INACTIVE)
      return
    }

    const spaceIndex = newValue.indexOf(" ")

    // If there's a space, the command part is done — dismiss dropdown
    if (spaceIndex !== -1) {
      setSlash(SLASH_INACTIVE)
      return
    }

    const query = newValue.slice(1)
    const filtered = filterCommands(query, MAX_DROPDOWN_ITEMS)

    setSlash({
      active: true,
      mode: "commands",
      query,
      items: filtered,
      pickerItems: [],
      sessionRows: [],
      worktreeRows: [],
      selectedIndex: 0,
    })
  }

  // ---------------------------------------------------------------------------
  // Input change handler
  // ---------------------------------------------------------------------------

  const handleInputChange = () => {
    // Get the actual text from the textarea ref
    if (!inputRef) return
    const newValue = inputRef.plainText

    const s = slash()

    // Sessions / worktree pickers: block all input changes (no filtering)
    if ((s.mode === "sessions" || s.mode === "worktrees") && s.active) {
      return
    }

    // Choice pickers: filter the list by what the user types
    if ((s.mode === "models" || s.mode === "profiles" || s.mode === "skills" || s.mode === "tools") && s.active) {
      const options = getChoiceOptions(s.mode)
      if (!options) return
      const query = newValue
      const pickerItems = buildPickerItems(options, getCurrentChoice(s.mode), query)
      setSlash((prev) => ({ ...prev, query, pickerItems, selectedIndex: 0 }))
      setInputValue(newValue)
      return
    }

    setInputValue(newValue)

    // Slash and mention are mutually exclusive — slash takes precedence
    if (newValue.startsWith("/")) {
      updateSlashFromValue(newValue)
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

  const openSessionsPicker = (): boolean => {
    if (!props.getSessions) return false
    const sessions = props.getSessions()
    const sid = state.store.sessionId
    const sessionRows = buildSessionTreeRows(sessions, sid)
    setSlash({
      active: true,
      mode: "sessions",
      query: "",
      items: [],
      pickerItems: [],
      sessionRows,
      worktreeRows: [],
      selectedIndex: firstSelectableSessionRow(sessionRows, sid),
    })
    setInputText("")
    return true
  }

  const openWorktreePicker = (): boolean => {
    if (!props.getWorktrees) return false
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
    )
    setSlash({
      active: true,
      mode: "worktrees",
      query: "",
      items: [],
      pickerItems: [],
      sessionRows: [],
      worktreeRows: rows,
      selectedIndex: firstSelectableWorktreeRow(rows),
    })
    setInputText("")
    return true
  }

  const getChoiceOptions = (mode: ChoicePickerMode) =>
    mode === "models" ? props.getModels?.() : mode === "profiles" ? props.getProfiles?.() : mode === "tools" ? props.getTools?.() : props.getSkills?.()

  const getCurrentChoice = (mode: ChoicePickerMode) =>
    mode === "models" ? props.getCurrentModel?.() ?? "" : mode === "profiles" ? props.getCurrentProfile?.() ?? "" : mode === "tools" ? props.getCurrentTool?.() ?? "" : props.getCurrentSkill?.() ?? ""

  const openChoicePicker = (mode: ChoicePickerMode): boolean => {
    const options = getChoiceOptions(mode)
    if (!options) return false
    setSlash({
      active: true,
      mode,
      query: "",
      items: [],
      pickerItems: buildPickerItems(options, getCurrentChoice(mode)),
      sessionRows: [],
      worktreeRows: [],
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

    if (commandId === "sessions" && !args && openSessionsPicker()) {
      return
    }

    if (commandId === "worktree" && !args && openWorktreePicker()) {
      return
    }

    if (commandId === "tool" && args.trim() === "list" && openChoicePicker("tools")) {
      return
    }

    if (commandId === "statistics") {
      const stats = collectStatistics()
      const chart = renderStatisticsChart(stats)
      setStatisticsContent(chart)
      return
    }

    // Delegate to backend handler
    if (props.onCommand) {
      Promise.resolve(props.onCommand(commandId, args, state.store.sessionId))
        .then((res) => {
          if (res?.handled && res.next === "sessions-picker") {
            openSessionsPicker()
          } else if (res?.handled && res.next === "tool-picker") {
            openChoicePicker("tools")
          }
        })
    }
  }

  // ---------------------------------------------------------------------------
  // Handle dropdown navigation (arrow keys, tab, enter, escape)
  // Called from the global keyboard handler when a dropdown is active.
  // Returns true if the key was consumed.
  // ---------------------------------------------------------------------------

  const handleDropdownKey = (name: string, isTab: boolean, isReturn: boolean, isEscape: boolean): boolean => {
    const s = slash()
    if (s.active) {
      if (name === "up") {
        setSlash((prev) => ({
          ...prev,
          selectedIndex: prev.mode === "sessions"
            ? moveSessionRowSelection(prev.sessionRows, prev.selectedIndex, -1)
            : prev.mode === "worktrees"
              ? moveWorktreeRowSelection(prev.worktreeRows, prev.selectedIndex, -1)
              : Math.max(0, prev.selectedIndex - 1),
        }))
        return true
      }

      if (name === "down") {
        const totalItems = s.mode === "commands"
          ? s.items.length
          : s.mode === "sessions"
            ? s.sessionRows.length
            : s.mode === "worktrees"
              ? s.worktreeRows.length
              : s.pickerItems.length
        setSlash((prev) => {
          if (totalItems === 0) return prev
          return {
            ...prev,
            selectedIndex: prev.mode === "sessions"
              ? moveSessionRowSelection(prev.sessionRows, prev.selectedIndex, 1)
              : prev.mode === "worktrees"
                ? moveWorktreeRowSelection(prev.worktreeRows, prev.selectedIndex, 1)
                : Math.min(totalItems - 1, prev.selectedIndex + 1),
          }
        })
        return true
      }

      if (isTab || isReturn) {
        // --- Session picker mode ---
        if (s.mode === "sessions") {
          const selected = s.sessionRows[s.selectedIndex]
          if (selected?.type === "session" || selected?.type === "orphan") {
            setSlash(SLASH_INACTIVE)
            setInputText("")
            if (props.onCommand) {
              props.onCommand("sessions", selected.id, state.store.sessionId)
            }
          }
          return true
        }

        // --- Worktree picker mode ---
        if (s.mode === "worktrees") {
          const selected = s.worktreeRows[s.selectedIndex]
          if (selected?.type === "worktree") {
            setSlash(SLASH_INACTIVE)
            setInputText("")
            if (props.onCommand) {
              Promise.resolve(props.onCommand("worktree", selected.id, state.store.sessionId))
                .then((res) => {
                  if (res?.handled && res.next === "sessions-picker") {
                    openSessionsPicker()
                  }
                })
            }
          }
          return true
        }

        // --- Choice picker mode ---
        if (s.mode === "models" || s.mode === "profiles" || s.mode === "skills" || s.mode === "tools") {
          const selected = s.pickerItems[s.selectedIndex]
          if (selected) {
            setSlash(SLASH_INACTIVE)
            setInputText("")
            let command: string
            let commandArgs: string
            if (s.mode === "models") {
              command = "model"
              commandArgs = selected.id
            } else if (s.mode === "profiles") {
              command = "profile"
              commandArgs = selected.id
            } else if (s.mode === "tools") {
              // Selecting a user tool adds it to the session
              command = "tool"
              commandArgs = `add ${selected.id}`
            } else {
              command = "skills"
              commandArgs = selected.id
            }
            if (props.onCommand) {
              props.onCommand(command, commandArgs, state.store.sessionId)
            }
            if (s.mode === "models") {
              state.setStore("status", "modelName", selected.id)
            }
          }
          return true
        }

        // --- Command mode ---
        if (s.items.length > 0) {
          const selected = s.items[s.selectedIndex]
          if (selected) {
            // /sessions → transition to session picker
            if (selected.id === "sessions" && isReturn && openSessionsPicker()) {
              return true
            }

            // /worktree → transition to worktree picker
            if (selected.id === "worktree" && isReturn && openWorktreePicker()) {
              return true
            }

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

  const handleSubmit = (text: string) => {
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
        return
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

    props.onSubmit(
      text,
      state.store.sessionId,
      imgs.length > 0 ? imgs.map((img) => ({ mime: img.mime, data: img.data })) : undefined,
      context || undefined,
    )
  }

  // ---------------------------------------------------------------------------
  // Compute autocomplete mode for the Autocomplete component
  // ---------------------------------------------------------------------------

  const autocompleteMode = (): AutocompleteMode | null => {
    const s = slash()
    if (s.active) {
      if (s.mode === "sessions") {
        return { type: "sessions", rows: s.sessionRows, selectedIndex: s.selectedIndex }
      }
      if (s.mode === "worktrees") {
        return { type: "worktrees", rows: s.worktreeRows, selectedIndex: s.selectedIndex }
      }
      if (s.mode === "models" || s.mode === "profiles" || s.mode === "skills" || s.mode === "tools") {
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

  // ---------------------------------------------------------------------------
  // Global keyboard handler
  // ---------------------------------------------------------------------------

  useKeyboard((evt) => {
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
          state.setStore("status", "modelName", next)
          state.setStore("thinkingEffort", "none")
          getThinkingNormalizer(next).configure({ enabled: false, effort: "none" })
          bus.emit("model-switched", { modelSpec: next })
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
          state.setStore("status", "modelName", prev)
          state.setStore("thinkingEffort", "none")
          getThinkingNormalizer(prev).configure({ enabled: false, effort: "none" })
          bus.emit("model-switched", { modelSpec: prev })
        }
      }
      evt.preventDefault()
      return
    }

    // Permission mode: intercept a/o/r keys
    if (state.store.permission) {
      const lower = evt.name.toLowerCase()
      if (lower === "a") {
        respondPermission({ requestId: state.store.permission.requestId, reply: "always" })
        dispatch(state, { type: "clear-permission" })
        dispatch(state, { type: "set-running", running: true })
      } else if (lower === "o") {
        respondPermission({ requestId: state.store.permission.requestId, reply: "once" })
        dispatch(state, { type: "clear-permission" })
        dispatch(state, { type: "set-running", running: true })
      } else if (lower === "r") {
        respondPermission({ requestId: state.store.permission.requestId, reply: "reject" })
        dispatch(state, { type: "clear-permission" })
      }
      evt.preventDefault()
      return
    }

    // Question mode: intercept arrow/number/enter/escape keys
    if (state.store.question) {
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
      const effort = state.store.thinkingEffort
      getThinkingNormalizer(state.store.status.modelName).configure({ enabled: effort !== "none", effort })
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
      >
        <box flexGrow={1} minHeight={0} />
        <For each={state.store.messages}>
          {(msg) => <MessageItem message={msg} showThinking={state.store.showThinking} />}
        </For>
      </scrollbox>

      {/* Permission prompt */}
      <Show when={state.store.permission}>
        {(perm) => <PermissionPrompt request={perm()} />}
      </Show>

      {/* Question prompt */}
      <Show when={state.store.question}>
        {(q) => (
          <QuestionPrompt
            request={q()}
            tab={questionHandler.tab}
            selected={questionHandler.selected}
            answers={questionHandler.answers}
          />
        )}
      </Show>

      {/* Autocomplete dropdown — absolute overlay, does NOT shrink scrollbox */}
      <Autocomplete mode={autocompleteMode()} />

      {/* Input area */}
      <Prompt
        onSubmit={handleSubmit}
        onContentChange={handleInputChange}
        onRef={(r: TextareaRenderable) => { inputRef = r }}
        disabled={state.store.running || !!state.store.permission || !!state.store.question}
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
      />

      {/* Statistics overlay */}
      <Show when={statisticsContent()}>
        {(content) => (
          <StatisticsPanel content={content()} onClose={() => setStatisticsContent(null)} />
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
