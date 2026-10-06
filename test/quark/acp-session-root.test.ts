import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// `quark acp` must adopt the shared runner namespace before it touches any
// session — otherwise ACP sessions land in the legacy root and vanish from the
// TUI's /sessions picker (and from a client's session/list after a restart).
// Spawned as a real process so the assertion covers the entrypoint itself, not
// the helper it is supposed to call.
test(
  "quark acp stores sessions in the runner namespace",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "quark-acp-root-"))
    const repoRoot = resolve(import.meta.dir, "..", "..")
    const probe = join(home, "probe.ts")
    try {
      await Bun.write(
        probe,
        [
          `import { runAcpCommand } from ${JSON.stringify(join(repoRoot, "packages/quark/src/acp-host.ts"))}`,
          `import { getSessionStorageRoot } from ${JSON.stringify(join(repoRoot, "packages/runner/src/storage/session-path.ts"))}`,
          `process.exitCode = await runAcpCommand([])`,
          `console.error("PROBE-ROOT=" + getSessionStorageRoot())`,
        ].join("\n"),
      )
      const proc = Bun.spawn(["bun", probe], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      expect(exitCode).toBe(0)
      expect(stderr).toContain(`PROBE-ROOT=${join(home, ".config", "quark", "session", "runners")}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
  15_000,
)
