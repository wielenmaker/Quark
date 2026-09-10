// Quark — Minimal Coding Agent
// Entry point, exports public API

// Initialization
export { bootstrap, type BootstrapOptions } from "./bootstrap"

// Session management
export { createSession, getSession } from "./session/session"
export type { Session, SessionKind } from "./session/session"
// Core operations
export { prompt, cancel, isActive } from "./session/prompt"

export {
  createBranch,
  compactBranch,
  createSteerBranch,
  autoBranch,
  buildLineageContext,
  getSessionLineage,
  shouldBranchWithRealTokens,
  splitMessages,
} from "./session/branch"

// Tool system
export { register, list as listTools, type ToolValidationError } from "./tool/registry"
export { defineTool } from "./tool/tool"
export type { ToolDef, ToolContext, ToolResult, ToolResultContentPart } from "./tool/tool"

// Events
export { bus } from "./session/events"
export type { BusEvents, BusEventName } from "./session/events"

// Question tool
export { respondQuestion, type QuestionResponse } from "./tool/question"

// Agent configuration
export { defaultAgent, agentFromProfile, type AgentConfig } from "./agent"

// Profile management
export {
  resolveProfile,
  readPromptFile,
  listProfiles,
  setProfileThinking,
  resetProfileCache,
  type ProfileDef,
  type ProfileConfig,
  type PromptFileResult,
} from "./profile/profile"

// Plugin types (for authoring plugins)
export type { PluginFn, PluginContext, PluginHooks } from "./plugin/plugin"

// Sanitized external telemetry
export {
  registerTelemetryAdapter,
  emitTelemetry,
  flushTelemetry,
  createRunId,
  clearTelemetryAdapters,
  configureTelemetry,
  isTelemetryDiagnosticModeEnabled,
  createSpanTelemetryAdapter,
  createTelemetrySpanAdapter,
  TELEMETRY_SCHEMA_VERSION,
} from "./telemetry"
export type {
  TelemetryAdapter,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryPayloads,
  RunStatus,
  TelemetryAttribute,
  TelemetrySpan,
  TelemetrySpanEvent,
  TelemetrySpanExporter,
  TelemetryTransport,
  TelemetryConfig,
  TelemetryDiagnostics,
  TelemetryTokenCounts,
} from "./telemetry"
