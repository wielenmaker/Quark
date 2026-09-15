import { afterEach, describe, expect, test } from "bun:test"
import { Api } from "../../web/src/api"

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

describe("web API errors", () => {
  test("handles a non-JSON server failure", async () => {
    globalThis.fetch = (async () => new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch
    await expect(new Api().state()).rejects.toThrow("Request failed (502 Bad Gateway)")
  })

  test("reports an unreachable backend", async () => {
    globalThis.fetch = (async () => { throw new TypeError("offline") }) as unknown as typeof fetch
    await expect(new Api().state()).rejects.toThrow("Unable to reach Quark: offline")
  })
})
