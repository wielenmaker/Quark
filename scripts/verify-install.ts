#!/usr/bin/env bun
// Verify the currently installed Quark under <root> (default
// ~/.local/share/quark) without touching it. Same checks the installer runs
// before switching `current`.
//
//   bun scripts/verify-install.ts [--root <dir>]

import { existsSync, readlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { findNode, verifyVersion } from "./install-local"

const argv = process.argv.slice(2)
let root = process.env.QUARK_HOME?.trim() || join(process.env.HOME ?? "~", ".local", "share", "quark")
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--root") root = resolve(argv[++i] ?? "")
  else {
    console.error(`Unknown option: ${argv[i]}`)
    process.exit(2)
  }
}

let current: string
try {
  // `current` is a relative symlink (so the install root stays copyable);
  // resolve it against the root for both relative and absolute targets.
  current = resolve(root, readlinkSync(join(root, "current")))
} catch {
  console.error(`✗ no installed version found at ${root}/current`)
  process.exit(1)
}

const node = findNode()
const { checks, failed } = verifyVersion(current, node)
console.log(`Quark install at ${current}\n`)
for (const check of checks) {
  console.log(`  ${check.ok ? "✓" : "✗"} ${check.label.padEnd(16)} ${check.detail}`)
}
console.log()
if (failed > 0) {
  console.error(`✗ ${failed} check(s) failed`)
  process.exit(1)
}
if (!existsSync(join(root, "current"))) {
  console.error("✗ current pointer missing")
  process.exit(1)
}
console.log("✓ install looks healthy")
