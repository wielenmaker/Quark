// `quark acp` — host process for the ACP agent.
//
// Owns config/profile resolution and stdio; delegates the protocol to
// @quark/acp. stdout carries only NDJSON protocol data — every diagnostic goes
// to stderr.

import { parseArgs } from "util"
import { createRunner, defaultSessionStore, type AgentDefinition } from "@quark/runner"
import { CatalogRegistry } from "@quark/runner/provider/catalog-registry"
import { DEFAULT_CATALOG_SNAPSHOT_PATH, readCatalogSnapshot } from "@quark/runner/provider/catalog-snapshot"
import { ActiveProviderSet, type CatalogModelPair } from "@quark/runner/provider/active-providers"
import { DefaultCredentialResolver } from "@quark/runner/provider/credentials"
import { createDefaultCredentialStore } from "@quark/runner/provider/credential-store"
import { loadOAuthTokenFile } from "@quark/runner/provider/oauth-token-files"
import { createRuntimeProviderRegistry } from "@quark/runner/provider/resolver"
import { thinkingCapabilityFromCatalog } from "@quark/runner/provider/catalog-runtime"
import type { CatalogModel } from "@quark/runner/provider/catalog-snapshot"
import { effectiveModel, runAcpStdio, type ModelOption, type ProfileOption } from "@quark/acp"
import { loadAgents, materializeAgent, resolveAgent } from "./agent/agent"
import { loadConfig } from "./config/config"
import { loadAmbientInstructions } from "./ambient"
import { useRunnerSessionRoot } from "./session-root"

/**
 * Whether the model spec (e.g. "openai/gpt-5.6-luna") accepts image input,
 * from the local models.dev catalog snapshot. `undefined` when unknown —
 * the catalog is missing, stale, or the model is not listed — so images pass
 * through and the provider surfaces its own error instead of us guessing.
 * Memoized per spec: the gate runs on every prompt and reading the snapshot is
 * a synchronous file read.
 */
const imageSupportCache = new Map<string, boolean | undefined>()
function modelAcceptsImages(modelSpec: string | undefined): boolean | undefined {
  if (!modelSpec) return undefined
  if (imageSupportCache.has(modelSpec)) return imageSupportCache.get(modelSpec)
  const accepts = readAcceptsImages(modelSpec)
  imageSupportCache.set(modelSpec, accepts)
  return accepts
}

function readAcceptsImages(modelSpec: string): boolean | undefined {
  const snapshot = readCatalogSnapshot(DEFAULT_CATALOG_SNAPSHOT_PATH)
  if (!snapshot) return undefined
  const [providerId, ...rest] = modelSpec.split("/")
  const modelId = rest.join("/")
  if (!providerId || !modelId) return undefined
  const model = new CatalogRegistry(snapshot).getModel(providerId, modelId)
  if (!model) return undefined
  return model.modalities.input.includes("image")
}

/**
 * Profiles offered to the ACP client as its mode selector, in a stable order.
 * Every entry is a manifest the host can bind, so a client can only select one
 * of these. Each carries the profile's own model/effort: the client shows those
 * as the current model/effort while the profile is selected.
 */
function loadProfileOptions(): ProfileOption[] {
  const agents = loadAgents()
  return Object.values(agents)
    .map(
      (agent): ProfileOption => ({
        id: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.thinkingEffort ? { thinkingEffort: agent.thinkingEffort } : {}),
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The profile the connection starts on: an explicit `--profile`/`--agent`, or
 * the config default. An explicit id that no manifest backs is refused rather
 * than silently resolved to a different agent.
 */
function resolveStartProfile(explicit: string | undefined, profiles: readonly ProfileOption[]): string {
  if (!explicit) return resolveAgent().id
  if (!profiles.some((profile) => profile.id === explicit)) {
    throw new Error(
      `unknown profile "${explicit}"; available: ${profiles.map((profile) => profile.id).join(", ")}`,
    )
  }
  return explicit
}

/**
 * `thinkingLevels` for a `ModelOption`, or nothing when the model has no
 * verified reasoning levels — never advertise an effort the runner rejects.
 */
function thinkingLevelsField(model: CatalogModel): { thinkingLevels?: string[] } {
  const levels = thinkingCapabilityFromCatalog(model)?.levels
  return levels ? { thinkingLevels: levels } : {}
}

/**
 * Build the list of available models for the client model picker.
 *
 * Uses `ActiveProviderSet` to filter to providers the user actually has
 * credentials for (API keys in env or credential store). Every model a session
 * can actually run stays in the list even without credentials — the start
 * profile's model and each advertised profile's own model — so the picker can
 * never show a current value it does not offer.
 */
async function buildAvailableModels(
  defaultModel: string | undefined,
  profiles: readonly ProfileOption[],
): Promise<ModelOption[]> {
  const snapshot = readCatalogSnapshot(DEFAULT_CATALOG_SNAPSHOT_PATH)
  if (!snapshot) return []
  const catalog = new CatalogRegistry(snapshot)

  let activePairs: readonly CatalogModelPair[] = []
  try {
    const credentialStore = await createDefaultCredentialStore()
    const resolver = new DefaultCredentialResolver(credentialStore, undefined, process.env, loadOAuthTokenFile)
    const providers = createRuntimeProviderRegistry()
    const activeProviders = new ActiveProviderSet(providers, resolver)
    await activeProviders.refresh()
    activePairs = activeProviders.listCatalogModelPairs(catalog)
  } catch {
    // If active providers resolution fails, proceed with default model only
  }

  const models: ModelOption[] = []
  const seen = new Set<string>()

  for (const [, catalogProviderId, model] of activePairs) {
    if (!model.tool_call) continue
    const id = `${catalogProviderId}/${model.id}`
    if (seen.has(id)) continue
    seen.add(id)
    const provider = catalog.getProvider(catalogProviderId)
    models.push({
      id,
      name: model.name,
      providerId: catalogProviderId,
      providerName: provider?.name ?? catalogProviderId,
      description: model.description?.replace(/\s+/g, " ").trim().slice(0, 160),
      ...thinkingLevelsField(model),
    })
  }

  // Ensure every model a session can run is present in the options, the start
  // profile's first.
  const required = [...new Set([defaultModel, ...profiles.map((profile) => profile.model)])].filter(
    (modelSpec): modelSpec is string => Boolean(modelSpec),
  )
  const head: ModelOption[] = []
  for (const modelSpec of required) {
    if (seen.has(modelSpec)) continue
    seen.add(modelSpec)
    const [pId, ...rest] = modelSpec.split("/")
    const mId = rest.join("/")
    const model = pId && mId ? catalog.getModel(pId, mId) : null
    const provider = pId ? catalog.getProvider(pId) : null
    head.push({
      id: modelSpec,
      name: model?.name ?? modelSpec,
      providerId: pId,
      providerName: provider?.name ?? pId,
      description: model?.description?.replace(/\s+/g, " ").trim().slice(0, 160),
      ...(model ? thinkingLevelsField(model) : {}),
    })
  }
  models.unshift(...head)

  return models
}

/**
 * The profile named by the client's argv, if any. `--profile`/`-p` and
 * `--agent`/`-a` are aliases: the app renamed profiles to agents, and editors
 * were configured with either name. Unknown flags are ignored — the ACP client,
 * not the user, owns this argv — but a named profile flag must be usable: a
 * value-less or unparsable one is refused instead of silently starting on the
 * config default.
 */
function parseProfileFlag(argv: string[]): string | undefined {
  let profile: unknown
  let agent: unknown
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        profile: { type: "string", short: "p" },
        agent: { type: "string", short: "a" },
      },
      allowPositionals: true,
      strict: false,
    })
    profile = values.profile
    agent = values.agent
  } catch {
    if (namesProfile(argv)) throw new Error(`could not parse a profile from: ${argv.join(" ")}`)
    return undefined
  }
  // `strict: false` reports a value-less `--profile` as `true` rather than
  // throwing, so type-check it here.
  for (const [flag, value] of [
    ["--profile", profile],
    ["--agent", agent],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`${flag} needs a profile id`)
    }
  }
  if (profile && agent && profile !== agent) {
    throw new Error(`--profile "${profile}" and --agent "${agent}" are aliases; pass one`)
  }
  return (profile ?? agent) as string | undefined
}

/** Whether argv names the profile flag at all, so a parse failure is not ignored. */
function namesProfile(argv: string[]): boolean {
  return argv.some((arg) => arg === "-p" || arg === "--profile" || arg.startsWith("--profile="))
}

/**
 * Run the ACP stdio server until the client closes stdin. Returns a process
 * exit code; the caller exits with it.
 */
export async function runAcpCommand(argv: string[]): Promise<number> {
  // Sessions live in the shared runner namespace (`…/session/runners/`), the
  // same one the CLI and TUI use, so a session opened here is one the TUI
  // lists and can resume. Must run before anything reads or creates a session.
  useRunnerSessionRoot()
  const explicitProfile = parseProfileFlag(argv)
  const profiles = loadProfileOptions()
  const defaultProfile = resolveStartProfile(explicitProfile, profiles)

  // Materialize every advertised profile before serving: the bridge needs a
  // runner synchronously on a session's first prompt (so `cancel` can reach that
  // turn), and the profile selector must only offer manifests that can bind.
  // Cheap in practice — tool definitions are static module imports and skill
  // discovery is cached.
  const materialized = new Map<string, AgentDefinition>()
  for (const profile of profiles) {
    materialized.set(profile.id, await materializeAgent(resolveAgent(profile.id)))
  }
  const startAgent = materialized.get(defaultProfile)
  if (!startAgent) throw new Error(`profile "${defaultProfile}" was not materialized`)

  const config = loadConfig()
  const models = await buildAvailableModels(startAgent.model, profiles)

  await runAcpStdio({
    // Session-scoped runner: @quark/acp calls this lazily on a session's first
    // prompt and again after the client switches its profile, each time binding
    // the runner to that profile's agent. It hands back the connection's shared
    // store and any MCP tools discovered from the client's stdio servers;
    // merging them here (the app owns agent resolution) makes them callable.
    createRunner: (_cwd, store, mcpTools, profile) => {
      const agent = materialized.get(profile ?? defaultProfile) ?? startAgent
      return createRunner({
        agent: mcpTools.length > 0 ? { ...agent, tools: [...agent.tools, ...mcpTools] } : agent,
        store,
        ambientInstructions: loadAmbientInstructions,
        policies: {
          maxSteps: config.maxSteps,
          branching: config.branching,
          smallModel: config.models.small,
        },
        resolve: { providers: config.providers },
      })
    },
    // Same persistent store the CLI/TUI use — this host joins the runner
    // namespace in `useRunnerSessionRoot` above — so ACP sessions survive a
    // restart and are the ones `session/list` reports.
    store: defaultSessionStore,
    // Option B: always advertise image prompts (the plumbing maps them to
    // RunnerPromptInput.images), and reject up front with a clear error only when
    // the catalog says the model the session will actually run cannot see.
    images: true,
    imageSupport: ({ profile, model }) =>
      modelAcceptsImages(
        effectiveModel({
          profiles,
          defaults: { profile: defaultProfile, model: startAgent.model ?? "" },
          overrides: { profile, model },
        }),
      ),
    // Profile picker: advertise every manifest as the client's mode selector, so
    // a thread can switch profile — and with it the agent's tools, system prompt,
    // skills, and model — without relaunching. `--profile` picks the start.
    profiles,
    defaultProfile,
    // Model picker: advertise all tool-calling models from the catalog so the
    // client (Zed) renders a model selector in the Agent Panel.
    models,
    defaultModel: startAgent.model,
    defaultEffort: startAgent.thinkingEffort,
    log: (message) => process.stderr.write(`[quark acp] ${message}\n`),
  })
  return 0
}
