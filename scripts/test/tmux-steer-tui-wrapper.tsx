// Wrapper for tmux steer test — sets isolated storage roots before booting TUI
import { setSessionStorageRoot } from "../../src/storage/session-path"
import { setTaskStorageRoot } from "../../src/task/task"

async function main() {
  const sessionDir = process.env.QUARK_TEST_SESSION_DIR
  const taskDir = process.env.QUARK_TEST_TASK_DIR
  if (sessionDir) setSessionStorageRoot(sessionDir)
  if (taskDir) setTaskStorageRoot(taskDir)
  await import("../../src/tui/index.tsx")
}

main()
