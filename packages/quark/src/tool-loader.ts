// Tool loader — load agent-declared tools from <config>/tools/
//
// App-side filesystem adapter: discovery/import lives here, while the ToolDef
// contract and registry live in `@quark/runner` (tool/tool, tool/registry).
//
// Tools are loaded by ID from an agent's tools[] array.
// Each tool lives at <config>/tools/{id}.ts
// Notifications surface any load failures.

import * as fs from "fs"
import * as path from "path"
import { pathToFileURL } from "url"
import { register, validateTool } from "@quark/runner"
import { configDir } from "./config/config"
import { error as notifyError, warn as notifyWarn } from "@quark/runner/notification/notification"
import type { ToolDef } from "@quark/runner/tool/tool"

/** Tools directory, resolved per call so QUARK_CONFIG_DIR stays authoritative. */
function toolsDir(): string {
  return path.join(configDir(), "tools")
}

// Built-in tools (registered by bootstrap, not loaded from disk)
const BUILTIN_TOOLS = new Set(["read", "look", "skill"])

export interface LoadResult {
  loaded: string[]
  missing: string[]
  errors: Array<{ id: string; error: string }>
  /**
   * Concrete tool definitions that were loaded. Populated whether or not the
   * tools were registered, so the portable AgentDefinition path can carry them
   * without touching the global registry.
   */
  defs: ToolDef[]
}

/**
 * Load tools declared in an agent's tools[] array.
 * Each tool is loaded from <config>/tools/{id}.ts
 * Built-in tools (read, look, skill) are skipped.
 *
 * @param opts.register - When `false`, return concrete definitions in
 *   {@link LoadResult.defs} without registering them globally. Used by the
 *   portable AgentDefinition path.
 */
export async function loadTools(
  toolIds: string[],
  opts: { register?: boolean } = {},
): Promise<LoadResult> {
  const dir = toolsDir()
  const result: LoadResult = {
    loaded: [],
    missing: [],
    errors: [],
    defs: [],
  }

  // Filter out built-in tools
  const toLoad = toolIds.filter((id) => !BUILTIN_TOOLS.has(id))

  if (toLoad.length === 0) {
    return result
  }

  // Check if tools directory exists
  if (!fs.existsSync(dir)) {
    // All tools are missing
    for (const id of toLoad) {
      result.missing.push(id)
      notifyError("Tool Not Found", `'${id}' — ~/.config/quark/tools/ does not exist`)
    }
    return result
  }

  // Load each declared tool
  for (const id of toLoad) {
    const filePath = path.join(dir, `${id}.ts`)

    // Check file exists
    if (!fs.existsSync(filePath)) {
      result.missing.push(id)
      notifyWarn("Tool Not Found", `'${id}' — create ~/.config/quark/tools/${id}.ts`)
      continue
    }

    try {
      // Dynamic import — use file:// URL for Windows compatibility.
      // On Windows, bare absolute paths like "C:\..." are rejected by
      // Node's ESM loader which interprets "C:" as a URL protocol.
      const importURL = pathToFileURL(filePath).href
      const module = await import(importURL)

      // Look for default export or named 'tool' export
      const toolDef: ToolDef | undefined = module.default ?? module.tool

      if (!toolDef) {
        const msg = "No tool export found (expected 'default' or 'tool')"
        result.errors.push({ id, error: msg })
        notifyError("Tool Load Failed", `${id}: ${msg}`)
        continue
      }

      // Validate the tool definition
      const validationError = validateTool(toolDef)
      if (validationError) {
        const msg = `${validationError.field}: ${validationError.message}`
        result.errors.push({ id, error: msg })
        notifyError("Tool Invalid", `${id}: ${msg}`)
        continue
      }

      // Check ID matches filename
      if (toolDef.id !== id) {
        const msg = `Tool ID '${toolDef.id}' does not match filename '${id}.ts'`
        result.errors.push({ id, error: msg })
        notifyError("Tool ID Mismatch", msg)
        continue
      }

      // Register the tool (unless the caller wants the concrete defs only)
      if (opts.register !== false) {
        const registerResult = register(toolDef)
        if (!registerResult.ok) {
          const msg = registerResult.error.message
          result.errors.push({ id, error: msg })
          notifyError("Tool Registration Failed", `${id}: ${msg}`)
          continue
        }
      }

      result.defs.push(toolDef)
      result.loaded.push(id)
    } catch (err) {
      // Import/syntax error
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push({ id, error: msg })
      notifyError("Tool Load Error", `${id}: ${msg}`, 5000)
    }
  }

  return result
}

/**
 * Get the tools directory path
 */
export function getToolsDir(): string {
  return toolsDir()
}
