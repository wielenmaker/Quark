// Tests for web UI connection indicator fix — gh issue #64
//
// The connection indicator (red/green dot) flickered between red and green
// on page refresh because:
//   1. The WebSocket onclose handler always scheduled reconnects, even during
//      cleanup, creating zombie connections
//   2. No health check existed to set connected=true before WS handshake
//   3. Event handlers weren't nulled on cleanup, causing stale callbacks
//
// These tests verify the fix by checking the source and bundle contain:
//   - A cancelled flag to prevent reconnection after cleanup
//   - Proper cleanup that nulls handlers before closing
//   - An initial health check to set connected before WS connects

import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

const APP_SRC_PATH = resolve(import.meta.dir, "../../src/web/client/app.tsx")
const BUNDLE_PATH = resolve(import.meta.dir, "../../src/web/public/bundle.js")

let appSrc: string
let bundle: string

beforeAll(() => {
  appSrc = readFileSync(APP_SRC_PATH, "utf8")
  bundle = readFileSync(BUNDLE_PATH, "utf8")
})

// ── Tests: WebSocket cleanup guard (gh issue #64) ──────────────────────────

describe("WebSocket connection — cancelled flag prevents zombie reconnects (gh issue #64)", () => {
  test("app.tsx declares a cancelled flag variable", () => {
    expect(appSrc).toMatch(/let\s+cancelled\s*=\s*false/)
  })

  test("cleanup sets cancelled = true", () => {
    expect(appSrc).toMatch(/cancelled\s*=\s*true/)
  })

  test("connect function checks cancelled before proceeding", () => {
    expect(appSrc).toMatch(/if\s*\(\s*cancelled\s*\)\s*return/)
  })

  test("onopen checks cancelled before setting connected", () => {
    // The onopen handler should guard against setting state after cleanup
    expect(appSrc).toContain("if (cancelled) return")
  })

  test("onclose checks cancelled before scheduling reconnect", () => {
    // The onclose handler should not schedule reconnects if cancelled
    const oncloseMatch = appSrc.match(/ws\.onclose\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\}/)
    expect(oncloseMatch).not.toBeNull()
    expect(oncloseMatch![1]).toContain("if (cancelled) return")
  })
})

// ── Tests: Cleanup nulls event handlers (gh issue #64) ─────────────────────

describe("WebSocket cleanup — handlers nulled before close (gh issue #64)", () => {
  test("cleanup nulls ws.onopen before closing", () => {
    expect(appSrc).toMatch(/ws\.onopen\s*=\s*null/)
  })

  test("cleanup nulls ws.onclose before closing", () => {
    expect(appSrc).toMatch(/ws\.onclose\s*=\s*null/)
  })

  test("cleanup nulls ws.onerror before closing", () => {
    expect(appSrc).toMatch(/ws\.onerror\s*=\s*null/)
  })

  test("cleanup nulls ws.onmessage before closing", () => {
    expect(appSrc).toMatch(/ws\.onmessage\s*=\s*null/)
  })

  test("cleanup clears reconnect timer", () => {
    expect(appSrc).toMatch(/clearTimeout\s*\(\s*reconnectTimer\s*\)/)
  })
})

// ── Tests: Initial health check (gh issue #64) ────────────────────────────

describe("initial health check — avoids red flash on page load (gh issue #64)", () => {
  test("app.tsx fetches /api/health on mount", () => {
    expect(appSrc).toContain("/api/health")
  })

  test("health check sets connected: true on success", () => {
    // The pattern: api('GET', '/api/health').then(() => set({ connected: true }))
    expect(appSrc).toMatch(/api\(['"]GET['"],\s*['"]\/api\/health['"]\)\.then\(\(\)\s*=>\s*set\(\{\s*connected:\s*true\s*\}\)/)
  })

  test("health check silently catches errors", () => {
    expect(appSrc).toMatch(/\/api\/health.*\.catch\(\(\)\s*=>\s*\{\}\)/)
  })
})

// ── Tests: Bundle verification (gh issue #64) ─────────────────────────────

describe("bundle contains fix artifacts (gh issue #64)", () => {
  test("bundle contains cancelled guard variable", () => {
    expect(bundle).toContain("cancelled")
  })

  test("bundle contains /api/health fetch", () => {
    expect(bundle).toContain("/api/health")
  })

  test("bundle contains reconnect timer clearTimeout", () => {
    expect(bundle).toContain("clearTimeout")
  })
})

// ── Regression guard ───────────────────────────────────────────────────────

describe("source file sanity (gh issue #64)", () => {
  test("bundle.js is non-empty", () => {
    expect(bundle.length).toBeGreaterThan(1000)
  })

  test("app.tsx is non-empty", () => {
    expect(appSrc.length).toBeGreaterThan(500)
  })
})
