import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse } from "yaml"
import {
  migrateConfigToV2,
  parseConfigV2,
  parseCustomProviders,
  serializeConfig,
  writeConfigV2,
} from "../../src/config/config"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quark-config-v2-"))
const file = path.join(directory, "config.yaml")
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

function representativeConfig() {
  return {
    version: 2,
    models: {
      small: "openai/gpt-5-mini",
      favorites: ["openrouter/anthropic/claude-sonnet-4.6"],
    },
    providers: {
      "quark-go": {
        base_url: "https://api.quark-go.example/v1/",
        api_key_env: "QUARK_GO_API_KEY",
        billing: "subscription",
      },
    },
  }
}

describe("Config V2", () => {
  test("parses and serializes nested models and a subscription API-key provider", () => {
    const loaded = parseConfigV2(representativeConfig())
    expect(loaded.providers["quark-go"]).toEqual({
      base_url: "https://api.quark-go.example/v1",
      api_key_env: "QUARK_GO_API_KEY",
      billing: "subscription",
    })
    const serialized = serializeConfig(loaded)
    expect(serialized).not.toContain("credential:")
    expect(serialized).not.toContain("protocol:")
  })

  test("defaults telemetry diagnostics to denied and persists explicit opt-in", () => {
    const config = parseConfigV2(representativeConfig())
    expect(config.telemetry).toEqual({ diagnostic: false })

    const enabled = parseConfigV2({ ...representativeConfig(), telemetry: { diagnostic: true } })
    expect(enabled.telemetry).toEqual({ diagnostic: true })
    expect(parse(serializeConfig(enabled))).toMatchObject({ telemetry: { diagnostic: true } })
  })

  test("strictly validates the persisted diagnostic opt-in", () => {
    expect(() => parseConfigV2({ ...representativeConfig(), telemetry: { diagnostic: "true" } })).toThrow(/telemetry.diagnostic.*boolean/)
    expect(() => parseConfigV2({ ...representativeConfig(), telemetry: true })).toThrow(/telemetry.*mapping/)
  })

  test("preserves an optional editor setting", () => {
    const raw = representativeConfig() as Record<string, unknown>
    raw.editor = "code"
    const config = parseConfigV2(raw)
    expect(config.editor).toBe("code")
    expect(serializeConfig(config)).toContain("editor: code")
  })

  test("rejects provider secret fields without echoing their values", () => {
    const secret = "sk-must-never-appear"
    const raw = representativeConfig() as any
    raw.providers["quark-go"].apiKey = secret
    let message = ""
    try { parseConfigV2(raw) } catch (error) { message = String(error) }
    expect(message).toContain("forbidden")
    expect(message).not.toContain(secret)
  })

  test("validates environment names and rejects endpoint user-info", () => {
    expect(() => parseCustomProviders({ bad: {
      base_url: "https://example.com/v1",
      api_key_env: "not-valid",
    } })).toThrow(/uppercase environment-variable/)
    expect(() => parseCustomProviders({ bad: {
      base_url: "https://secret@example.com/v1",
      api_key_env: "BAD_API_KEY",
    } })).toThrow(/user-info/)
  })

  test("defaults optional custom provider billing and canonicalizes legacy environment config", () => {
    const providers = parseCustomProviders({
      current: { base_url: "https://current.example/v1", api_key_env: "CURRENT_API_KEY" },
      legacy: {
        protocol: "openai-compatible",
        endpoint: "https://legacy.example/v1",
        credential: { source: "environment", variable: "LEGACY_API_KEY" },
      },
    })
    expect(providers.current.billing).toBe("unknown")
    expect(providers.legacy).toEqual({
      base_url: "https://legacy.example/v1",
      api_key_env: "LEGACY_API_KEY",
      billing: "unknown",
    })
  })

  test("preserves legacy store credentials for runtime compatibility", () => {
    expect(parseCustomProviders({ bad: {
      protocol: "openai-compatible",
      endpoint: "https://example.com/v1",
      credential: { source: "store" },
    } }).bad).toEqual({
      base_url: "https://example.com/v1",
      legacyCredentialSource: { source: "store" },
      billing: "unknown",
    })
  })

  test("accepts canonical legacy DeepSeek input with a deprecation and rejects proxies", () => {
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      const providers = parseCustomProviders({
        deepseek: {
          base_url: "https://api.deepseek.com/",
          api_key_env: "DEEPSEEK_API_KEY",
          billing: "metered",
        },
      })
      expect(providers.deepseek?.base_url).toBe("https://api.deepseek.com")
      expect(parseCustomProviders({
        deepseek: {
          protocol: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          credential: { source: "store" },
          billing: "metered",
        },
      }).deepseek).toMatchObject({
        base_url: "https://api.deepseek.com/v1",
        legacyCredentialSource: { source: "store" },
      })
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.join("\n")).toContain("remove providers.deepseek")

    expect(() => parseCustomProviders({
      deepseek: {
        base_url: "https://proxy.example.com/deepseek/v1",
        api_key_env: "COMPANY_DEEPSEEK_KEY",
      },
    })).toThrow(/rename.*company-deepseek/i)
  })

  test("migrates V1 env references without persisting literal secrets", () => {
    const secret = "literal-secret-value"
    fs.writeFileSync(file, `small_model: gpt-4o-mini\nmodels: [gpt-4o]\nproviders:\n  openrouter:\n    baseURL: https://openrouter.ai/api/v1\n    apiKey: env:OPENROUTER_API_KEY\n  company:\n    baseURL: https://company.example/v1\n    apiKey: ${secret}\n`)

    const migrated = migrateConfigToV2(file)
    const persisted = fs.readFileSync(file, "utf8")
    const parsed = parse(persisted) as Record<string, any>
    expect(migrated.legacy).toBe(false)
    expect(parsed.version).toBe(2)
    expect(parsed.providers.openrouter).toBeUndefined()
    expect(parsed.providers.company).toBeUndefined()
    expect(persisted).not.toContain(secret)
    expect(persisted).not.toContain("apiKey")
  })

  test("atomic V2 writer leaves no temporary file", () => {
    writeConfigV2(parseConfigV2(representativeConfig()), file)
    expect(fs.readdirSync(directory).filter((name) => name.includes(".tmp."))).toEqual([])
  })
})
