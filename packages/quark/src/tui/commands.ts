// commands — slash command registry for the TUI
//
// Each command has an id (typed without /), a description, and
// optional argument hints. Commands are filtered by fuzzy prefix
// matching against the query (text after /).

export interface SlashCommand {
  id: string
  description: string
  /** Short usage hint shown after the command name, e.g. "<provider:model>" */
  usage?: string
}

/** All available slash commands */
export const commands: SlashCommand[] = [
  { id: "help", description: "Show available commands" },
  { id: "new", description: "Create a new session" },
  { id: "sessions", description: "List or switch sessions", usage: "[session-id]" },

  { id: "model", description: "Switch model", usage: "<model-name>" },
  { id: "agent", description: "Switch agent", usage: "<agent-name>" },
  { id: "profile", description: "Alias for /agent", usage: "<agent-name>" },
  { id: "skills", description: "Add a skill" },
  { id: "settings", description: "Open config in editor (applies on close)" },
  { id: "reload-config", description: "Reload config without restarting" },
  { id: "undo", description: "Undo last agent file changes" },
  { id: "compact", description: "Branch with LLM-compacted history", usage: "[goal]" },
  { id: "steer", description: "Branch with full history" },
  { id: "auth", description: "Show provider authentication status" },
  { id: "connect", description: "Connect a model provider" },
  { id: "statistics", description: "Show token usage statistics and charts" },
  { id: "export", description: "Export conversation history to markdown" },
  { id: "worktree", description: "Switch or create git worktrees", usage: "[create <branch>]" },
  { id: "exit", description: "Exit Quark" },
]

/**
 * Filter commands by prefix match against query.
 * Returns up to `limit` matching commands.
 */
export function filterCommands(query: string, limit = commands.length): SlashCommand[] {
  if (!query) return commands.slice(0, limit)
  const lower = query.toLowerCase()
  return commands
    .filter((cmd) => cmd.id.toLowerCase().startsWith(lower))
    .slice(0, limit)
}
