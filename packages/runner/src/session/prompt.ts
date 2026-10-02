// prompt() entry point + loop() — the core agent loop
//
// Flow:
// 1. prompt() saves the user message, creates/resumes a session, enters loop()
// 2. loop() iterates:
//    a. Load all messages from DB → convert to ModelMessage[]
//    b. Build system prompt
//    c. Resolve tools (ToolDef → AI SDK tool objects)
//    d. Create an assistant message row
//    e. Call processStream() which streams, persists parts, returns outcome
//    f. "continue" → next iteration (tool calls need follow-up)
//    g. "stop" → break

import { createSession, getSession, setSessionTitle, touchSession, defaultSessionStore } from "./session";
import type { SessionStore } from "./store";
import {
  saveUserMessage,
  createAssistantMessage,
  finishMessage,
  loadMessages,
  toModelMessages,
} from "./message";
import { buildSystem, type AmbientInstructions } from "./system";
import { processStream, type StreamFn } from "./processor";
import { createAutoBranch, shouldAutoBranch } from "./branch-controller";
import { emitSessionSwitch } from "./session-switch";
import { generateSessionTitle } from "./title";
import { resolveToolSet } from "../tool/ai-adapter";
import { resolveModel, resolveModelRuntime, type ResolveModelOptions } from "../provider/resolver";
import type { CatalogRegistry } from "../provider/catalog-registry";
import { withFastMode } from "../provider/fast-mode";
import type { AgentDefinition } from "../agent";
import { PORTABLE_POLICIES, resolveRunPolicies, type BranchingConfig, type RunPolicies } from "./policies";

import { bus, TypedBus } from "./events";
import { globalHooks, type HookRegistry } from "../plugin/registry";
import { debug } from "../debug";
import { setCurrentTurn, preTurnSnapshot } from "../commands/undo";

const dlog = debug("loop");

export { resolveModel } from "../provider/resolver";

// ---------------------------------------------------------------------------
// Runtime — per-instance event bus + cancellation state
//
// The legacy module-level prompt()/cancel()/isActive() use `defaultRuntime`,
// which is backed by the singleton `bus` and a module-level active map. An
// instance created via createRunner() passes its own runtime so two runners
// never share listeners or abort controllers.
// ---------------------------------------------------------------------------
export interface PromptRuntime {
  /** Bus that lifecycle events are emitted on for this runtime. */
  bus: TypedBus;
  /** In-flight abort controllers, keyed by session ID. */
  active: Map<string, AbortController>;
  /**
   * Hook handlers this runtime fires. Instance runners pass their own; the
   * legacy singleton runtime uses {@link globalHooks}.
   */
  hooks: HookRegistry;
  /**
   * Persistence store for this runtime. Instance runners pass their own
   * (portable default: in-memory); the legacy singleton runtime uses the
   * global JSONL store.
   */
  store: SessionStore;
  /**
   * When true this runtime owns all of its turn state and must not touch
   * process-global state such as `QUARK_SESSION_ID`. Instance runners created by `createRunner()` set
   * this; the legacy singleton runtime leaves it `false` so CLI/TUI behavior
   * is unchanged.
   */
  isolated: boolean;
}

/** Create an isolated prompt runtime. Defaults to a fresh event bus. */
export function createPromptRuntime(
  eventBus: TypedBus = new TypedBus(),
  hooks: HookRegistry = globalHooks,
  store: SessionStore = defaultSessionStore,
): PromptRuntime {
  return { bus: eventBus, active: new Map(), hooks, store, isolated: true };
}

const active = new Map<string, AbortController>();
const defaultRuntime: PromptRuntime = { bus, active, hooks: globalHooks, store: defaultSessionStore, isolated: false };

// ---------------------------------------------------------------------------
// Run policies — re-exported from ./policies for the runner's public surface
// ---------------------------------------------------------------------------

export { PORTABLE_POLICIES, resolveRunPolicies } from "./policies";
export type { BranchingConfig, RunPolicies } from "./policies";

// ---------------------------------------------------------------------------
// prompt() — public entry point
// ---------------------------------------------------------------------------
/**
 * Run the agent loop for a given user input.
 *
 * Creates a new session if `sessionId` is not provided, saves the user message,
 * then iterates the agent loop until the model returns `stop` or `max_steps` is reached.
 *
 * @param input.sessionId - Resume an existing session (optional)
 * @param input.parentSessionId - Link this session as a sub-agent child (optional; used internally)
 * @param input.parts - User message parts (text content)
 * @param input.images - Optional image attachments (`mime` + base64 `data`)
 * @param input.model - Override the provider and model for this call
 * @param input.agent - The portable agent definition to run
 * @param input.policies - Explicit execution policies. Defaults to PORTABLE_POLICIES.
 * @param input.resolve - Model-resolution dependencies (registry/catalog/providers)
 *   used instead of config-file lookups.
 * @returns The session ID that was used (new or resumed)
 *
 * @example
 * ```ts
 * const { sessionId } = await prompt({
 *   agent: defineAgent({ id: 'coder', instructions: '...', tools: [readTool] }),
 *   parts: [{ type: 'text', text: 'Refactor src/index.ts to use async/await' }],
 * })
 * ```
 */
export async function prompt(input: {
  sessionId?: string;
  parentSessionId?: string;
  ephemeral?: boolean;
  parts: { type: "text"; text: string }[];
  images?: { mime: string; data: string }[];
  /** Hidden model context prepended to this user message. */
  modelOnlyText?: string;
  model?: string;
  /**
   * Thinking-effort override for this turn (from `session/set_config_option`).
   * Applied on top of the resolved model instead of the agent's configured
   * effort, so a client can change reasoning per session.
   */
  thinkingEffort?: string;
  agent: AgentDefinition;
  catalog?: CatalogRegistry;
  /**
   * Absolute workspace root this turn runs in (tools, system prompt, ambient
   * reads, subagents). Stored as the session's `directory` when a session is
   * created; on resume the stored directory wins, so a session never silently
   * moves. Defaults to `process.cwd()`.
   */
  targetWorkspace?: string;
  /** Explicit execution policies. Defaults to PORTABLE_POLICIES. */
  policies?: Partial<RunPolicies>;
  /** Model-resolution dependencies (registry/catalog/providers). */
  resolve?: ResolveModelOptions;
  /**
   * Ambient/project instruction context. Defaults to none (no file reads);
   * pass `loadAmbientInstructions` (app-side) to opt into AGENTS.md reads.
   */
  ambientInstructions?: AmbientInstructions | null;
  /** @internal Pre-created abort controller, supplied by instance runners. */
  controller?: AbortController;
  /** @internal Streaming primitive override, supplied by instance runners/tests. */
  stream?: StreamFn;
}, runtime: PromptRuntime = defaultRuntime) {
  const agent = input.agent;
  const policies = resolveRunPolicies(input.policies);
  const resolveOptions: ResolveModelOptions = {
    ...input.resolve,
    ...(input.catalog ? { catalog: input.catalog } : {}),
  };

  // Resolve or create session (lazy — only created on first message)
  const store = runtime.store;
  let sessionId: string;
  let workspace: string;
  let created = false;
  if (input.sessionId) {
    const existing = store.get(input.sessionId);
    if (existing) {
      sessionId = input.sessionId;
      // A session is permanently bound to its workspace: the stored directory
      // is authoritative on resume, so two callers cannot disagree about where
      // the same conversation runs.
      workspace = existing.directory ?? input.targetWorkspace ?? process.cwd();
    } else if (store.createOnMissing) {
      // Portable stores treat an unknown ID as a new namespace. Two runners
      // can reuse the same ID and never see each other's history. A supplied
      // ID that creates a session is announced exactly like a generated one.
      workspace = input.targetWorkspace ?? process.cwd();
      sessionId = createSession(
        {
          id: input.sessionId,
          directory: workspace,
          ...(input.ephemeral ? { ephemeral: true } : {}),
          ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        },
        store,
      ).id;
      created = true;
    } else {
      throw new Error(`Session not found: ${input.sessionId}`);
    }
  } else {
    workspace = input.targetWorkspace ?? process.cwd();
    const sess = createSession(
      input.ephemeral
        ? { ephemeral: true, directory: workspace, ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}) }
        : input.parentSessionId
          ? { parentSessionId: input.parentSessionId, kind: "subagent", directory: workspace }
          : { directory: workspace },
      store,
    );
    sessionId = sess.id;
    created = true;
  }
  if (created) {
    runtime.bus.emit("session-created", { sessionId });
    runtime.hooks.fire("session.created", { sessionId }).catch(() => {});
  }

  // Save user message (concatenate all text parts)
  const text = input.parts.map((p) => p.text).join("\n");
  const userMsg = saveUserMessage({
    sessionId,
    text,
    images: input.images,
    store,
    ...(input.modelOnlyText ? { modelOnlyText: input.modelOnlyText } : {}),
  });
  runtime.bus.emit("user-message", { sessionId, messageId: userMsg.id, text, images: input.images });

  return runTurn({
    sessionId,
    userMessageId: userMsg.id,
    userText: text,
    model: input.model,
    thinkingEffort: input.thinkingEffort,
    agent,
    initiator: input.parentSessionId ? "agent" : undefined,
    policies,
    resolveOptions,
    ambient: input.ambientInstructions,
    workspace,
    controller: input.controller,
    stream: input.stream,
  }, runtime);
}

/**
 * Run a turn whose user message has already been persisted. Used by /steer so
 * the child branch responds to its saved steer prompt without duplicating it.
 */
export async function runSeededSession(input: {
  sessionId: string
  userMessageId: string
  userText: string
  model?: string
  agent: AgentDefinition
  catalog?: CatalogRegistry
  /** Explicit execution policies. Defaults to PORTABLE_POLICIES. */
  policies?: Partial<RunPolicies>
  /** Model-resolution dependencies (registry/catalog/providers). */
  resolve?: ResolveModelOptions
  /** Ambient/project instruction context; see {@link prompt}. */
  ambientInstructions?: AmbientInstructions | null
  /** Fallback workspace when the session has no stored directory. */
  targetWorkspace?: string
  /** @internal Pre-created abort controller, supplied by instance runners. */
  controller?: AbortController
  /** @internal Streaming primitive override, supplied by instance runners/tests. */
  stream?: StreamFn
}, runtime: PromptRuntime = defaultRuntime) {
  const session = getSession(input.sessionId, runtime.store)
  const agent = input.agent
  return runTurn({
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    userText: input.userText,
    model: input.model,
    agent,
    policies: resolveRunPolicies(input.policies),
    ambient: input.ambientInstructions,
    // A seeded turn belongs to an existing session, so its bound directory is
    // authoritative; the caller's fallback only covers pre-directory sessions.
    workspace: session.directory ?? input.targetWorkspace ?? process.cwd(),
    resolveOptions: {
      ...input.resolve,
      ...(input.catalog ? { catalog: input.catalog } : {}),
    },
    controller: input.controller,
    stream: input.stream,
  }, runtime)
}

async function runTurn(input: {
  sessionId: string
  userMessageId: string
  userText: string
  model?: string
  thinkingEffort?: string
  agent: AgentDefinition
  initiator?: "user" | "agent"
  policies: RunPolicies
  resolveOptions?: ResolveModelOptions
  ambient?: AmbientInstructions | null
  /** Absolute workspace root for this turn; drives system prompt + tools. */
  workspace: string
  controller?: AbortController
  stream?: StreamFn
}, runtime: PromptRuntime) {
  const { sessionId, userMessageId, userText, model, agent, policies } = input
  const thinkingEffort = input.thinkingEffort
  const store = runtime.store
  // Route model resolution through this runtime's hooks, so provider.request.*
  // hooks are instance-scoped for runners (and global for the legacy runtime).
  const resolveOptions: ResolveModelOptions = {
    ...(input.resolveOptions ?? {}),
    ...(input.initiator ? { initiator: input.initiator } : {}),
    hooks: runtime.hooks,
    // Instance runners thread their own session ID so concurrent runs never
    // share a provider-side conversation (OpenCode Go `x-opencode-session`).
    // The legacy runtime supplies none: it keeps writing QUARK_SESSION_ID and
    // adapters read that per request, unchanged (including after a branch).
    ...(runtime.isolated ? { sessionId } : {}),
  }
  // QUARK_SESSION_ID is a process-global convenience read by plugins and
  // opencode-go. An instance runner must not write it — two concurrent runs
  // would race and stomp each other. Legacy prompt()/CLI/TUI keeps the write.
  if (!runtime.isolated) process.env.QUARK_SESSION_ID = sessionId
  touchSession(sessionId, store)

  const session = getSession(sessionId, store)
  if (session.kind === "subagent") resolveOptions.initiator = "agent"
  // Undo writes file snapshots + a .touched.json tracker under the session
  // storage root. Only the global JSONL store supports that tracker; custom
  // stores and ephemeral sessions must never touch its files.
  const undoEnabled = policies.undo !== false && store === defaultSessionStore && session.kind !== "ephemeral"
  if (undoEnabled) {
    setCurrentTurn(sessionId, userMessageId)
    preTurnSnapshot(sessionId, userMessageId).catch(() => {})
  }

  const controller = input.controller ?? new AbortController()
  runtime.active.set(sessionId, controller)
  runtime.bus.emit("loop-start", { sessionId })
  let finalSessionId = sessionId
  const turnMessageIds = new Map<string, string>([[sessionId, userMessageId]])
  try {
    if (!session.title) {
      const fallbackTitle = userText.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, 80) || "Untitled"
      setSessionTitle(sessionId, fallbackTitle, store, runtime.bus)
      // Portable runs use policies.smallModel only (default null → no title call,
      // no config read).
      const titleModel = policies.smallModel
      if (titleModel) {
        resolveModel(titleModel, "small", resolveOptions)
          .then((resolvedSmallModel) => generateSessionTitle({ sessionId, message: userText, model: resolvedSmallModel, store, bus: runtime.bus }))
          .catch(() => {})
      }
    }

    finalSessionId = await loop(
      sessionId,
      userMessageId,
      controller.signal,
      agent,
      model,
      turnMessageIds,
      resolveOptions,
      runtime,
      policies,
      input.stream,
      input.ambient,
      input.workspace,
      undoEnabled,
      thinkingEffort,
    )
  } catch (err) {
    // Central `session.error` for an unhandled turn failure. Provider failures
    // already fired `provider.request.error` and emitted their `error` bus event
    // inside processStream, so this fires only the session hook — never a second
    // bus error or provider hook. An abort is a normal stop, not a failure.
    if (!controller.signal.aborted) {
      const failedSessionId = Array.from(turnMessageIds.keys()).at(-1) ?? sessionId
      runtime.hooks.fire("session.error", { sessionId: failedSessionId, error: err }).catch(() => {})
    }
    throw err
  } finally {
    // loop() can throw after moving to an automatic child branch, before its
    // return value updates finalSessionId. The newest mapping is authoritative.
    finalSessionId = Array.from(turnMessageIds.keys()).at(-1) ?? finalSessionId
    if (controller.signal.aborted) {
      // Exclude the initiating prompt from future context in the original
      // session and in every child session created by automatic branching.
      for (const [turnSessionId, turnMessageId] of turnMessageIds) {
        finishMessage(turnMessageId, "aborted", undefined, turnSessionId, store)
      }
      const finalUserMessageId = turnMessageIds.get(finalSessionId) ?? userMessageId
      runtime.bus.emit("user-message-status", {
        sessionId: finalSessionId,
        messageId: finalUserMessageId,
        status: "aborted",
      })
    }
    for (const [id, activeController] of runtime.active) {
      if (activeController === controller) runtime.active.delete(id)
    }
    runtime.bus.emit("loop-end", { sessionId: finalSessionId })
    runtime.hooks.fire("session.idle", { sessionId: finalSessionId }).catch(() => {})
  }

  return { sessionId: finalSessionId }
}

/**
 * Cancel a running agent loop for the given session.
 *
 * Triggers the `AbortController` associated with the session, which propagates
 * through the LLM stream and all active tool calls. Safe to call on sessions
 * that are not currently running (no-op).
 *
 * @param sessionId - The session to cancel
 * @param runtime - Runtime owning the session (defaults to the singleton runtime)
 */
export function cancel(sessionId: string, runtime: PromptRuntime = defaultRuntime) {
  const controller = runtime.active.get(sessionId);
  if (controller) {
    controller.abort();
    runtime.active.delete(sessionId);
  }
}

/**
 * Check if a session is currently running.
 *
 * @param sessionId - The session to check
 * @param runtime - Runtime owning the session (defaults to the singleton runtime)
 * @returns `true` if the session has an active abort controller (i.e., prompt() is running)
 */
export function isActive(sessionId: string, runtime: PromptRuntime = defaultRuntime): boolean {
  return runtime.active.has(sessionId);
}

function moveActiveSession(from: string, to: string, runtime: PromptRuntime): void {
  if (from === to) return;
  const controller = runtime.active.get(from);
  runtime.active.delete(from);
  if (controller) runtime.active.set(to, controller);
  if (!runtime.isolated) process.env.QUARK_SESSION_ID = to;
}

// ---------------------------------------------------------------------------
// loop() — the heart of the agent
// ---------------------------------------------------------------------------
async function loop(
  sessionId: string,
  userMessageId: string,
  abort: AbortSignal,
  agent: AgentDefinition,
  modelOpt: string | undefined,
  turnMessageIds: Map<string, string>,
  resolveOptions: ResolveModelOptions = {},
  runtime: PromptRuntime = defaultRuntime,
  policies: RunPolicies = PORTABLE_POLICIES,
  stream?: StreamFn,
  ambient?: AmbientInstructions | null,
  /** Absolute workspace root for this run; defaults to the process cwd. */
  workspace?: string,
  /** Whether file snapshots are tracked for this turn (ephemeral/policy off). */
  undoEnabled = true,
  /** Per-turn thinking-effort override (see `prompt()`); wins over the agent's. */
  thinkingEffort?: string,
): Promise<string> {
  const maxSteps = policies.maxSteps;
  const branching = policies.branching;
  const runWorkspace = workspace ?? process.cwd();

  // Build the AI SDK model
  // Priority: explicit modelOpt > agent model
  // Model is always in "provider/model" format.
  const agentModelSpec = agent.model;
  const modelSpec = modelOpt ?? agentModelSpec;
  const usingAgentModel = modelOpt === undefined || modelOpt === agentModelSpec;
  let resolvedModel = await resolveModelRuntime(modelSpec, "main", resolveOptions);
  // Summary requests are separate model resolutions so their fetch closure has
  // an agent initiator without changing the active turn's provider state.
  const summaryModel = async (sessionId: string) => (await resolveModelRuntime(modelSpec, "main", {
    ...resolveOptions, ...(runtime.isolated ? { sessionId } : {}), initiator: "agent",
  })).languageModel;
  let model = resolvedModel.languageModel;
  let modelLimit = resolvedModel.catalogModel.limit;
  const moveToBranch = async (nextSessionId: string) => {
    if (runtime.isolated) {
      // OpenCode Go binds its conversation header at model creation.
      resolvedModel = await resolveModelRuntime(modelSpec, "main", { ...resolveOptions, sessionId: nextSessionId });
      model = resolvedModel.languageModel;
      modelLimit = resolvedModel.catalogModel.limit;
    }
  };

  // mutable — may change when branching steers to a different session
  let currentSessionId = sessionId;
  let currentUserMessageId = userMessageId;

  let step = 0;
  while (true) {
    if (abort.aborted) break;
    step++;

    dlog(`--- iteration ${step} starting (sessionId=${currentSessionId}) ---`);

    // Safety: prevent runaway loops
    if (step > maxSteps) {
      dlog(`max_steps reached (${maxSteps}), breaking`);
      break;
    }

    // Plugin hook: loop step beginning
    await runtime.hooks.fire("loop.step.before", { sessionId: currentSessionId, step });

    // 1. Load conversation history
    const { messages, parts } = loadMessages(currentSessionId, runtime.store);
    const modelMessages = toModelMessages(messages, parts);

    if (dlog.enabled) {
      dlog(
        `loaded ${messages.length} messages, ${parts.length} parts → ${modelMessages.length} model messages`,
      );
      const roles = modelMessages.map((m) => {
        const c = m.content;
        if (typeof c === "string") return `${m.role}(text:${c.length})`;
        if (Array.isArray(c)) {
          const types = c.map((p: any) => p.type).join(",");
          return `${m.role}(${types})`;
        }
        return m.role;
      });
      dlog("messages roles:", roles.join(" | "));
    }

    // 2. Build system prompt
    const system = buildSystem(agent, ambient, runWorkspace);

    // 3. Check if branching is needed BEFORE the model call
    if (
      shouldAutoBranch({
        system,
        modelMessages,
        modelLimit,
        parts,
      }, branching)
    ) {
      try {
        const branchResult = await createAutoBranch({
          sessionId: currentSessionId,
          messages,
          parts,
          model: await summaryModel(currentSessionId),
          profile: agent.id,
          abort,
          store: runtime.store,
        });
        const previousSessionId = currentSessionId;
        currentSessionId = branchResult.sessionId;
        const replayedUserMessageId = branchResult.replayedMessageIds?.[currentUserMessageId]
        if (replayedUserMessageId) currentUserMessageId = replayedUserMessageId
        turnMessageIds.set(currentSessionId, currentUserMessageId)
        moveActiveSession(previousSessionId, currentSessionId, runtime);
        await moveToBranch(currentSessionId);
        await emitSessionSwitch(currentSessionId, agent, { kind: "branch", goal: "continue" }, runtime.bus, ambient, runWorkspace, runtime.store);

        // Re-load after branching so the model sees the task lineage context.
        continue;
      } catch (err) {
        console.error(
          "[prompt] auto-branch FAILED:",
          err instanceof Error ? err.stack : String(err),
        );
        // Handled failure: log it and continue with full context. `session.error`
        // is reserved for failures that end the turn (fired centrally in runTurn).
        runtime.bus.emit("error", { sessionId: currentSessionId, error: err, userMessageId });
        // Continue with full context if branching fails.
      }
    }

    // 4. Create assistant message row
    const assistantMsg = createAssistantMessage({
      sessionId: currentSessionId,
      modelId: resolvedModel.ref.spec,
      providerId: resolvedModel.ref.providerId,
      store: runtime.store,
    });
    runtime.bus.emit("assistant-message-start", {
      sessionId: currentSessionId,
      messageId: assistantMsg.id,
    });

    // 5. Resolve tools with correct context for this iteration
    const tools = resolveToolSet(
      agent,
      currentSessionId,
      assistantMsg.id,
      abort,
      runtime.bus,
      runtime.hooks,
      { undo: undoEnabled, workspace: runWorkspace },
    );

    // 6. Stream + process
    const thinkingProviderOptions = withFastMode(resolvedModel.provider.definition, resolvedModel.provider.adapter.encodeReasoning?.({
      model: resolvedModel.catalogModel,
      config: {
        effort: thinkingEffort ?? (usingAgentModel ? agent.thinkingEffort ?? "none" : "none"),
        mode: usingAgentModel ? agent.thinkingMode ?? "standard" : "standard",
        modeExplicit: usingAgentModel && agent.thinkingMode !== undefined,
      },
    }), usingAgentModel ? agent.fastMode : undefined);
    const result = await processStream({
      model,
      resolvedModel,
      system,
      messages: modelMessages,
      tools,
      abort,
      msg: assistantMsg,
      sessionId: currentSessionId,
      userMessageId: currentUserMessageId,
      providerId: resolvedModel.ref.providerId,
      modelId: resolvedModel.ref.modelId,
      bus: runtime.bus,
      branching,
      hooks: runtime.hooks,
      store: runtime.store,
      ...(stream ? { stream } : {}),
      rebuildModel: async (provider, modelId) => {
        const rebuilt = await resolveModelRuntime(`${provider}/${modelId}`, "main", resolveOptions)
        return {
          resolvedModel: rebuilt,
          providerOptions: rebuilt.provider.adapter.encodeReasoning?.({
            model: rebuilt.catalogModel,
            config: { effort: "none", mode: "standard", modeExplicit: false },
          }),
        }
      },
      ...(thinkingProviderOptions
        ? { providerOptions: thinkingProviderOptions }
        : {}),
    });

    dlog(`processStream returned: ${result}`);

    // Plugin hook: loop step ending
    await runtime.hooks.fire("loop.step.after", {
      sessionId: currentSessionId,
      step,
      result,
    });

    // 7. Decide next action
    if (result === "continue") continue;
    if (result === "branch") {
      // Provider returned context-too-long or mid-stream pressure exceeded.
      try {
        const { messages: curMsgs, parts: curParts } =
          loadMessages(currentSessionId, runtime.store);
        const branchResult = await createAutoBranch({
          sessionId: currentSessionId,
          messages: curMsgs,
          parts: curParts,
          model: await summaryModel(currentSessionId),
          profile: agent.id,
          abort,
          store: runtime.store,
        });
        const previousSessionId = currentSessionId;
        currentSessionId = branchResult.sessionId;
        const replayedUserMessageId = branchResult.replayedMessageIds?.[currentUserMessageId]
        if (replayedUserMessageId) currentUserMessageId = replayedUserMessageId
        turnMessageIds.set(currentSessionId, currentUserMessageId)
        moveActiveSession(previousSessionId, currentSessionId, runtime);
        await moveToBranch(currentSessionId);
        await emitSessionSwitch(currentSessionId, agent, { kind: "branch", goal: "Auto-branched (context full)" }, runtime.bus, ambient, runWorkspace, runtime.store);

        continue;
      } catch (err) {
        console.error(
          "[prompt] context-too-long branch FAILED:",
          err instanceof Error ? err.stack : String(err),
        );
        runtime.bus.emit("error", { sessionId: currentSessionId, error: err, userMessageId });
        break;
      }
    }
    break; // "stop"
  }
  return currentSessionId;
}
