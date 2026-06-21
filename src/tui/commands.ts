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

  { id: "clear", description: "Clear messages and start new session" },
  { id: "model", description: "Switch model", usage: "<model-name>" },
  { id: "profile", description: "Switch profile", usage: "<profile-name>" },
  { id: "skills", description: "Add a skill" },
  { id: "settings", description: "Open config in editor" },
  { id: "reload-config", description: "Reload config without restarting" },
  { id: "undo", description: "Undo last agent file changes" },
  { id: "steer", description: "Branch to a new session with a goal", usage: "<goal>" },
  { id: "goal", description: "Pursue a goal autonomously until done", usage: "<goal description>" },
  { id: "statistics", description: "Show token usage statistics and charts" },
  { id: "worktree", description: "Switch or create git worktrees", usage: "[create <branch>]" },
  { id: "tool list", description: "List user tools available in ~/.config/quark/tools/" },
  { id: "tool add", description: "Temporarily load a user tool into this session", usage: "<id>" },
  { id: "exit", description: "Exit Quark" },
]

/**
 * Filter commands by prefix match against query.
 * Returns up to `limit` matching commands.
 */
export function filterCommands(query: string, limit = 30): SlashCommand[] {
  if (!query) return commands.slice(0, limit)
  const lower = query.toLowerCase()
  return commands
    .filter((cmd) => cmd.id.toLowerCase().startsWith(lower))
    .slice(0, limit)
}
