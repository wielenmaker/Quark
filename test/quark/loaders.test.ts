// App-side filesystem loaders — plugin scanning and agent-tool loading.
//
// QUARK_CONFIG_DIR pins discovery to a temp dir, so nothing touches the real
// ~/.config/quark. Temp dirs live under the repo so dynamically imported tool
// files resolve `zod` from the workspace node_modules.

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import {
  loadPluginFns,
  loadPlugins,
  createPluginContext,
  getPluginsDir,
} from "../../packages/quark/src/plugin-loader"
import { loadTools, getToolsDir } from "../../packages/quark/src/tool-loader"
import { clear as clearTools, list as listTools } from "../../packages/runner/src/tool/registry"
import { clearHooks, globalHooks } from "../../packages/runner/src/plugin/registry"

let dir: string
let previousDir: string | undefined

beforeEach(() => {
  previousDir = process.env.QUARK_CONFIG_DIR
  dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-quark-loaders-"))
  process.env.QUARK_CONFIG_DIR = dir
})

afterEach(() => {
  if (previousDir === undefined) delete process.env.QUARK_CONFIG_DIR
  else process.env.QUARK_CONFIG_DIR = previousDir
  fs.rmSync(dir, { recursive: true, force: true })
  clearTools()
  clearHooks()
})

function writePlugin(name: string, body: string): void {
  const plugins = path.join(dir, "plugins")
  fs.mkdirSync(plugins, { recursive: true })
  fs.writeFileSync(path.join(plugins, name), body)
}

function writeTool(name: string, body: string): void {
  const tools = path.join(dir, "tools")
  fs.mkdirSync(tools, { recursive: true })
  fs.writeFileSync(path.join(tools, name), body)
}

describe("plugin loader", () => {
  test("directories follow QUARK_CONFIG_DIR", () => {
    expect(getPluginsDir()).toBe(path.join(dir, "plugins"))
    expect(getToolsDir()).toBe(path.join(dir, "tools"))
  })

  test("missing plugins dir yields empty result", async () => {
    const result = await loadPluginFns()
    expect(result).toEqual({ fns: [], loaded: [], errors: [] })
  })

  test("scans *.ts and returns callable PluginFns", async () => {
    writePlugin("hello.ts", `
      export default async () => ({ "session.idle": async () => {} })
    `)

    const { fns, loaded, errors } = await loadPluginFns()
    expect(loaded).toEqual(["hello.ts"])
    expect(errors).toEqual([])
    expect(fns).toHaveLength(1)

    const handlers = await fns[0]!(createPluginContext())
    expect(typeof handlers["session.idle"]).toBe("function")
  })

  test("reports files without a plugin export", async () => {
    writePlugin("bad.ts", `export const notAPlugin = 1`)

    const { fns, errors } = await loadPluginFns()
    expect(fns).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.file).toBe("bad.ts")
  })

  test("loadPlugins registers returned hooks on the process-global registry", async () => {
    writePlugin("patch.ts", `
      export default async () => ({
        "provider.request.before": async (_input, output) => { output.model = "patched" },
      })
    `)

    const result = await loadPlugins()
    expect(result.loaded).toEqual(["patch.ts"])

    const output = await globalHooks.fire("provider.request.before", {
      provider: "openai",
      model: "gpt-4o",
      messages: [],
    })
    expect(output.model).toBe("patched")
  })
})

describe("agent tool loader", () => {
  test("built-in ids are skipped without touching disk", async () => {
    const result = await loadTools(["read", "look", "skill"])
    expect(result).toEqual({ loaded: [], missing: [], errors: [], defs: [] })
  })

  test("loads a valid tool definition from <config>/tools", async () => {
    writeTool("echo.ts", `
      import { z } from "zod"
      export default {
        id: "echo",
        description: "Echo the text",
        parameters: z.object({ text: z.string() }),
        async execute(args) { return { title: "echo", output: args.text, metadata: {} } },
      }
    `)

    const { defs, loaded, errors } = await loadTools(["echo"], { register: false })
    expect(errors).toEqual([])
    expect(loaded).toEqual(["echo"])
    expect(defs.map((d) => d.id)).toEqual(["echo"])
    // register:false must not touch the global registry.
    expect(listTools()).toEqual([])
  })

  test("register:true adds the tool to the global registry", async () => {
    writeTool("echo.ts", `
      import { z } from "zod"
      export default {
        id: "echo",
        description: "Echo the text",
        parameters: z.object({ text: z.string() }),
        async execute() { return { title: "echo", output: "", metadata: {} } },
      }
    `)

    await loadTools(["echo"])
    expect(listTools().map((t) => t.id)).toEqual(["echo"])
  })

  test("missing tool file is reported as missing", async () => {
    const result = await loadTools(["ghost"], { register: false })
    expect(result.missing).toEqual(["ghost"])
    expect(result.errors).toEqual([])
  })

  test("filename/id mismatch is an error, not a load", async () => {
    writeTool("echo.ts", `
      import { z } from "zod"
      export default {
        id: "different",
        description: "Mismatch",
        parameters: z.object({}),
        async execute() { return { title: "x", output: "", metadata: {} } },
      }
    `)

    const result = await loadTools(["echo"], { register: false })
    expect(result.loaded).toEqual([])
    expect(result.defs).toEqual([])
    expect(result.errors[0]!.error).toContain("does not match filename")
  })
})
