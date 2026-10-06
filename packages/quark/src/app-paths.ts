// App location resolution — one source of truth for where the running app's
// files live, in both the checkout (development) and an installed package
// (`node_modules/quark`).
//
// Previously the CLI/TUI/subagents guessed locations from `argv1` paths and a
// required QUARK_DIR. Now normal use resolves everything from this module's
// own location: Bun bundles it into `dist/cli.js` and `dist/tui.js`, so
// `import.meta.url` always points at the real app once built.
//
//   - QUARK_DIR stays supported as an explicit override (tests, benchmarks).
//   - The subagent child command is computed here and handed to the runner,
//     so the engine no longer guesses paths at spawn time.

import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

export type AppMode = "development" | "installed"

export interface AppPaths {
  mode: AppMode
  /** Package root: the directory containing package.json, dist/, tools/. */
  appRoot: string
  /** CLI entry: `src/cli.ts` in development, `dist/cli.js` when installed. */
  cliEntry: string
  /** Compiled TUI entry; both modes require a build. */
  tuiEntry: string
  /** Bun preload required by source-mode runs. */
  preloadEntry: string
}

/** Direct child command for subagents, matching the runner's SubagentCommand. */
export interface SubagentExecutable {
  command: string
  args: string[]
}

const APP_PACKAGE_NAME = "quark"
const ROOT_SEARCH_DEPTH = 8

function packageNameAt(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }
    return typeof pkg.name === "string" ? pkg.name : undefined
  } catch {
    return undefined
  }
}

/** Nearest ancestor directory whose package.json is the Quark app package. */
function findAppRoot(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (let depth = 0; depth < ROOT_SEARCH_DEPTH; depth += 1) {
    if (packageNameAt(dir) === APP_PACKAGE_NAME) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First executable named `name` on PATH, or undefined. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** `bun` from QUARK_BUN or PATH, falling back to standard install dirs. */
export function findBun(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.QUARK_BUN?.trim()
  if (override && isExecutable(override)) return override
  const onPath = findExecutable("bun", env)
  if (onPath) return onPath
  for (const candidate of [
    join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the running app's layout.
 *
 * @param env - environment; `QUARK_DIR` overrides the discovered app root.
 * @param moduleUrl - this module's URL. Tests pass fixture URLs to exercise
 *   the installed layout without an actual install.
 */
export function resolveAppPaths(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): AppPaths {
  const moduleDir = dirname(fileURLToPath(moduleUrl))
  const override = env.QUARK_DIR?.trim()
  const appRoot = override || findAppRoot(moduleDir) || resolve(moduleDir, "..")
  // Bundled entries live in `dist/`; anything else (`src/cli.ts`,
  // `src/tui/index.tsx`) is an unbundled source run under Bun.
  const mode: AppMode = basename(moduleDir) === "dist" ? "installed" : "development"
  return {
    mode,
    appRoot,
    cliEntry: mode === "installed"
      ? join(appRoot, "dist", "cli.js")
      : join(appRoot, "src", "cli.ts"),
    tuiEntry: join(appRoot, "dist", "tui.js"),
    preloadEntry: join(appRoot, "preload.ts"),
  }
}

/**
 * The command the runner spawns for subagents: this same CLI, launched by
 * whatever runtime is already executing it. Embedders who call `createRunner`
 * directly keep the old auto-detection unless they opt into this.
 */
export function resolveSubagentExecutable(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  paths: AppPaths = resolveAppPaths(env),
): SubagentExecutable {
  if (env.QUARK_SUBAGENT_EXECUTABLE) {
    return { command: env.QUARK_SUBAGENT_EXECUTABLE, args: [] }
  }
  if (paths.mode === "development") {
    const args: string[] = []
    if (existsSync(paths.preloadEntry)) args.push("--preload", paths.preloadEntry)
    args.push(paths.cliEntry)
    // Source mode needs Bun; fall back to a discovered binary if the caller is
    // somehow running under Node.
    const runtime = basename(execPath).startsWith("bun") ? execPath : findBun(env) ?? execPath
    return { command: runtime, args }
  }
  return { command: execPath, args: [paths.cliEntry] }
}
