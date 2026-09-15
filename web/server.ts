import { WebBackend } from "./backend"
import * as path from "path"

const backend = await WebBackend.create()
const publicDir = path.resolve(import.meta.dir, "dist")

async function serve(request: Request, server: Bun.Server<undefined>): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === "/api/health" && request.method === "GET") {
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
  }
  if (url.pathname.startsWith("/api/")) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Allow": "GET, POST, OPTIONS" } })
    }
    const response = await backend.fetch(request)
    // Event streams stay idle between updates; their heartbeat exceeds Bun's default timeout.
    if (response.headers.get("Content-Type")?.startsWith("text/event-stream")) server.timeout(request, 0)
    response.headers.set("X-Content-Type-Options", "nosniff")
    response.headers.set("Referrer-Policy", "no-referrer")
    return response
  }

  const pathname = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
  const filePath = path.resolve(publicDir, pathname)
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) return new Response("Not found", { status: 404 })

  const securityHeaders = {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  }

  const file = Bun.file(filePath)
  if (await file.exists()) {
    const immutable = /\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname)
    return new Response(file, { headers: {
      ...securityHeaders,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    } })
  }

  const index = Bun.file(path.join(publicDir, "index.html"))
  return await index.exists()
    ? new Response(index, { headers: { ...securityHeaders, "Cache-Control": "no-cache" } })
    : new Response("Run bun run web:build first", { status: 503, headers: securityHeaders })
}

const hostname = Bun.env.HOST ?? "127.0.0.1"
const port = Number(Bun.env.PORT ?? 4173)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${Bun.env.PORT}`)
}

const server = Bun.serve({
  hostname,
  port,
  fetch: serve,
  error(error) {
    console.error("[web] Unhandled request error", error)
    return Response.json({ error: "Internal server error" }, { status: 500 })
  },
})

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  server.stop(true)
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)

console.log(`Quark web: ${server.url}`)
