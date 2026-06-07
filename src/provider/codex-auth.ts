/**
 * OpenAI Codex (ChatGPT Plus/Pro) OAuth authentication.
 *
 * Supports two login methods:
 *   1. Browser PKCE flow — local callback server on port 1455
 *   2. Device code flow — headless, user authenticates on another device
 *
 * Also handles token refresh using the stored refresh_token.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { generatePKCE } from "./pkce"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTH_BASE_URL = "https://auth.openai.com"
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const REDIRECT_URI = "http://localhost:1455/auth/callback"
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
const SCOPE = "openid profile email offline_access"
const JWT_CLAIM_PATH = "https://api.openai.com/auth"

const TOKEN_FILE_NAME = "codex-token.json"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FetchFn = (
	url: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export interface CodexToken {
	access: string
	refresh: string
	expires: number
	accountId: string
}

export interface DeviceAuthInfo {
	deviceAuthId: string
	userCode: string
	intervalSeconds: number
}

export interface DeviceCodeInfo {
	userCode: string
	verificationUri: string
	intervalSeconds: number
}

export interface DeviceTokenSuccess {
	authorizationCode: string
	codeVerifier: string
}

interface OAuthToken {
	access: string
	refresh: string
	expires: number
}

// ---------------------------------------------------------------------------
// JWT utilities
// ---------------------------------------------------------------------------

export function decodeJwt(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".")
		if (parts.length !== 3) return null
		const payload = parts[1] ?? ""
		const decoded = atob(payload)
		return JSON.parse(decoded) as Record<string, unknown>
	} catch {
		return null
	}
}

export function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken)
	if (!payload) return null
	const auth = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined
	const accountId = auth?.chatgpt_account_id
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithAbort(
	f: FetchFn,
	input: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Response> {
	try {
		return await f(input, { ...init, signal })
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled")
		}
		throw error
	}
}

export async function readTokenResponse(
	response: Response,
	operation: "exchange" | "refresh",
): Promise<OAuthToken> {
	if (!response.ok) {
		const text = await response.text().catch(() => "")
		throw new Error(
			`OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`,
		)
	}

	const rawJson = await response.json()
	const json = rawJson as {
		access_token?: string
		refresh_token?: string
		expires_in?: number
	} | null
	if (
		!json?.access_token ||
		!json.refresh_token ||
		typeof json.expires_in !== "number"
	) {
		throw new Error(
			`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`,
		)
	}

	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	}
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export async function exchangeCode(options: {
	code: string
	codeVerifier: string
	redirectUri: string
	signal?: AbortSignal
	fetch?: FetchFn
}): Promise<CodexToken> {
	if (options.signal?.aborted) {
		throw new Error("Login cancelled")
	}
	const f = options.fetch ?? globalThis.fetch
	const response = await fetchWithAbort(
		f,
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: options.code,
				code_verifier: options.codeVerifier,
				redirect_uri: options.redirectUri,
			}),
		},
		options.signal,
	)

	const token = await readTokenResponse(response, "exchange")
	const accountId = getAccountId(token.access) ?? "unknown"

	return {
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		accountId,
	}
}

export async function refreshToken(options: {
	refreshToken: string
	fetch?: FetchFn
}): Promise<CodexToken> {
	const f = options.fetch ?? globalThis.fetch
	const response = await fetchWithAbort(
		f,
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: options.refreshToken,
				client_id: CLIENT_ID,
			}),
		},
	)

	const token = await readTokenResponse(response, "refresh")
	const accountId = getAccountId(token.access) ?? "unknown"

	return {
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		accountId,
	}
}

// ---------------------------------------------------------------------------
// Device code flow
// ---------------------------------------------------------------------------

export async function startDeviceAuth(options?: {
	signal?: AbortSignal
	fetch?: FetchFn
}): Promise<DeviceAuthInfo> {
	if (options?.signal?.aborted) {
		throw new Error("Login cancelled")
	}
	const f = options?.fetch ?? globalThis.fetch
	const response = await fetchWithAbort(
		f,
		DEVICE_USER_CODE_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: CLIENT_ID }),
		},
		options?.signal,
	)

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				"OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.",
			)
		}
		const body = await response.text().catch(() => "")
		throw new Error(
			`OpenAI Codex device code request failed with status ${response.status}${body ? `: ${body}` : ""}`,
		)
	}

	const rawJson = await response.json()
	const json = rawJson as {
		device_auth_id?: string
		user_code?: string
		interval?: number | string
	} | null
	const intervalSeconds =
		typeof json?.interval === "string"
			? Number(json.interval.trim())
			: json?.interval
	if (
		!json?.device_auth_id ||
		!json.user_code ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds < 0
	) {
		throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`)
	}

	return {
		deviceAuthId: json.device_auth_id,
		userCode: json.user_code,
		intervalSeconds,
	}
}

export async function pollDeviceAuth(options: {
	deviceAuthId: string
	userCode: string
	intervalSeconds: number
	signal?: AbortSignal
	fetch?: FetchFn
}): Promise<DeviceTokenSuccess> {
	const f = options.fetch ?? globalThis.fetch
	const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000
	let intervalMs = options.intervalSeconds * 1000

	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			throw new Error("Login cancelled")
		}

		const response = await fetchWithAbort(
			f,
			DEVICE_TOKEN_URL,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					device_auth_id: options.deviceAuthId,
					user_code: options.userCode,
				}),
			},
			options.signal,
		)

		if (response.ok) {
			const rawJson = await response.json()
			const json = rawJson as {
				authorization_code?: string
				code_verifier?: string
			} | null
			if (!json?.authorization_code || !json.code_verifier) {
				throw new Error(
					`Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`,
				)
			}
			return {
				authorizationCode: json.authorization_code,
				codeVerifier: json.code_verifier,
			}
		}

		if (response.status === 403 || response.status === 404) {
			// Still waiting
		} else {
			const body = await response.text().catch(() => "")
			let errorCode: unknown
			try {
				const json = JSON.parse(body) as { error?: string | { code?: string } } | null
				const error = json?.error
				errorCode = typeof error === "object" ? error?.code : error
			} catch {}

			if (errorCode === "deviceauth_authorization_pending") {
				// Still waiting
			} else if (errorCode === "slow_down") {
				intervalMs += 5000
			} else {
				throw new Error(
					`OpenAI Codex device auth failed with status ${response.status}${body ? `: ${body}` : ""}`,
				)
			}
		}

		const remainingMs = deadline - Date.now()
		if (remainingMs <= 0) break
		if (intervalMs > 0) {
			await sleep(Math.min(intervalMs, remainingMs), options.signal)
		}
	}

	throw new Error("Device flow timed out")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"))
			return
		}
		const timeout = setTimeout(resolve, ms)
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout)
				reject(new Error("Login cancelled"))
			},
			{ once: true },
		)
	})
}

export async function loginWithDeviceCode(options: {
	onDeviceCode: (info: DeviceCodeInfo) => void
	signal?: AbortSignal
	fetch?: FetchFn
}): Promise<CodexToken> {
	const device = await startDeviceAuth({ signal: options.signal, fetch: options.fetch })
	options.onDeviceCode({
		userCode: device.userCode,
		verificationUri: DEVICE_VERIFICATION_URI,
		intervalSeconds: device.intervalSeconds,
	})
	const code = await pollDeviceAuth({
		deviceAuthId: device.deviceAuthId,
		userCode: device.userCode,
		intervalSeconds: device.intervalSeconds,
		signal: options.signal,
		fetch: options.fetch,
	})
	return exchangeCode({
		code: code.authorizationCode,
		codeVerifier: code.codeVerifier,
		redirectUri: DEVICE_REDIRECT_URI,
		signal: options.signal,
		fetch: options.fetch,
	})
}

// ---------------------------------------------------------------------------
// Browser PKCE flow
// ---------------------------------------------------------------------------

let _http: typeof import("node:http") | null = null
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:http").then((m) => {
		_http = m
	})
}

function getCallbackHost(): string {
	return typeof process !== "undefined" ? process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1" : "127.0.0.1"
}

function createState(): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
}

async function createAuthorizationUrl(): Promise<{
	verifier: string
	state: string
	url: string
}> {
	const { verifier, challenge } = await generatePKCE()
	const state = createState()

	const url = new URL(AUTHORIZE_URL)
	url.searchParams.set("response_type", "code")
	url.searchParams.set("client_id", CLIENT_ID)
	url.searchParams.set("redirect_uri", REDIRECT_URI)
	url.searchParams.set("scope", SCOPE)
	url.searchParams.set("code_challenge", challenge)
	url.searchParams.set("code_challenge_method", "S256")
	url.searchParams.set("state", state)
	url.searchParams.set("id_token_add_organizations", "true")
	url.searchParams.set("codex_cli_simplified_flow", "true")
	url.searchParams.set("originator", "pi")

	return { verifier, state, url: url.toString() }
}

interface OAuthServerInfo {
	close: () => void
	cancelWait: () => void
	waitForCode: () => Promise<{ code: string } | null>
}

async function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	if (!_http) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments")
	}

	let settleWait: ((value: { code: string } | null) => void) | undefined
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false
		settleWait = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}
	})

	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost")
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404
				res.setHeader("Content-Type", "text/html; charset=utf-8")
				res.end("<h1>404</h1><p>Callback route not found.</p>")
				return
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400
				res.setHeader("Content-Type", "text/html; charset=utf-8")
				res.end("<h1>400</h1><p>State mismatch.</p>")
				return
			}
			const code = url.searchParams.get("code")
			if (!code) {
				res.statusCode = 400
				res.setHeader("Content-Type", "text/html; charset=utf-8")
				res.end("<h1>400</h1><p>Missing authorization code.</p>")
				return
			}
			res.statusCode = 200
			res.setHeader("Content-Type", "text/html; charset=utf-8")
			res.end(
				"<h1>Success</h1><p>OpenAI authentication completed. You can close this window.</p>",
			)
			settleWait?.({ code })
		} catch {
			res.statusCode = 500
			res.setHeader("Content-Type", "text/html; charset=utf-8")
			res.end("<h1>500</h1><p>Internal error.</p>")
		}
	})

	return new Promise((resolve) => {
		server
			.listen(1455, getCallbackHost(), () => {
				resolve({
					close: () => server.close(),
					cancelWait: () => {
						settleWait?.(null)
					},
					waitForCode: () => waitForCodePromise,
				})
			})
			.on("error", () => {
				settleWait?.(null)
				resolve({
					close: () => {
						try {
							server.close()
						} catch {}
					},
					cancelWait: () => {},
					waitForCode: async () => null,
				})
			})
	})
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim()
	if (!value) return {}

	try {
		const url = new URL(value)
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		}
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2)
		return { code, state }
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value)
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		}
	}

	return { code: value }
}

export async function loginWithBrowser(options: {
	onUrl: (url: string) => void
	onPrompt: () => Promise<string>
	signal?: AbortSignal
	fetch?: FetchFn
}): Promise<CodexToken> {
	const { verifier, state, url } = await createAuthorizationUrl()
	const server = await startLocalOAuthServer(state)

	options.onUrl(url)

	let code: string | undefined
	try {
		// Race between browser callback and manual prompt
		let promptResult: string | undefined
		let promptError: Error | undefined

		const promptPromise = options
			.onPrompt()
			.then((input) => {
				promptResult = input
				server.cancelWait()
			})
			.catch((err) => {
				promptError = err instanceof Error ? err : new Error(String(err))
				server.cancelWait()
			})

		const result = await server.waitForCode()

		if (promptError) {
			throw promptError
		}

		if (result?.code) {
			// Browser callback won
			code = result.code
		} else if (promptResult !== undefined) {
			// Manual input won (or server failed)
			const parsed = parseAuthorizationInput(promptResult)
			if (parsed.state && parsed.state !== state) {
				throw new Error("State mismatch")
			}
			code = parsed.code
		}

		// If still no code, wait for prompt promise and try again
		if (!code) {
			await promptPromise
			if (promptError) {
				throw promptError
			}
			if (promptResult !== undefined) {
				const parsed = parseAuthorizationInput(promptResult)
				if (parsed.state && parsed.state !== state) {
					throw new Error("State mismatch")
				}
				code = parsed.code
			}
		}

		if (!code) {
			throw new Error("Missing authorization code")
		}

		return exchangeCode({
			code,
			codeVerifier: verifier,
			redirectUri: REDIRECT_URI,
			signal: options.signal,
			fetch: options.fetch,
		})
	} finally {
		server.close()
	}
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getTokenFile(): string {
	return process.env.QUARK_CODEX_TOKEN_FILE?.trim()
		|| path.join(os.homedir(), ".config", "quark", TOKEN_FILE_NAME)
}

export function saveToken(token: CodexToken, tokenFile = getTokenFile()): void {
	fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
	const tmpFile = `${tokenFile}.tmp.${Date.now()}`
	fs.writeFileSync(tmpFile, JSON.stringify({ ...token, savedAt: Date.now() }), "utf-8")
	fs.renameSync(tmpFile, tokenFile)
}

export function loadToken(tokenFile = getTokenFile()): CodexToken | null {
	// Retry for transient read errors (file being written by another process).
	// We only retry on errors that could be temporary (empty file, JSON parse
	// error, truncated read). ENOENT (file not found) is not retried.
	let lastError: unknown
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const raw = fs.readFileSync(tokenFile, "utf-8")
			if (raw.length === 0) {
				lastError = new Error("Token file is empty")
				if (attempt < 2) continue
				break
			}
			const data = JSON.parse(raw) as CodexToken & { savedAt?: number }
			if (
				typeof data.access !== "string" ||
				typeof data.refresh !== "string" ||
				typeof data.expires !== "number" ||
				typeof data.accountId !== "string"
			) {
				lastError = new Error(`Token file missing required fields: ${Object.keys(data).join(", ")}`)
				if (attempt < 2) continue
				break
			}
			return {
				access: data.access,
				refresh: data.refresh,
				expires: data.expires,
				accountId: data.accountId,
			}
		} catch (err) {
			lastError = err
			// Only retry on transient errors (empty file, parse error).
			// ENOENT (file missing) and permission errors are not retried.
			const isTransient =
				(err instanceof Error && err.message.includes("Token file is empty")) ||
				(err instanceof SyntaxError) ||
				(err instanceof Error && err.message.includes("unexpected end"))
			if (!isTransient || attempt >= 2) break
		}
	}
	return null
}

