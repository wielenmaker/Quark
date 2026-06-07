// Tests for OpenAI Codex (ChatGPT Plus/Pro) OAuth authentication.
// Covers JWT decoding, token exchange, device code flow, browser PKCE flow,
// token refresh, and persistence.
//
// TARGET SOURCE: src/provider/codex-auth.ts
//
// Pattern: Follows test/provider/copilot-auth.test.ts mock fetch style.
// All HTTP calls are mocked via injectable FetchFn.

import { afterEach, beforeEach, describe, test, expect } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { FetchFn } from "../../src/provider/codex-auth"
import {
  decodeJwt,
  getAccountId,
  readTokenResponse,
  exchangeCode,
  refreshToken,
  startDeviceAuth,
  pollDeviceAuth,
  loginWithDeviceCode,
  loginWithBrowser,
  saveToken,
  loadToken,
} from "../../src/provider/codex-auth"
import type {
  CodexToken,
  DeviceAuthInfo,
  DeviceCodeInfo,
} from "../../src/provider/codex-auth"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock Response with JSON body and given status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Build a valid JWT string from a payload object. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `${header}.${body}.fake-signature`
}

/** Create a valid token response body. */
function validTokenResponse(overrides?: Partial<{
  access_token: string
  refresh_token: string
  expires_in: number
}>): Record<string, unknown> {
  return {
    access_token: overrides?.access_token ?? "access-token-abc",
    refresh_token: overrides?.refresh_token ?? "refresh-token-xyz",
    expires_in: overrides?.expires_in ?? 3600,
  }
}

/** Create a valid CodexToken for save/load tests. */
function makeToken(overrides?: Partial<CodexToken>): CodexToken {
  return {
    access: overrides?.access ?? "at-test",
    refresh: overrides?.refresh ?? "rt-test",
    expires: overrides?.expires ?? Date.now() + 3600_000,
    accountId: overrides?.accountId ?? "acct-test-123",
  }
}

/** A known JWT payload that getAccountId can extract from. */
const CLAIM_PATH = "https://api.openai.com/auth"
const jwtWithAccount = makeJwt({
  [CLAIM_PATH]: { chatgpt_account_id: "acct-123" },
})

// ---------------------------------------------------------------------------
// decodeJwt — parses JWT access tokens
// ---------------------------------------------------------------------------
describe("decodeJwt", () => {
  test("parses a known JWT and returns payload", () => {
    const payload = { sub: "user-1", name: "Test User" }
    const token = makeJwt(payload)

    const result = decodeJwt(token)

    expect(result).not.toBeNull()
    expect(result!.sub).toBe("user-1")
    expect(result!.name).toBe("Test User")
  })

  test("parses JWT with nested OpenAI auth claim", () => {
    const result = decodeJwt(jwtWithAccount)

    expect(result).not.toBeNull()
    const auth = result![CLAIM_PATH] as Record<string, unknown> | undefined
    expect(auth?.chatgpt_account_id).toBe("acct-123")
  })

  test("returns null for string with no dots (not a JWT)", () => {
    expect(decodeJwt("not-a-jwt-at-all")).toBeNull()
  })

  test("returns null for string with only one dot", () => {
    expect(decodeJwt("header.payload")).toBeNull()
  })

  test("returns null for string with more than two dots", () => {
    expect(decodeJwt("a.b.c.d")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(decodeJwt("")).toBeNull()
  })

  test("returns null when payload segment is not valid base64", () => {
    const header = btoa(JSON.stringify({ alg: "HS256" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const token = `${header}.!!!invalid!!!.sig`

    expect(decodeJwt(token)).toBeNull()
  })

  test("returns null when payload segment is valid base64 but not JSON", () => {
    // "bm90anNvbg==" is base64 for "notjson" — valid base64, not valid JSON
    const header = btoa(JSON.stringify({ alg: "HS256" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const body = btoa("notjson")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const token = `${header}.${body}.sig`

    expect(decodeJwt(token)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getAccountId — extracts chatgpt_account_id from JWT access token
// ---------------------------------------------------------------------------
describe("getAccountId", () => {
  test("extracts chatgpt_account_id from JWT at the OpenAI claim path", () => {
    const accountId = getAccountId(jwtWithAccount)

    expect(accountId).toBe("acct-123")
  })

  test("returns null when the OpenAI claim path is missing", () => {
    const token = makeJwt({ sub: "user-1" })

    expect(getAccountId(token)).toBeNull()
  })

  test("returns null when claim exists but chatgpt_account_id is missing", () => {
    const token = makeJwt({ [CLAIM_PATH]: { other_field: "value" } })

    expect(getAccountId(token)).toBeNull()
  })

  test("returns null when accountId is empty string", () => {
    const token = makeJwt({ [CLAIM_PATH]: { chatgpt_account_id: "" } })

    expect(getAccountId(token)).toBeNull()
  })

  test("returns null for invalid JWT", () => {
    expect(getAccountId("not-a-jwt")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// readTokenResponse — validates and parses token endpoint responses
// ---------------------------------------------------------------------------
describe("readTokenResponse", () => {
  test("parses valid token response into OAuthToken shape", async () => {
    const before = Date.now()
    const response = jsonResponse(validTokenResponse())

    const result = await readTokenResponse(response, "exchange")

    expect(result.access).toBe("access-token-abc")
    expect(result.refresh).toBe("refresh-token-xyz")
    // expires should be roughly Date.now() + expires_in * 1000
    expect(result.expires).toBeGreaterThanOrEqual(before + 3600_000)
    expect(result.expires).toBeLessThanOrEqual(Date.now() + 3600_100)
  })

  test("throws when access_token is missing", async () => {
    const response = jsonResponse({
      refresh_token: "rt",
      expires_in: 3600,
    })

    await expect(
      readTokenResponse(response, "exchange"),
    ).rejects.toThrow(/missing fields/i)
  })

  test("throws when refresh_token is missing", async () => {
    const response = jsonResponse({
      access_token: "at",
      expires_in: 3600,
    })

    await expect(
      readTokenResponse(response, "exchange"),
    ).rejects.toThrow(/missing fields/i)
  })

  test("throws when expires_in is missing", async () => {
    const response = jsonResponse({
      access_token: "at",
      refresh_token: "rt",
    })

    await expect(
      readTokenResponse(response, "exchange"),
    ).rejects.toThrow(/missing fields/i)
  })

  test("throws when expires_in is not a number", async () => {
    const response = jsonResponse({
      access_token: "at",
      refresh_token: "rt",
      expires_in: "not-a-number",
    })

    await expect(
      readTokenResponse(response, "exchange"),
    ).rejects.toThrow(/missing fields/i)
  })

  test("throws on non-OK HTTP status", async () => {
    const response = new Response('{"error":"invalid_grant"}', { status: 400 })

    await expect(
      readTokenResponse(response, "exchange"),
    ).rejects.toThrow(/400/)
  })

  test("includes operation name in error message", async () => {
    const response = new Response("Server Error", { status: 500 })

    await expect(
      readTokenResponse(response, "refresh"),
    ).rejects.toThrow(/refresh/)
  })
})

// ---------------------------------------------------------------------------
// exchangeCode — POSTs authorization code to token endpoint
// ---------------------------------------------------------------------------
describe("exchangeCode", () => {
  test("POSTs to auth.openai.com/oauth/token with correct form body", async () => {
    let capturedUrl = ""
    let capturedBody: string | null = null
    let capturedHeaders: Record<string, string> = {}

    const mockFetch: FetchFn = async (url, init) => {
      capturedUrl = url.toString()
      capturedBody = (init?.body as string) ?? null
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries(),
      )
      return jsonResponse(validTokenResponse())
    }

    await exchangeCode({
      code: "auth-code-123",
      codeVerifier: "verifier-abc",
      redirectUri: "http://localhost:1455/auth/callback",
      fetch: mockFetch,
    })

    expect(capturedUrl).toBe("https://auth.openai.com/oauth/token")
    expect(capturedHeaders["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    )

    const params = new URLSearchParams(capturedBody ?? "")
    expect(params.get("grant_type")).toBe("authorization_code")
    expect(params.get("client_id")).toBeTruthy()
    expect(params.get("code")).toBe("auth-code-123")
    expect(params.get("code_verifier")).toBe("verifier-abc")
    expect(params.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    )
  })

  test("returns CodexToken with access, refresh, expires, accountId", async () => {
    // Build a JWT where getAccountId can extract the accountId
    const accessTokenPayload = {
      [CLAIM_PATH]: { chatgpt_account_id: "acct-456" },
    }
    const accessToken = makeJwt(accessTokenPayload)

    const mockFetch: FetchFn = async () =>
      jsonResponse(validTokenResponse({ access_token: accessToken }))

    const result = await exchangeCode({
      code: "auth-code",
      codeVerifier: "verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      fetch: mockFetch,
    })

    expect(result.access).toBe(accessToken)
    expect(result.refresh).toBe("refresh-token-xyz")
    expect(typeof result.expires).toBe("number")
    expect(result.accountId).toBe("acct-456")
  })

  test("respects AbortSignal", async () => {
    const controller = new AbortController()
    controller.abort()

    const mockFetch: FetchFn = async () => jsonResponse(validTokenResponse())

    await expect(
      exchangeCode({
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://localhost:1455/auth/callback",
        signal: controller.signal,
        fetch: mockFetch,
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// refreshToken — POSTs refresh_token grant to token endpoint
// ---------------------------------------------------------------------------
describe("refreshToken", () => {
  test("POSTs with grant_type=refresh_token and correct body", async () => {
    let capturedBody: string | null = null
    let capturedUrl = ""

    const mockFetch: FetchFn = async (url, init) => {
      capturedUrl = url.toString()
      capturedBody = (init?.body as string) ?? null
      return jsonResponse(validTokenResponse())
    }

    await refreshToken({ refreshToken: "old-refresh-token", fetch: mockFetch })

    expect(capturedUrl).toBe("https://auth.openai.com/oauth/token")

    const params = new URLSearchParams(capturedBody ?? "")
    expect(params.get("grant_type")).toBe("refresh_token")
    expect(params.get("refresh_token")).toBe("old-refresh-token")
    expect(params.get("client_id")).toBeTruthy()
  })

  test("returns new CodexToken with different values", async () => {
    const mockFetch: FetchFn = async () =>
      jsonResponse(
        validTokenResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
        }),
      )

    // Need a valid JWT for accountId extraction
    const tokenJwt = makeJwt({
      [CLAIM_PATH]: { chatgpt_account_id: "acct-789" },
    })

    const mockFetchWithJwt: FetchFn = async () =>
      jsonResponse(
        validTokenResponse({
          access_token: tokenJwt,
          refresh_token: "new-refresh",
          expires_in: 7200,
        }),
      )

    const result = await refreshToken({
      refreshToken: "old-rt",
      fetch: mockFetchWithJwt,
    })

    expect(result.access).toBe(tokenJwt)
    expect(result.refresh).toBe("new-refresh")
    expect(result.accountId).toBe("acct-789")
  })
})

// ---------------------------------------------------------------------------
// startDeviceAuth — initiates Codex device code flow
// ---------------------------------------------------------------------------
describe("startDeviceAuth", () => {
  test("POSTs to device user code endpoint with client_id", async () => {
    let capturedUrl = ""
    let capturedBody: unknown = null

    const mockFetch: FetchFn = async (url, init) => {
      capturedUrl = url.toString()
      capturedBody = JSON.parse((init?.body as string) ?? "{}")
      return jsonResponse({
        device_auth_id: "da-001",
        user_code: "ABCD-EFGH",
        interval: 5,
      })
    }

    const result = await startDeviceAuth({ fetch: mockFetch })

    expect(capturedUrl).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
    )
    expect((capturedBody as Record<string, unknown>).client_id).toBeTruthy()
    expect(result.deviceAuthId).toBe("da-001")
    expect(result.userCode).toBe("ABCD-EFGH")
    expect(result.intervalSeconds).toBe(5)
  })

  test("throws descriptive error on 404 (device flow not enabled)", async () => {
    const mockFetch: FetchFn = async () =>
      new Response("Not Found", { status: 404 })

    await expect(
      startDeviceAuth({ fetch: mockFetch }),
    ).rejects.toThrow(/device code login is not enabled/i)
  })

  test("respects AbortSignal", async () => {
    const controller = new AbortController()
    controller.abort()

    const mockFetch: FetchFn = async () =>
      jsonResponse({ device_auth_id: "x", user_code: "y", interval: 5 })

    await expect(
      startDeviceAuth({ signal: controller.signal, fetch: mockFetch }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// pollDeviceAuth — polls device token endpoint until success
// ---------------------------------------------------------------------------
describe("pollDeviceAuth", () => {
  test("polls until success and returns authorization code", async () => {
    let callCount = 0

    const mockFetch: FetchFn = async () => {
      callCount++
      if (callCount < 3) {
        // Pending — 403 or 404 means "not yet authorized"
        return new Response("{}", { status: 403 })
      }
      return jsonResponse({
        authorization_code: "auth-code-final",
        code_verifier: "verifier-final",
      })
    }

    const result = await pollDeviceAuth({
      deviceAuthId: "da-001",
      userCode: "ABCD-EFGH",
      intervalSeconds: 0, // no delay in tests
      fetch: mockFetch,
    })

    expect(result.authorizationCode).toBe("auth-code-final")
    expect(result.codeVerifier).toBe("verifier-final")
    expect(callCount).toBe(3)
  })

  test("throws on unrecoverable HTTP error", async () => {
    const mockFetch: FetchFn = async () =>
      new Response('{"error":"access_denied"}', { status: 400 })

    await expect(
      pollDeviceAuth({
        deviceAuthId: "da-001",
        userCode: "ABCD-EFGH",
        intervalSeconds: 0,
        fetch: mockFetch,
      }),
    ).rejects.toThrow()
  })

  test("respects AbortSignal", async () => {
    const controller = new AbortController()
    let callCount = 0

    const mockFetch: FetchFn = async () => {
      callCount++
      if (callCount === 2) controller.abort()
      return new Response("{}", { status: 403 })
    }

    await expect(
      pollDeviceAuth({
        deviceAuthId: "da-001",
        userCode: "ABCD-EFGH",
        intervalSeconds: 0,
        signal: controller.signal,
        fetch: mockFetch,
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// loginWithDeviceCode — full device code flow orchestration
// ---------------------------------------------------------------------------
describe("loginWithDeviceCode", () => {
  test("calls onDeviceCode callback with correct info", async () => {
    let deviceInfo: DeviceCodeInfo | undefined

    // We need a multi-step mock. Each call to fetch does something different.
    let step = 0
    const mockFetch: FetchFn = async (url, init) => {
      step++
      const urlStr = url.toString()
      if (urlStr.includes("deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "da-002",
          user_code: "WXYZ-9876",
          interval: 5,
        })
      }
      if (urlStr.includes("deviceauth/token")) {
        return jsonResponse({
          authorization_code: "device-auth-code",
          code_verifier: "device-verifier",
        })
      }
      // Token exchange
      const accessJwt = makeJwt({
        [CLAIM_PATH]: { chatgpt_account_id: "acct-device" },
      })
      return jsonResponse(validTokenResponse({ access_token: accessJwt }))
    }

    const result = await loginWithDeviceCode({
      onDeviceCode: (info) => {
        deviceInfo = info
      },
      fetch: mockFetch,
    })

    expect(deviceInfo).toBeDefined()
    expect(deviceInfo!.userCode).toBe("WXYZ-9876")
    expect(deviceInfo!.verificationUri).toBe("https://auth.openai.com/codex/device")
    expect(deviceInfo!.intervalSeconds).toBe(5)

    expect(result.access).toBeTruthy()
    expect(result.refresh).toBeTruthy()
    expect(result.accountId).toBe("acct-device")
  })

  test("respects AbortSignal", async () => {
    const controller = new AbortController()
    controller.abort()

    const mockFetch: FetchFn = async () =>
      jsonResponse({ device_auth_id: "x", user_code: "y", interval: 5 })

    await expect(
      loginWithDeviceCode({
        onDeviceCode: () => {},
        signal: controller.signal,
        fetch: mockFetch,
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// loginWithBrowser — browser PKCE flow with local callback server
// ---------------------------------------------------------------------------
describe("loginWithBrowser", () => {
  test("calls onUrl callback with authorization URL containing PKCE params", async () => {
    let authUrl = ""

    // Mock: local server receives callback immediately with valid code+state
    // Implementation will parse state from callback and validate.
    // We mock exchangeCode to succeed.
    const mockFetch: FetchFn = async () => {
      const accessJwt = makeJwt({
        [CLAIM_PATH]: { chatgpt_account_id: "acct-browser" },
      })
      return jsonResponse(validTokenResponse({ access_token: accessJwt }))
    }

    // Since loginWithBrowser internally creates an http server, we can't easily
    // test the full flow without mocking node:http. The implementation should
    // expose enough for us to test via onUrl + onPrompt flow.
    //
    // Instead, we test that:
    // 1. onUrl is called with a URL string
    // 2. The URL contains required OAuth params
    // 3. When onPrompt provides a code, exchange happens

    const resultPromise = loginWithBrowser({
      onUrl: (url) => {
        authUrl = url
      },
      onPrompt: async () => "auth-code-from-user",
      fetch: mockFetch,
    })

    const result = await resultPromise

    // URL was passed to callback
    expect(authUrl).toBeTruthy()
    expect(authUrl).toContain("https://auth.openai.com/oauth/authorize")
    expect(authUrl).toContain("response_type=code")
    expect(authUrl).toContain("code_challenge=")
    expect(authUrl).toContain("code_challenge_method=S256")
    expect(authUrl).toContain("state=")
    expect(authUrl).toContain("redirect_uri=")
    expect(authUrl).toContain("scope=")

    // Result is a valid CodexToken
    expect(result.access).toBeTruthy()
    expect(result.refresh).toBeTruthy()
    expect(result.accountId).toBe("acct-browser")
  })

  test("validates state and throws on state mismatch when manual input includes state", async () => {
    const mockFetch: FetchFn = async () =>
      jsonResponse(validTokenResponse())

    // onPrompt returns a code with a state that won't match
    await expect(
      loginWithBrowser({
        onUrl: () => {},
        onPrompt: async () => "some-code#wrong-state",
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/state mismatch/i)
  })

  test("throws when both browser callback and manual input fail to provide code", async () => {
    const mockFetch: FetchFn = async () =>
      jsonResponse(validTokenResponse())

    await expect(
      loginWithBrowser({
        onUrl: () => {},
        onPrompt: async () => "",
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/missing authorization code/i)
  })
})

// ---------------------------------------------------------------------------
// saveToken / loadToken — token persistence to disk
// ---------------------------------------------------------------------------
describe("saveToken / loadToken", () => {
  let tokenDir = ""
  let tokenFile = ""

  beforeEach(() => {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "quark-codex-auth-"))
    tokenFile = path.join(tokenDir, "codex-token.json")
  })

  afterEach(() => {
    fs.rmSync(tokenDir, { recursive: true, force: true })
  })

  test("saveToken writes without throwing", () => {
    const token = makeToken()

    expect(() => saveToken(token, tokenFile)).not.toThrow()
    expect(fs.existsSync(tokenFile)).toBe(true)
  })

  test("loadToken returns null when no token file exists", () => {
    expect(loadToken(tokenFile)).toBeNull()
  })

  test("loadToken returns null for corrupted JSON", () => {
    fs.writeFileSync(tokenFile, "{broken", "utf-8")

    expect(loadToken(tokenFile)).toBeNull()
  })

  test("save then load round-trips values correctly", () => {
    const token = makeToken({
      access: "roundtrip-access",
      refresh: "roundtrip-refresh",
      accountId: "roundtrip-acct",
    })

    saveToken(token, tokenFile)
    const loaded = loadToken(tokenFile)

    expect(loaded?.access).toBe("roundtrip-access")
    expect(loaded?.refresh).toBe("roundtrip-refresh")
    expect(loaded?.accountId).toBe("roundtrip-acct")
  })
})
