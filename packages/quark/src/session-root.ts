// CLI/TUI/ACP sessions share the same on-disk namespace as REST runners.
// Call only in app entrypoints (CLI, TUI, ACP host), before initializing
// storage or loading sessions.
import { join } from "node:path"
import { getSessionStorageRoot, setSessionStorageRoot } from "@quark/runner/storage/session-path"

export function useRunnerSessionRoot(): void {
  setSessionStorageRoot(join(getSessionStorageRoot(), "runners"))
}
