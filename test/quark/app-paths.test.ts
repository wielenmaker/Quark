// App location resolution — installed vs development layouts, overrides, and
// the subagent child command. Fixture URLs simulate an installed package
// without touching the real checkout.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  resolveAppPaths,
  resolveSubagentExecutable,
} from "../../packages/quark/src/app-paths"

const directories: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "quark-app-paths-"))
  directories.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A minimal installed package: <dir>/app/{package.json,dist/cli.js,dist/tui.js}. */
function installedPackage(): { appRoot: string; cliModuleUrl: string } {
  const root = join(fixture(), "app")
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "quark" }))
  writeFileSync(join(root, "dist", "cli.js"), "// fixture")
  writeFileSync(join(root, "dist", "tui.js"), "// fixture")
  return { appRoot: root, cliModuleUrl: pathToFileURL(join(root, "dist", "cli.js")).href }
}

describe("resolveAppPaths", () => {
  test("development run resolves the checkout package root", () => {
    const paths = resolveAppPaths({})
    expect(paths.mode).toBe("development")
    expect(paths.appRoot.endsWith(join("packages", "quark"))).toBe(true)
    expect(paths.cliEntry).toBe(join(paths.appRoot, "src", "cli.ts"))
    expect(paths.tuiEntry).toBe(join(paths.appRoot, "dist", "tui.js"))
    expect(existsSync(paths.preloadEntry)).toBe(true)
  })

  test("installed run resolves from the package's own dist directory", () => {
    const { appRoot, cliModuleUrl } = installedPackage()
    const paths = resolveAppPaths({}, cliModuleUrl)
    expect(paths.mode).toBe("installed")
    expect(paths.appRoot).toBe(appRoot)
    expect(paths.cliEntry).toBe(join(appRoot, "dist", "cli.js"))
    expect(paths.tuiEntry).toBe(join(appRoot, "dist", "tui.js"))
  })

  test("QUARK_DIR overrides the discovered root", () => {
    const { appRoot } = installedPackage()
    const paths = resolveAppPaths({ QUARK_DIR: appRoot } as NodeJS.ProcessEnv)
    expect(paths.appRoot).toBe(appRoot)
  })
})

describe("resolveSubagentExecutable", () => {
  test("installed: same interpreter, absolute cli.js", () => {
    const { appRoot, cliModuleUrl } = installedPackage()
    const paths = resolveAppPaths({}, cliModuleUrl)
    const command = resolveSubagentExecutable({}, "/usr/bin/node", paths)
    expect(command).toEqual({ command: "/usr/bin/node", args: [join(appRoot, "dist", "cli.js")] })
  })

  test("development: bun runs the source CLI with the solid preload", () => {
    const paths = resolveAppPaths({})
    const command = resolveSubagentExecutable({}, join(tmpdir(), "bun"), paths)
    expect(command.command).toBe(join(tmpdir(), "bun"))
    expect(command.args).toEqual(["--preload", paths.preloadEntry, paths.cliEntry])
  })

  test("QUARK_SUBAGENT_EXECUTABLE wins and passes no extra args", () => {
    const command = resolveSubagentExecutable({ QUARK_SUBAGENT_EXECUTABLE: "/x/child" } as NodeJS.ProcessEnv)
    expect(command).toEqual({ command: "/x/child", args: [] })
  })
})
