// slash — slash command registry for the web composer
//
// Mirrors the filtering behaviour of the TUI palette: the palette opens
// when the composer text starts with "/", and matches are ranked with
// prefix hits first, then substring hits. Once the user types a space the
// palette closes and the rest of the line becomes the command arguments.

export interface SlashCommand {
  id: string
  description: string
  /** Usage hint shown after the command name; presence means the command takes arguments. */
  usage?: string
}

/** Slash commands the web client can execute */
export const slashCommands: SlashCommand[] = [
  { id: "help", description: "Show available commands" },
  { id: "new", description: "Create a new session" },
  { id: "clear", description: "Clear messages and start new session" },
  { id: "sessions", description: "Switch to another session" },
  { id: "model", description: "Switch model", usage: "[provider/model]" },
  { id: "profile", description: "Switch profile", usage: "[profile-name]" },
  { id: "skills", description: "Add a skill", usage: "<skill-name>" },
  { id: "compact", description: "Branch with LLM-compacted history", usage: "[goal]" },
  { id: "steer", description: "Branch with full history", usage: "[goal]" },
  { id: "undo", description: "Undo last agent file changes" },
  { id: "export", description: "Export conversation history to markdown" },
  { id: "reload-config", description: "Reload config without restarting" },
]

export interface SlashParts {
  id: string
  args: string
  /** True once the user typed a space after the command, which closes the palette. */
  hasArgs: boolean
}

/** Splits composer text into slash command parts, or null when it is a plain message. */
export function slashParts(text: string): SlashParts | null {
  const firstLine = text.split("\n")[0]!
  if (!firstLine.startsWith("/")) return null
  const body = firstLine.slice(1)
  const space = body.search(/\s/)
  if (space === -1) return { id: body, args: "", hasArgs: false }
  return { id: body.slice(0, space), args: body.slice(space + 1).trim(), hasArgs: true }
}

/** Returns the command id being typed, or null when the text is not a slash command. */
export function slashQuery(text: string): string | null {
  const parts = slashParts(text)
  return parts ? parts.id : null
}

export function filterSlashCommands(query: string, limit = slashCommands.length): SlashCommand[] {
  if (!query) return slashCommands.slice(0, limit)
  const needle = query.toLowerCase()
  const prefix: SlashCommand[] = []
  const partial: SlashCommand[] = []
  for (const command of slashCommands) {
    const id = command.id.toLowerCase()
    if (id.startsWith(needle)) prefix.push(command)
    else if (id.includes(needle) || command.description.toLowerCase().includes(needle)) partial.push(command)
  }
  return [...prefix, ...partial].slice(0, limit)
}

export function findSlashCommand(id: string): SlashCommand | undefined {
  return slashCommands.find((command) => command.id === id)
}
