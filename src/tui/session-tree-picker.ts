export interface SessionTreeInput {
  id: string
  title: string | null
  parentSessionId?: string | null
  pinned?: boolean
  filesModified?: string[] | null
  running?: boolean
  timeUpdated: number
}

export type SessionTreeRow =
  | {
    type: "session"
    id: string
    label: string
    detail: string
    current: boolean
    root: boolean
    guides: boolean[]
    connector: "plain" | "root" | "branch" | "last"
    running?: boolean
  }
  | { type: "orphan"; id: string; label: string; detail: string; current: boolean; running?: boolean }
  | { type: "divider"; label: string }
  | { type: "spacer" }

export interface SessionSearchResult {
  sessions: SessionTreeInput[]
  firstMatchId: string | null
}

export function searchSessionTree(sessions: SessionTreeInput[], query: string): SessionSearchResult {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return { sessions, firstMatchId: null }

  const byId = new Map(sessions.map((session) => [session.id, session]))
  const matches = sessions
    .filter((session) => [session.title, session.id, ...(session.filesModified ?? [])]
      .some((value) => value?.toLowerCase().includes(normalized)))
    .sort((a, b) => b.timeUpdated - a.timeUpdated)
  const included = new Set(matches.map((session) => session.id))

  for (const match of matches) {
    const seen = new Set<string>()
    let parentId = match.parentSessionId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      included.add(parentId)
      parentId = byId.get(parentId)?.parentSessionId
    }
  }

  return {
    sessions: sessions.filter((session) => included.has(session.id)),
    firstMatchId: matches[0]?.id ?? null,
  }
}

export function buildSessionTreeRows(
  sessions: SessionTreeInput[],
  currentSessionId: string | null,
  now = Date.now(),
): SessionTreeRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const groups = new Map<string, SessionTreeInput[]>()

  for (const session of sessions) {
    const root = rootSession(session, byId)
    const group = groups.get(root.id) ?? []
    group.push(session)
    groups.set(root.id, group)
  }

  const ordered = [...groups.values()].sort((a, b) => {
    const aPinned = a.some((session) => session.pinned)
    const bPinned = b.some((session) => session.pinned)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    const aCurrent = a.some((session) => session.id === currentSessionId)
    const bCurrent = b.some((session) => session.id === currentSessionId)
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
    return Math.max(...b.map((session) => session.timeUpdated)) - Math.max(...a.map((session) => session.timeUpdated))
  })

  const rows: SessionTreeRow[] = []
  const hasPinned = ordered.some((group) => group.some((session) => session.pinned))
  for (let index = 0; index < ordered.length; index++) {
    const pinned = ordered[index]!.some((session) => session.pinned)
    const previousPinned = index > 0 && ordered[index - 1]!.some((session) => session.pinned)
    if (hasPinned && (index === 0 || pinned !== previousPinned)) {
      rows.push({ type: "divider", label: pinned ? "Pinned" : "Recent" })
    } else if (index > 0 && (ordered[index - 1]!.length > 1 || ordered[index]!.length > 1)) {
      rows.push({ type: "spacer" })
    }
    rows.push(...sessionTreeRows(ordered[index]!, currentSessionId, now))
  }
  return rows
}

export function firstSelectableSessionRow(rows: SessionTreeRow[], preferredSessionId: string | null): number {
  const preferred = preferredSessionId
    ? rows.findIndex((row) => selectableRow(row) && row.id === preferredSessionId)
    : -1
  if (preferred >= 0) return preferred

  const first = rows.findIndex(selectableRow)
  return Math.max(0, first)
}

export function moveSessionRowSelection(rows: SessionTreeRow[], selectedIndex: number, direction: -1 | 1): number {
  for (let i = selectedIndex + direction; i >= 0 && i < rows.length; i += direction) {
    if (selectableRow(rows[i])) return i
  }
  return selectedIndex
}

function sessionRow(
  session: SessionTreeInput,
  currentSessionId: string | null,
  now: number,
  connector: Extract<SessionTreeRow, { type: "session" }>["connector"],
  guides: boolean[] = [],
): Extract<SessionTreeRow, { type: "session" }> {
  const root = connector === "root" || connector === "plain"
  return {
    type: "session",
    id: session.id,
    label: session.title ?? "(untitled)",
    detail: sessionDetail(session, root, connector !== "plain", now),
    current: session.id === currentSessionId,
    root,
    guides,
    connector,
    ...(session.running ? { running: true } : {}),
  }
}

function sessionTreeRows(
  sessions: SessionTreeInput[],
  currentSessionId: string | null,
  now: number,
): SessionTreeRow[] {
  if (sessions.length === 1) return [sessionRow(sessions[0]!, currentSessionId, now, "plain")]

  const byId = new Map(sessions.map((session) => [session.id, session]))
  const children = new Map<string, SessionTreeInput[]>()
  const roots: SessionTreeInput[] = []

  for (const session of sessions) {
    const parentId = session.parentSessionId
    if (!parentId || !byId.has(parentId)) {
      roots.push(session)
      continue
    }
    const siblings = children.get(parentId) ?? []
    siblings.push(session)
    children.set(parentId, siblings)
  }

  const rows: SessionTreeRow[] = []
  const visited = new Set<string>()
  const sorted = (items: SessionTreeInput[]) => items.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return b.timeUpdated - a.timeUpdated
  })

  const visit = (
    session: SessionTreeInput,
    guides: boolean[],
    connector: Extract<SessionTreeRow, { type: "session" }>["connector"],
  ) => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    rows.push(sessionRow(session, currentSessionId, now, connector, guides))

    const descendants = sorted(children.get(session.id) ?? [])
    for (let index = 0; index < descendants.length; index++) {
      const childGuides = connector === "root" ? [] : [...guides, connector === "branch"]
      visit(descendants[index]!, childGuides, index === descendants.length - 1 ? "last" : "branch")
    }
  }

  for (const root of sorted(roots)) visit(root, [], "root")
  for (const session of sorted(sessions)) visit(session, [], "root")
  return rows
}

function rootSession(session: SessionTreeInput, byId: Map<string, SessionTreeInput>): SessionTreeInput {
  const seen = new Set<string>()
  let current = session

  while (current.parentSessionId && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parentSessionId)
    if (!parent) break
    current = parent
  }

  return current
}

function sessionDetail(
  session: SessionTreeInput,
  root: boolean,
  branched: boolean,
  now: number,
): string {
  const markers: string[] = []
  if (session.pinned) markers.push("pinned")
  if (branched) markers.push(root ? "original" : "branch")
  if (session.running) markers.push("● running")
  const fileCount = new Set(session.filesModified ?? []).size
  if (fileCount) markers.push(`${fileCount} ${fileCount === 1 ? "file" : "files"}`)
  return [...markers, formatRelativeTime(session.timeUpdated, now)].join(" · ")
}

function selectableRow(row: SessionTreeRow | undefined): row is Extract<SessionTreeRow, { type: "session" }> {
  return row?.type === "session"
}

export function formatRelativeTime(time: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - time) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}
