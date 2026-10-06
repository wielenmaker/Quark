// `quark doctor` — one-screen diagnosis of a running setup.
//
// Checks the things that actually break real installs: where the app runs
// from, runtime binaries, config/profile discovery, tool file health, session
// storage, and the subagent child command. Read-only; exit code 1 only when a
// hard failure is found.

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { getSessionStorageRoot } from "@quark/runner/storage/session-path"
import { listAgents } from "./agent/agent"
import { configDir, configPath, loadConfig } from "./config/config"
import {
  findBun,
  findExecutable,
  resolveAppPaths,
  resolveSubagentExecutable,
  type AppPaths,
} from "./app-paths"

type Status = "ok" | "warn" | "fail"

interface Row {
  status: Status
  label: string
  detail: string
}

const ICONS: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" }

function appVersion(paths: AppPaths): string {
  try {
    const pkg = JSON.parse(readFileSync(join(paths.appRoot, "package.json"), "utf8")) as { version?: string }
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

/** Import a tool file; returns the first error line, or undefined on success. */
async function importFailure(file: string): Promise<string | undefined> {
  try {
    await import(pathToFileURL(file).href)
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.split("\n")[0]!.slice(0, 160)
  }
}

function listToolFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /\.(ts|js)$/.test(name) && !name.endsWith(".d.ts"))
    .map((name) => join(dir, name))
    .sort()
}

async function toolRows(paths: AppPaths): Promise<Row[]> {
  const rows: Row[] = []
  const personalDir = join(configDir(), "tools")
  const personal = listToolFiles(personalDir)
  // Prefer compiled bundled tools when present: Node refuses to type-strip
  // `.ts` files inside node_modules, so an installed app must never import
  // its own source tools.
  const distTools = listToolFiles(join(paths.appRoot, "dist", "tools"))
  const bundled = distTools.length > 0
    ? distTools
    : listToolFiles(join(paths.appRoot, "tools"))

  const name = (file: string) => file.split("/").pop() ?? file
  rows.push({
    status: "ok",
    label: "tools",
    detail: `${personal.length} personal (${personalDir}) · ${bundled.length} bundled`,
  })

  // Personal tools failing to load is a user-facing warning; a bundled tool
  // failing to load is a broken build.
  const checks: Array<{ file: string; status: Status }> = [
    ...personal.map((file) => ({ file, status: "warn" as Status })),
    ...bundled.map((file) => ({ file, status: "fail" as Status })),
  ]
  let failures = 0
  for (const check of checks) {
    const failure = await importFailure(check.file)
    if (failure) {
      failures += 1
      rows.push({ status: check.status, label: "tool", detail: `${name(check.file)} — ${failure}` })
    }
  }
  if (failures === 0 && checks.length > 0) {
    rows.push({ status: "ok", label: "tool load", detail: `all ${checks.length} files import cleanly` })
  }

  const hasGrepTool = [...personal, ...bundled].some((file) => name(file).startsWith("grep."))
  if (hasGrepTool) {
    const rg = findRipgrep()
    if (rg) rows.push({ status: "ok", label: "ripgrep", detail: rg })
    else rows.push({ status: "warn", label: "ripgrep", detail: "grep tool needs `rg` — install it: brew install ripgrep" })
  }
  return rows
}

/**
 * `rg` from PATH, falling back to the standard Homebrew locations: GUI apps
 * and non-login shells don't inherit the `brew shellenv` PATH entry that the
 * login shell sets in .zprofile.
 */
function findRipgrep(): string | undefined {
  const onPath = findExecutable("rg")
  if (onPath) return onPath
  for (const candidate of ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function runDoctorCommand(_argv: string[] = []): Promise<number> {
  const rows: Row[] = []
  const paths = resolveAppPaths()

  rows.push({ status: "ok", label: "app", detail: `${paths.mode} · ${paths.appRoot} · v${appVersion(paths)}` })
  if (process.env.QUARK_DIR) {
    rows.push({ status: "warn", label: "QUARK_DIR", detail: `override active → ${process.env.QUARK_DIR}` })
  }

  const underBun = typeof (process.versions as { bun?: string }).bun === "string"
  rows.push({ status: "ok", label: "node", detail: `${process.version}${underBun ? " · running under bun" : ""}` })

  const bun = findBun()
  if (bun) {
    const version = spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "?"
    rows.push({ status: "ok", label: "bun", detail: `${version} · ${bun}` })
  } else {
    rows.push({ status: "warn", label: "bun", detail: "not found — the interactive TUI needs it (https://bun.sh)" })
  }

  if (existsSync(paths.cliEntry)) rows.push({ status: "ok", label: "cli", detail: paths.cliEntry })
  else rows.push({ status: "fail", label: "cli", detail: `missing: ${paths.cliEntry}` })

  if (existsSync(paths.tuiEntry)) rows.push({ status: "ok", label: "tui", detail: paths.tuiEntry })
  else rows.push({ status: "fail", label: "tui", detail: `missing: ${paths.tuiEntry} (run \`bun run build\` in development)` })

  try {
    const config = loadConfig()
    const agents = listAgents()
    rows.push({
      status: "ok",
      label: "config",
      detail: `${configPath()} · ${agents.length} agents · default ${config.defaultAgent ?? "coder"}`,
    })
  } catch (error) {
    rows.push({ status: "fail", label: "config", detail: error instanceof Error ? error.message : String(error) })
  }

  rows.push(...(await toolRows(paths)))

  const sessionsDir = join(getSessionStorageRoot(), "runners")
  try {
    const count = existsSync(sessionsDir) ? readdirSync(sessionsDir).length : 0
    rows.push({ status: "ok", label: "sessions", detail: `${sessionsDir} · ${count} stored` })
  } catch {
    rows.push({ status: "warn", label: "sessions", detail: `${sessionsDir} · unreadable` })
  }

  const subagent = resolveSubagentExecutable()
  const target = subagent.args[subagent.args.length - 1] ?? "(none)"
  rows.push({
    status: existsSync(target) ? "ok" : "fail",
    label: "subagent",
    detail: `${subagent.command} ${target}`,
  })

  const fails = rows.filter((row) => row.status === "fail").length
  const warns = rows.filter((row) => row.status === "warn").length

  console.log("\nQuark doctor\n")
  for (const row of rows) {
    console.log(`  ${ICONS[row.status]} ${row.label.padEnd(9)} ${row.detail}`)
  }
  console.log(`\n  ${rows.length} checks · ${fails} failed · ${warns} warning${warns === 1 ? "" : "s"}\n`)
  return fails > 0 ? 1 : 0
}
