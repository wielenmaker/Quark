// Tool registry — list of available tools with schema validation
//
// Tools are validated on registration to catch errors early.
// Invalid tools are rejected with descriptive error messages.

import { z } from "zod"
import type { ToolDef } from "./tool"

const registry = new Map<string, ToolDef>()

/**
 * Describes a validation failure on a tool definition.
 */
export interface ToolValidationError {
  /** The ID of the tool that failed validation (or `"unknown"` if the id field is missing) */
  toolId: string
  /** The field that failed validation (e.g. `"id"`, `"description"`, `"parameters"`) */
  field: string
  /** Human-readable description of the validation failure */
  message: string
}

/**
 * Validate a tool definition without registering it.
 *
 * @param tool - The value to validate (accepts `unknown` for use in loaders)
 * @returns `null` if valid, or a {@link ToolValidationError} describing the failure
 */
export function validateTool(tool: unknown): ToolValidationError | null {
  // Check it's an object
  if (!tool || typeof tool !== "object") {
    return { toolId: "unknown", field: "tool", message: "Tool must be an object" }
  }

  const t = tool as Record<string, unknown>

  // Check id
  if (typeof t.id !== "string" || t.id.trim() === "") {
    return { toolId: String(t.id ?? "unknown"), field: "id", message: "Tool must have a non-empty string 'id'" }
  }

  const toolId = t.id

  // Check description
  if (typeof t.description !== "string" || t.description.trim() === "") {
    return { toolId, field: "description", message: "Tool must have a non-empty string 'description'" }
  }

  // Check parameters is a Zod schema
  if (!t.parameters || typeof t.parameters !== "object") {
    return { toolId, field: "parameters", message: "Tool must have a 'parameters' Zod schema" }
  }

  // Check it's a ZodType by looking for _def (Zod internal)
  const params = t.parameters as Record<string, unknown>
  if (!("_def" in params)) {
    return { toolId, field: "parameters", message: "Tool 'parameters' must be a Zod schema (z.object, z.string, etc.)" }
  }

  // Check execute is a function
  if (typeof t.execute !== "function") {
    return { toolId, field: "execute", message: "Tool must have an 'execute' function" }
  }

  return null
}

/**
 * Register a tool in the global tool registry.
 *
 * Validates the tool definition before registration. Rejects duplicates.
 *
 * @param tool - A valid {@link ToolDef}
 * @returns `{ ok: true }` on success, or `{ ok: false, error }` on validation failure or duplicate
 *
 * @example
 * ```ts
 * const result = register(myTool)
 * if (!result.ok) console.error(result.error.message)
 * ```
 */
export function register(tool: ToolDef): { ok: true } | { ok: false; error: ToolValidationError } {
  const error = validateTool(tool)
  if (error) {
    return { ok: false, error }
  }

  // Check for duplicate registration
  if (registry.has(tool.id)) {
    return {
      ok: false,
      error: { toolId: tool.id, field: "id", message: `Tool '${tool.id}' is already registered` },
    }
  }

  registry.set(tool.id, tool)
  return { ok: true }
}

/**
 * Register a tool, throwing on validation failure.
 * @throws {Error} If the tool fails validation
 * @deprecated Prefer {@link register} which returns a result instead of throwing
 */
export function registerOrThrow(tool: ToolDef): void {
  const result = register(tool)
  if (!result.ok) {
    throw new Error(`Tool validation failed for '${result.error.toolId}': ${result.error.message}`)
  }
}

export function get(id: string): ToolDef | undefined {
  return registry.get(id)
}

export function has(id: string): boolean {
  return registry.has(id)
}

/**
 * Return all registered tools.
 */
export function list(): ToolDef[] {
  return Array.from(registry.values())
}

/**
 * Resolve an ordered list of tool IDs to their {@link ToolDef} objects.
 *
 * @param ids - Array of tool IDs to resolve (order preserved)
 * @throws {Error} If any ID is not registered
 */
export function resolve(ids: string[]): ToolDef[] {
  return ids.map((id) => {
    const tool = registry.get(id)
    if (!tool) throw new Error(`Tool not found: ${id}`)
    return tool
  })
}

/**
 * Resolve tool IDs to their ToolDef objects, skipping unregistered tools.
 * Use when some tools may not have loaded (e.g. compiled binary can't resolve
 * dynamic imports for certain npm packages).
 */
export function resolveAvailable(ids: string[]): ToolDef[] {
  return ids
    .map((id) => registry.get(id))
    .filter((t): t is ToolDef => t != null)
}

/** Clear all registered tools (for testing) */
export function clear(): void {
  registry.clear()
}
