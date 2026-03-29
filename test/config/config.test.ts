// Tests for the config loader — loadConfig, getModelId, setConfigField, resetConfigCache
//
// Strategy: mock os.homedir() to point at a temp directory so all file I/O
// goes to a throwaway location. The config module computes CONFIG_DIR/FILE
// at import time from os.homedir(), so the mock must be set up before import.

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ---------------------------------------------------------------------------
// Set up a temp directory that acts as $HOME for the config module
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "atom-config-test-"))
const configDir = path.join(tmpHome, ".config", "atom")
const configFile = path.join(configDir, "config.json")

// Mock os.homedir() BEFORE importing the config module
mock.module("os", () => ({
  ...os,
  homedir: () => tmpHome,
}))

// Now import the config module — it will compute CONFIG_DIR using our mocked homedir
const {
  loadConfig,
  getModelId,
  setConfigField,
  resetConfigCache,
  getDBPath,
  SESSION_DIR,
} = await import("../../src/config/config")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(data: Record<string, unknown>) {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(data, null, 2), "utf-8")
}

function removeConfig() {
  try {
    fs.unlinkSync(configFile)
  } catch {
    // Already gone
  }
}

function readConfigFile(): Record<string, unknown> {
  const content = fs.readFileSync(configFile, "utf-8")
  return JSON.parse(content) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Clean state between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  removeConfig()
  resetConfigCache()
})

afterAll(() => {
  // Clean up temp dir
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// loadConfig — defaults
// ---------------------------------------------------------------------------
describe("loadConfig", () => {
  test("returns defaults when config file is missing", () => {
    const config = loadConfig()
    expect(config.small_model).toBe("gpt-4o-mini")
    expect(config.main_model).toBe("gpt-4o")
    expect(config.models).toBeArray()
    expect(config.models.length).toBeGreaterThan(0)
    expect(config.models).toContain("gpt-4o")
    expect(config.models).toContain("claude-sonnet-4")
  })

  test("returns defaults when config file has invalid JSON", () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(configFile, "NOT VALID JSON {{{", "utf-8")

    const config = loadConfig()
    expect(config.small_model).toBe("gpt-4o-mini")
    expect(config.main_model).toBe("gpt-4o")
    expect(config.models).toBeArray()
  })

  test("reads main_model from file", () => {
    writeConfig({ main_model: "claude-sonnet-4" })

    const config = loadConfig()
    expect(config.main_model).toBe("claude-sonnet-4")
    // small_model should still default
    expect(config.small_model).toBe("gpt-4o-mini")
  })

  test("reads small_model from file", () => {
    writeConfig({ small_model: "gpt-4.1-nano" })

    const config = loadConfig()
    expect(config.small_model).toBe("gpt-4.1-nano")
    expect(config.main_model).toBe("gpt-4o")
  })

  test("reads models array from file", () => {
    writeConfig({ models: ["model-a", "model-b"] })

    const config = loadConfig()
    expect(config.models).toEqual(["model-a", "model-b"])
  })

  test("falls back to default models when array contains non-strings", () => {
    writeConfig({ models: ["valid", 123, null] })

    const config = loadConfig()
    // Should fall back to defaults because not all elements are strings
    expect(config.models).toContain("gpt-4o")
    expect(config.models).not.toContain("valid")
  })

  test("falls back to default models when models is not an array", () => {
    writeConfig({ models: "not-an-array" })

    const config = loadConfig()
    expect(config.models).toBeArray()
    expect(config.models).toContain("gpt-4o")
  })

  test("falls back to default for empty string fields", () => {
    writeConfig({ main_model: "", small_model: "" })

    const config = loadConfig()
    expect(config.main_model).toBe("gpt-4o")
    expect(config.small_model).toBe("gpt-4o-mini")
  })

  test("falls back to default for non-string fields", () => {
    writeConfig({ main_model: 42, small_model: true })

    const config = loadConfig()
    expect(config.main_model).toBe("gpt-4o")
    expect(config.small_model).toBe("gpt-4o-mini")
  })

  test("reads all fields together", () => {
    writeConfig({
      models: ["a", "b", "c"],
      small_model: "tiny-model",
      main_model: "big-model",
    })

    const config = loadConfig()
    expect(config.models).toEqual(["a", "b", "c"])
    expect(config.small_model).toBe("tiny-model")
    expect(config.main_model).toBe("big-model")
  })
})

// ---------------------------------------------------------------------------
// loadConfig — caching
// ---------------------------------------------------------------------------
describe("loadConfig caching", () => {
  test("returns cached result on second call", () => {
    writeConfig({ main_model: "first-model" })
    const first = loadConfig()
    expect(first.main_model).toBe("first-model")

    // Change file on disk — loadConfig should still return cached
    writeConfig({ main_model: "second-model" })
    const second = loadConfig()
    expect(second.main_model).toBe("first-model")
    expect(second).toBe(first) // Same object reference
  })

  test("resetConfigCache forces re-read", () => {
    writeConfig({ main_model: "original" })
    const first = loadConfig()
    expect(first.main_model).toBe("original")

    writeConfig({ main_model: "updated" })
    resetConfigCache()
    const second = loadConfig()
    expect(second.main_model).toBe("updated")
  })
})

// ---------------------------------------------------------------------------
// getModelId
// ---------------------------------------------------------------------------
describe("getModelId", () => {
  test("returns main_model for kind 'main'", () => {
    writeConfig({ main_model: "gpt-5" })

    expect(getModelId("main")).toBe("gpt-5")
  })

  test("returns small_model for kind 'small'", () => {
    writeConfig({ small_model: "gpt-4o-mini" })

    expect(getModelId("small")).toBe("gpt-4o-mini")
  })

  test("returns defaults when no config file", () => {
    expect(getModelId("main")).toBe("gpt-4o")
    expect(getModelId("small")).toBe("gpt-4o-mini")
  })
})

// ---------------------------------------------------------------------------
// setConfigField
// ---------------------------------------------------------------------------
describe("setConfigField", () => {
  test("creates config file and directory if missing", () => {
    // Ensure directory doesn't exist
    fs.rmSync(configDir, { recursive: true, force: true })

    setConfigField("main_model", "new-model")

    expect(fs.existsSync(configFile)).toBe(true)
    const data = readConfigFile()
    expect(data.main_model).toBe("new-model")
  })

  test("merges with existing config", () => {
    writeConfig({ main_model: "existing-model", custom_field: "preserve-me" })

    setConfigField("small_model", "tiny")

    const data = readConfigFile()
    expect(data.main_model).toBe("existing-model")
    expect(data.small_model).toBe("tiny")
    expect(data.custom_field).toBe("preserve-me")
  })

  test("overwrites existing field", () => {
    writeConfig({ main_model: "old" })

    setConfigField("main_model", "new")

    const data = readConfigFile()
    expect(data.main_model).toBe("new")
  })

  test("invalidates cache so next loadConfig reads fresh", () => {
    writeConfig({ main_model: "before" })
    const before = loadConfig()
    expect(before.main_model).toBe("before")

    setConfigField("main_model", "after")
    const after = loadConfig()
    expect(after.main_model).toBe("after")
  })

  test("can set models array", () => {
    setConfigField("models", ["x", "y", "z"])

    const data = readConfigFile()
    expect(data.models).toEqual(["x", "y", "z"])

    const config = loadConfig()
    expect(config.models).toEqual(["x", "y", "z"])
  })
})

// ---------------------------------------------------------------------------
// resetConfigCache
// ---------------------------------------------------------------------------
describe("resetConfigCache", () => {
  test("does not throw when called with no prior cache", () => {
    expect(() => resetConfigCache()).not.toThrow()
  })

  test("allows loadConfig to re-read after file change", () => {
    writeConfig({ main_model: "v1" })
    loadConfig()

    writeConfig({ main_model: "v2" })
    resetConfigCache()

    expect(loadConfig().main_model).toBe("v2")
  })
})

// ---------------------------------------------------------------------------
// getDBPath
// ---------------------------------------------------------------------------
describe("getDBPath", () => {
  test("returns a path inside ~/.config/quark/session/", () => {
    const p = getDBPath("/some/project")
    expect(p).toContain(path.join(tmpHome, ".config", "quark", "session"))
    expect(p.endsWith("/quark.db") || p.endsWith("\\quark.db")).toBe(true)
  })

  test("returns the same path for the same CWD", () => {
    expect(getDBPath("/foo/bar")).toBe(getDBPath("/foo/bar"))
  })

  test("returns different paths for different CWDs", () => {
    expect(getDBPath("/project/a")).not.toBe(getDBPath("/project/b"))
  })

  test("creates the session directory on disk", () => {
    const p = getDBPath("/tmp/quark-test-project")
    expect(fs.existsSync(path.dirname(p))).toBe(true)
  })

  test("uses process.cwd() when no argument given", () => {
    const p = getDBPath()
    expect(p).toContain(path.join(tmpHome, ".config", "quark", "session"))
  })

  test("SESSION_DIR points inside the mocked home", () => {
    expect(SESSION_DIR).toContain(path.join(tmpHome, ".config", "quark", "session"))
  })
})
