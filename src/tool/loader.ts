// Tool loader — load profile-declared tools from ~/.config/quark/tools/
//
// Tools are loaded by ID from the profile's tools[] array.
// Each tool lives at ~/.config/quark/tools/{id}.ts
// Notifications surface any load failures.

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { pathToFileURL } from "url"
import { register, validateTool, type ToolValidationError } from "./registry"
import { error as notifyError, warn as notifyWarn } from "../notification/notification"
import type { ToolDef } from "./tool"

const DEFAULT_TOOLS_DIR = path.join(os.homedir(), ".config", "quark", "tools")

// Test seam: allows tests to point the loader at a tmp directory.
// Production code should always use getToolsDir() — never read this directly.
let _toolsDirOverride: string | null = null

export function setToolsDir(dir: string | null): void {
  _toolsDirOverride = dir
}

// Built-in tools (registered by bootstrap, not loaded from disk)
export const BUILTIN_TOOLS = new Set(["read", "look", "skill", "question", "find_session", "read_session"])

export interface LoadResult {
  loaded: string[]
  missing: string[]
  errors: Array<{ id: string; error: string }>
}

/**
 * Load tools declared in a profile's tools[] array.
 * Each tool is loaded from ~/.config/quark/tools/{id}.ts
 * Built-in tools (read, skill) are skipped.
 */
export async function loadProfileTools(toolIds: string[]): Promise<LoadResult> {
  const result: LoadResult = {
    loaded: [],
    missing: [],
    errors: [],
  }

  // Filter out built-in tools
  const toLoad = toolIds.filter((id) => !BUILTIN_TOOLS.has(id))

  if (toLoad.length === 0) {
    return result
  }

  // Check if tools directory exists
  if (!fs.existsSync(getToolsDir())) {
    // All tools are missing
    for (const id of toLoad) {
      result.missing.push(id)
      notifyError("Tool Not Found", `'${id}' — ~/.config/quark/tools/ does not exist`)
    }
    return result
  }

  // Load each declared tool
  for (const id of toLoad) {
    const filePath = path.join(getToolsDir(), `${id}.ts`)

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

      // Register the tool
      const registerResult = register(toolDef)
      if (!registerResult.ok) {
        const msg = registerResult.error.message
        result.errors.push({ id, error: msg })
        notifyError("Tool Registration Failed", `${id}: ${msg}`)
        continue
      }

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
 * Get the tools directory path. Honors the test override; otherwise
 * returns the default `~/.config/quark/tools/`.
 */
export function getToolsDir(): string {
  return _toolsDirOverride ?? DEFAULT_TOOLS_DIR
}
