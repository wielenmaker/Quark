// tree-sitter.ts — singleton TreeSitterClient for syntax highlighting in the TUI
//
// Bundled parsers (from @opentui/core):  javascript, typescript, markdown, markdown_inline, zig
// Extra parsers registered here:         python, bash (+ sh/shell aliases)
//
// Wasm files are fetched from jsDelivr and highlights.scm from the official
// tree-sitter repos. Both are downloaded once and cached locally on first use.
//
// Call initTreeSitter() once at app startup (fire-and-forget).
// Retrieve the client with getTreeSitter() and pass it to <markdown>.

import { addDefaultParsers, getTreeSitterClient } from "@opentui/core"
import type { TreeSitterClient } from "@opentui/core"

export type { TreeSitterClient }

const PYTHON_WASM = "https://cdn.jsdelivr.net/npm/tree-sitter-python@0.25.0/tree-sitter-python.wasm"
const PYTHON_HIGHLIGHTS = "https://raw.githubusercontent.com/tree-sitter/tree-sitter-python/v0.25.0/queries/highlights.scm"

const BASH_WASM = "https://cdn.jsdelivr.net/npm/tree-sitter-bash@0.25.0/tree-sitter-bash.wasm"
const BASH_HIGHLIGHTS = "https://raw.githubusercontent.com/tree-sitter/tree-sitter-bash/v0.25.0/queries/highlights.scm"

// Extra language parsers not bundled in @opentui/core.
// Shell aliases (sh, shell, zsh) share the bash wasm so all common code-fence
// info strings get highlighted — the markdown injection query maps info strings
// directly to filetype names when not in infoStringMap, so each alias needs its
// own registration.
const EXTRA_PARSERS = [
  {
    filetype: "python",
    queries: { highlights: [PYTHON_HIGHLIGHTS] },
    wasm: PYTHON_WASM,
  },
  {
    filetype: "py",
    queries: { highlights: [PYTHON_HIGHLIGHTS] },
    wasm: PYTHON_WASM,
  },
  {
    filetype: "bash",
    queries: { highlights: [BASH_HIGHLIGHTS] },
    wasm: BASH_WASM,
  },
  {
    filetype: "sh",
    queries: { highlights: [BASH_HIGHLIGHTS] },
    wasm: BASH_WASM,
  },
  {
    filetype: "shell",
    queries: { highlights: [BASH_HIGHLIGHTS] },
    wasm: BASH_WASM,
  },
  {
    filetype: "zsh",
    queries: { highlights: [BASH_HIGHLIGHTS] },
    wasm: BASH_WASM,
  },
]

let initialized = false

export function initTreeSitter(): void {
  if (initialized) return
  initialized = true

  addDefaultParsers(EXTRA_PARSERS)

  getTreeSitterClient()
    .initialize()
    .catch((err: unknown) => {
      console.error("[tree-sitter] Failed to initialize:", err)
    })
}

export function getTreeSitter(): TreeSitterClient {
  return getTreeSitterClient()
}
