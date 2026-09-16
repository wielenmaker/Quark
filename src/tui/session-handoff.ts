// Session handoff — publish the active session id to an external supervisor.
//
// The TUI is a child process of quari-orch (or any similar orchestrator), which
// needs to know *which* session the user is looking at so it can resume that
// conversation after a relaunch. Nothing else we emit carries the id: the OSC
// terminal title holds the session *title*, and `session/index.json` cannot
// tell two sessions in the same directory apart.
//
// The supervisor names a file through `QUARK_ORCH_SESSION_ID_FILE` and reads
// the id back from it. Opt-in: with the variable unset, this module is inert.

import { renameSync, writeFileSync } from "node:fs"

const handoffPath = process.env.QUARK_ORCH_SESSION_ID_FILE

/**
 * Publish the session the TUI is currently showing.
 *
 * Called from `setActiveSession()` — the single owner of session transitions
 * in `index.tsx` — so resume, lazy creation, branches, and `/new` all report
 * through one path.
 *
 * A `null` id means "no session yet" and is deliberately *not* published: the
 * previous id is still a valid thing to resume, and blanking the file would
 * throw it away for no gain.
 *
 * @param sessionId - The session now owning the transcript, or `null`.
 */
export function reportActiveSession(sessionId: string | null): void {
  if (!handoffPath || !sessionId) return

  try {
    // Temp + rename, so a supervisor watching the directory can never read a
    // half-written id. Small enough that the extra syscall is irrelevant.
    const tmpPath = `${handoffPath}.tmp`
    writeFileSync(tmpPath, `${sessionId}\n`)
    renameSync(tmpPath, handoffPath)
  } catch {
    // Best effort by design. A supervisor that misses the id loses resume —
    // annoying, but never a reason to take the TUI down.
  }
}
