export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface SubAgentToolPart {
  tool: string
  callId: string
  status: ToolStatus
  input: Record<string, unknown>
  error?: string
}

export interface SubAgentState {
  profile: string
  modelName?: string
  prompt?: string
  childSessionId?: string
  tools: SubAgentToolPart[]
  tokensUsed: number
  tokenLimit: number
  textPreview?: string
  error?: { kind: "provider" | "process" | "protocol"; message: string }
  done: boolean
  startedAt?: number
  durationMs?: number
}

export type MessagePart =
  | { _id?: string; type: "text"; text: string; streaming?: boolean }
  | { _id?: string; type: "thinking"; text: string; done: boolean }
  | {
      _id?: string
      type: "tool"
      tool: string
      callId: string
      status: ToolStatus
      input: Record<string, unknown>
      output?: string
      error?: string
      diff?: string
      subAgent?: SubAgentState
    }
  | { _id?: string; type: "image"; mime: string; data: string; label: string }

export interface Message {
  id: string
  role: "user" | "assistant"
  parts: MessagePart[]
  status?: "sent" | "replied" | "aborted" | "failed"
  streaming?: boolean
  timeCreated?: number
}

export interface SessionSummary {
  id: string
  title: string
  directory: string
  pinned: boolean
  timeUpdated: number
  running: boolean
}

export interface AppStatus {
  modelName: string
  /** Human-readable model name from the catalog, when known */
  modelLabel: string
  thinkingEffort: string
  /** Thinking levels the active model accepts, "none" first */
  thinkingLevels: string[]
  tokenLimit: number
  cwd: string
  branch: string | null
  profile: string
}

export interface StatusResponse {
  status: AppStatus
}

export interface CatalogModel {
  /** `provider/model` spec accepted by /model and the prompt API */
  id: string
  name: string
  detail?: string
}

export interface CatalogResponse {
  profiles: string[]
  profile: string
  skills: string[]
  activeSkills: string[]
}

export interface ModelsResponse {
  models: CatalogModel[]
}

export interface BranchResponse {
  sessionId: string
  kind: "steer" | "compact"
  status: AppStatus
}

export interface QuestionRequest {
  requestId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}

export interface StateResponse {
  session: SessionSummary | null
  sessions: SessionSummary[]
  messages: Message[]
  tokensUsed: number
  status: AppStatus
}

export interface SessionResponse {
  session: SessionSummary
  messages: Message[]
  tokensUsed: number
}

export interface UndoResponse {
  undone: boolean
  restored: string[]
  deleted: string[]
}

export interface ExportResponse {
  filePath: string
  messageCount: number
}
