#!/usr/bin/env bun
// Install Quark locally from this checkout — no registry, no global CLI tool
// in between. Packs the three workspace packages, installs them with their
// dependencies into a versioned app tree, verifies the result, and only then
// switches the `current` pointer.
//
//   bun scripts/install-local.ts [--no-build] [--name <tag>]
//   bun scripts/install-local.ts --list
//   bun scripts/install-local.ts --use <version>
//   bun scripts/install-local.ts --rollback
//
// Layout (root defaults to ~/.local/share/quark; QUARK_HOME overrides):
//   <root>/versions/<stamp>/packages/   packed tarballs (reinstallable)
//   <root>/versions/<stamp>/app/        installed package tree (deps included)
//   <root>/versions/<stamp>/manifest.json
//   <root>/current -> versions/<stamp>  switched only after verification
//   <bin-dir>/quark                     launcher (default ~/.local/bin)
//
// The config dir (~/.config/quark) is never touched.

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const PACKAGE_DIRS = {
  runner: "packages/runner",
  acp: "packages/acp",
  quark: "packages/quark",
} as const
type PackageKey = keyof typeof PACKAGE_DIRS
type Tarballs = Record<PackageKey, string>

const LAUNCHER_MARKER = "Quark launcher"

export interface Options {
  build: boolean
  name?: string
  root: string
  binDir: string
  list: boolean
  rollback: boolean
  use?: string
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    build: true,
    root: process.env.QUARK_HOME?.trim() || join(homedir(), ".local", "share", "quark"),
    binDir: process.env.QUARK_BIN_DIR?.trim() || join(homedir(), ".local", "bin"),
    list: false,
    rollback: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case "--no-build":
        options.build = false
        break
      case "--name":
        options.name = argv[++i]
        break
      case "--root":
        options.root = resolve(argv[++i] ?? "")
        break
      case "--bin-dir":
        options.binDir = resolve(argv[++i] ?? "")
        break
      case "--list":
        options.list = true
        break
      case "--rollback":
        options.rollback = true
        break
      case "--use":
        options.use = argv[++i]
        break
      default:
        fail(`Unknown option: ${arg}`)
    }
  }
  return options
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

function run(command: string, args: string[], options: { cwd?: string } = {}): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    fail(`Command failed (${result.status}): ${command} ${args.join(" ")}\n${detail}`)
  }
  return result
}

const BUN = process.execPath

function assertBun(): void {
  if (typeof (process.versions as { bun?: string }).bun !== "string") {
    fail("Run this script with Bun: `bun scripts/install-local.ts`")
  }
}

export function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Node.js ≥ 20 on PATH; the installed CLI runs under Node. */
export function findNode(): string {
  const node = findOnPath("node")
  if (!node) fail("Node.js 20+ is required on PATH to launch the installed CLI")
  const version = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? ""
  const major = Number(version.replace(/^v/, "").split(".")[0])
  if (!Number.isFinite(major) || major < 20) fail(`Node.js 20+ is required, found ${version || "unknown"}`)
  return node
}

function stamp(name?: string): string {
  if (name) return name
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

function gitSha(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : "nogit"
}

function build(): void {
  console.log("• building packages …")
  const result = spawnSync(BUN, ["run", "build"], { cwd: REPO, stdio: "inherit" })
  if (result.status !== 0) fail(`build failed (exit ${result.status})`)
}

function pack(versionDir: string): Tarballs {
  const tarballs = {} as Tarballs
  for (const key of Object.keys(PACKAGE_DIRS) as PackageKey[]) {
    const destination = join(versionDir, "packages", key)
    mkdirSync(destination, { recursive: true })
    console.log(`• packing ${key} …`)
    const cwd = join(REPO, PACKAGE_DIRS[key])
    let result = spawnSync(BUN, ["pm", "pack", "--destination", destination], { cwd, encoding: "utf8" })
    if (result.status !== 0) {
      // Fall back to npm when `bun pm pack` is unavailable for this package.
      result = spawnSync("npm", ["pack", "--silent", "--pack-destination", destination], { cwd, encoding: "utf8" })
    }
    if (result.status !== 0) fail(`packing ${key} failed:\n${result.stdout}\n${result.stderr}`)
    const produced = readdirSync(destination).filter((file) => file.endsWith(".tgz"))
    if (produced.length !== 1) fail(`expected exactly one tarball for ${key}, found: ${produced.join(", ") || "none"}`)
    tarballs[key] = join(destination, produced[0]!)
  }
  return tarballs
}

function writeAppPackageJson(versionDir: string, tarballs: Tarballs): void {
  const appDir = join(versionDir, "app")
  mkdirSync(appDir, { recursive: true })
  const spec = (file: string) => `file:${relative(appDir, file)}`
  const runner = spec(tarballs.runner)
  const acp = spec(tarballs.acp)
  const manifest = {
    name: "quark-local-install",
    private: true,
    dependencies: {
      "@quark/runner": runner,
      "@quark/acp": acp,
      quark: spec(tarballs.quark),
    },
    // The local tarballs satisfy the workspace package deps; bun reads
    // `overrides`, npm reads `overrides`, yarn/pnpm read `resolutions`.
    overrides: { "@quark/runner": runner, "@quark/acp": acp },
    resolutions: { "@quark/runner": runner, "@quark/acp": acp },
  }
  writeFileSync(join(appDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

function installApp(versionDir: string): void {
  console.log("• installing dependencies into the app tree …")
  const result = spawnSync(BUN, ["install", "--production"], {
    cwd: join(versionDir, "app"),
    stdio: "inherit",
  })
  if (result.status !== 0) fail(`dependency install failed (exit ${result.status})`)
}

const SINGLETON_CHECK = `
import { TypedBus as RootBus, createRunner } from "@quark/runner";
import { TypedBus as SubBus } from "@quark/runner/session/events";
if (typeof createRunner !== "function" || RootBus !== SubBus) {
  throw new Error("@quark/runner root/subpath exports broken or duplicated");
}
console.log("ok");
`

export interface Check {
  ok: boolean
  label: string
  detail: string
}

/** Boot checks for one installed version; never touches the current pointer. */
export function verifyVersion(versionDir: string, node: string): { checks: Check[]; failed: number } {
  const appDir = join(versionDir, "app")
  const packageRoot = join(appDir, "node_modules", "quark")
  const cli = join(packageRoot, "dist", "cli.js")
  const checks: Check[] = []
  const check = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail })

  // A clean env: QUARK_DIR from the caller's shell must not leak into checks.
  const env = { ...process.env }
  delete env.QUARK_DIR

  check(existsSync(cli), "cli entry", cli)
  check(existsSync(join(packageRoot, "dist", "tui.js")), "tui entry", "dist/tui.js")
  const toolsDir = join(packageRoot, "dist", "tools")
  const toolCount = existsSync(toolsDir) ? readdirSync(toolsDir).filter((f) => f.endsWith(".js")).length : 0
  check(toolCount > 0, "bundled tools", `${toolCount} compiled tools`)

  if (existsSync(cli)) {
    const help = spawnSync(node, [cli, "--help"], { cwd: tmpdir(), encoding: "utf8", env })
    check(help.status === 0, "cli boots", `--help → exit ${help.status}`)

    const doctor = spawnSync(node, [cli, "doctor"], { cwd: tmpdir(), encoding: "utf8", env })
    check(doctor.status === 0, "doctor", `exit ${doctor.status}`)
    if (doctor.status !== 0) {
      check(false, "doctor output", (doctor.stdout ?? "").split("\n").slice(0, 20).join("\n"))
    }

    const singleton = spawnSync(node, ["--input-type=module", "-e", SINGLETON_CHECK], {
      cwd: appDir,
      encoding: "utf8",
      env,
    })
    check(singleton.status === 0, "runner singleton", "root and subpath resolve to one instance")
  }

  return { checks, failed: checks.filter((c) => !c.ok).length }
}

function writeManifest(versionDir: string, name: string, node: string): void {
  const manifest = {
    name,
    git: gitSha(),
    node,
    bun: BUN,
    installedAt: new Date().toISOString(),
  }
  writeFileSync(join(versionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Atomically point `<root>/current` at `versionDir` (relative link: copyable). */
function switchCurrent(root: string, versionDir: string): void {
  const link = join(root, "current")
  const staging = join(root, `.current-${process.pid}`)
  rmSync(staging, { force: true, recursive: true })
  symlinkSync(relative(root, versionDir), staging)
  renameSync(staging, link)
}

function listVersions(root: string): string[] {
  const dir = join(root, "versions")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
}

function currentVersion(root: string): string | undefined {
  try {
    return readlinkSync(join(root, "current")).split("/").pop()
  } catch {
    return undefined
  }
}

function writeLauncher(binDir: string, root: string, node: string): string {
  mkdirSync(binDir, { recursive: true })
  const launcher = join(binDir, "quark")
  const existing = lstatSync(launcher, { throwIfNoEntry: false })
  if (existing) {
    if (existing.isSymbolicLink()) {
      // Older installs (and stale links into deleted checkouts) are symlinks;
      // replace them with the launcher script.
      console.log(`• replacing existing symlink ${launcher}`)
      rmSync(launcher, { force: true })
    } else {
      let isOurs = false
      try {
        isOurs = readFileSync(launcher, "utf8").includes(LAUNCHER_MARKER)
      } catch {
        // unreadable regular file → refuse below
      }
      if (!isOurs) {
        fail(`refusing to overwrite ${launcher} (not created by this installer); remove it or pass --bin-dir`)
      }
    }
  }
  const content = `#!/bin/sh
# Quark launcher — installed by scripts/install-local.ts. Runs the "current"
# version under the install root; QUARK_HOME overrides the root at runtime.
set -eu
ROOT="\${QUARK_HOME:-${root}}"
CLI="$ROOT/current/app/node_modules/quark/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "Quark is not installed correctly (missing $CLI)." >&2
  echo "Reinstall with: bun ${REPO}/scripts/install-local.ts" >&2
  exit 1
fi
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE="${node}"
exec "$NODE" "$CLI" "$@"
`
  writeFileSync(launcher, content, { mode: 0o755 })
  return launcher
}

function rollback(options: Options): void {
  const versions = listVersions(options.root)
  const current = currentVersion(options.root)
  const index = current ? versions.indexOf(current) : -1
  const previous = versions[index + 1]
  if (!previous) fail(`no previous version to roll back to (versions: ${versions.join(", ") || "none"})`)
  switchCurrent(options.root, join(options.root, "versions", previous!))
  console.log(`✓ rolled back: ${current ?? "(none)"} → ${previous}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  assertBun()

  if (options.list) {
    const versions = listVersions(options.root)
    const current = currentVersion(options.root)
    if (versions.length === 0) {
      console.log(`no versions installed under ${options.root}`)
      return
    }
    for (const version of versions) console.log(`  ${version === current ? "*" : " "} ${version}`)
    return
  }
  if (options.rollback) {
    rollback(options)
    return
  }
  if (options.use) {
    const target = join(options.root, "versions", options.use)
    if (!existsSync(target)) fail(`version not found: ${options.use}`)
    switchCurrent(options.root, target)
    writeLauncher(options.binDir, options.root, findNode())
    console.log(`✓ switched to ${options.use}`)
    return
  }

  const node = findNode()
  mkdirSync(join(options.root, "versions"), { recursive: true })
  if (options.build) build()

  const name = stamp(options.name)
  const versionDir = join(options.root, "versions", name)
  if (existsSync(versionDir)) fail(`version directory already exists: ${versionDir} (pick another --name)`)

  const tarballs = pack(versionDir)
  writeAppPackageJson(versionDir, tarballs)
  installApp(versionDir)

  console.log("• verifying the installed version …")
  const { checks, failed } = verifyVersion(versionDir, node)
  for (const check of checks) {
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.label.padEnd(16)} ${check.detail}`)
  }
  if (failed > 0) fail(`verification failed (${failed} checks); "current" was NOT switched. Inspect ${versionDir}`)

  writeManifest(versionDir, name, node)
  switchCurrent(options.root, versionDir)
  const launcher = writeLauncher(options.binDir, options.root, node)

  console.log(`\n✓ Quark ${name} installed\n`)
  console.log(`  app      ${versionDir}/app`)
  console.log(`  command  ${launcher} → current`)
  console.log(`  config   ~/.config/quark (untouched)`)
  if (!(process.env.PATH ?? "").split(":").includes(options.binDir)) {
    console.log(`\n  note: ${options.binDir} is not on PATH — add it to your shell profile.`)
  }
  console.log(`\n  next: quark doctor && quark\n`)
}

if (import.meta.main) await main()
