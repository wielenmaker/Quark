import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse } from "yaml"
import {
  parseConfigV2,
  parseCustomProviders,
  providerCredentialSource,
  serializeConfig,
  writeConfigV2,
} from "../../packages/quark/src/config/config"
import { BUNDLED_PROVIDER_IDS } from "../../packages/runner/src/provider/definitions"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quark-config-v2-"))
const file = path.join(directory, "config.yaml")
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

function representativeConfig() {
  return {
    version: 2,
    models: {
      small: "openai/gpt-5-mini",
    },
    providers: {
      "quark-go": {
        base_url: "https://api.quark-go.example/v1/",
        api_key: "env:QUARK_GO_API_KEY",
      },
    },
  }
}

describe("Config V2", () => {
  test("parses and serializes a custom provider", () => {
    const loaded = parseConfigV2(representativeConfig())
    expect(loaded.providers["quark-go"]).toEqual({
      base_url: "https://api.quark-go.example/v1",
      api_key: "env:QUARK_GO_API_KEY",
    })
    const serialized = serializeConfig(loaded)
    expect(serialized).toContain("small: openai/gpt-5-mini")
    expect(serialized).not.toContain("favorites:")
    expect(serialized).not.toContain("credential:")
    expect(serialized).not.toContain("protocol:")
    expect(serialized).not.toContain("api_key_env")
  })

  test("maps provider api_key references onto credential sources", () => {
    expect(providerCredentialSource({ base_url: "https://x.example", api_key: "env:A_B" }))
      .toEqual({ source: "environment", variable: "A_B" })
    expect(providerCredentialSource({ base_url: "https://x.example", api_key: "sk-literal" }))
      .toEqual({ source: "inline", value: "sk-literal" })
    expect(providerCredentialSource({ base_url: "https://x.example" })).toEqual({ source: "none" })
  })

  test("accepts a literal api_key so it can be read directly", () => {
    const providers = parseCustomProviders({
      local: { base_url: "https://local.example/v1", api_key: "lm-studio" },
    })
    expect(providers.local).toEqual({ base_url: "https://local.example/v1", api_key: "lm-studio" })
  })

  test("omits api_key for keyless endpoints", () => {
    const providers = parseCustomProviders({ local: { base_url: "http://127.0.0.1:1234/v1" } })
    expect(providers.local).toEqual({ base_url: "http://127.0.0.1:1234/v1" })
  })

  test("ignores obsolete favorites", () => {
    const raw = representativeConfig() as Record<string, any>
    raw.models.favorites = ["openai/old-model"]
    const config = parseConfigV2(raw)
    expect(config.models).toEqual({ small: "openai/gpt-5-mini" })
    expect((config.models as Record<string, unknown>).favorites).toBeUndefined()
    expect(serializeConfig(config)).not.toContain("favorites:")
  })

  test("preserves an optional editor setting", () => {
    const raw = representativeConfig() as Record<string, unknown>
    raw.editor = "code"
    const config = parseConfigV2(raw)
    expect(config.editor).toBe("code")
    expect(serializeConfig(config)).toContain("editor: code")
  })

  test("round-trips profiles and default_profile during unrelated writes", () => {
    const raw = representativeConfig() as Record<string, any>
    raw.default_profile = "general"
    raw.profiles = { general: { name: "General", model: "openai/gpt-5.6-terra", thinking_effort: "high" } }
    const config = parseConfigV2(raw)
    const reparsed = parse(serializeConfig(config)) as Record<string, any>
    expect(reparsed.default_profile).toBe("general")
    expect(reparsed.profiles.general.thinking_effort).toBe("high")
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

  test("rejects removed provider keys", () => {
    expect(() => parseCustomProviders({ bad: {
      base_url: "https://example.com/v1",
      credential: { source: "store" },
    } })).toThrow(/providers\.bad\.credential is not supported/)
    expect(() => parseCustomProviders({ bad: {
      protocol: "openai-compatible",
      endpoint: "https://example.com/v1",
    } })).toThrow(/providers\.bad\.protocol is not supported/)
  })

  test("validates environment references, api_key shape, and endpoint user-info", () => {
    expect(() => parseCustomProviders({ bad: {
      base_url: "https://example.com/v1",
      api_key: "env:not-valid",
    } })).toThrow(/uppercase environment-variable/)
    expect(() => parseCustomProviders({ bad: {
      base_url: "https://example.com/v1",
      api_key: "   ",
    } })).toThrow(/non-empty API key/)
    expect(() => parseCustomProviders({ bad: {
      base_url: "https://secret@example.com/v1",
      api_key: "env:BAD_API_KEY",
    } })).toThrow(/user-info/)
  })

  test("rejects a bundled provider ID even with the canonical bundled endpoint", () => {
    expect(() => parseCustomProviders({
      deepseek: {
        base_url: "https://api.deepseek.com",
        api_key: "env:DEEPSEEK_API_KEY",
      },
    })).toThrow(/rename.*company-deepseek/i)
    expect(() => parseCustomProviders({
      deepseek: {
        base_url: "https://proxy.example.com/deepseek/v1",
        api_key: "env:COMPANY_DEEPSEEK_KEY",
      },
    })).toThrow(/rename.*company-deepseek/i)
  })

  // Regression: config used to carry its own copy of the bundled ID list, which
  // silently drifted (opencode-go was missing) and let a custom provider shadow
  // a bundled one without any error.
  test("rejects a custom provider that shadows any bundled provider ID", () => {
    expect(BUNDLED_PROVIDER_IDS.size).toBeGreaterThan(0)
    for (const id of BUNDLED_PROVIDER_IDS) {
      expect(() => parseCustomProviders({
        [id]: { base_url: "https://shadow.example/v1", api_key: "env:SHADOW_KEY" },
      })).toThrow(new RegExp(`providers\\.${id} conflicts with the bundled ${id} provider`))
    }
  })

  test("rejects runtime-only provider IDs", () => {
    expect(() => parseCustomProviders({
      compaction: { base_url: "https://example.com/v1" },
    })).toThrow(/compaction.*reserved/)
  })

  test("atomic V2 writer leaves no temporary file", () => {
    writeConfigV2(parseConfigV2(representativeConfig()), file)
    expect(fs.readdirSync(directory).filter((name) => name.includes(".tmp."))).toEqual([])
  })
})
