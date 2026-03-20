## Project-Specific Rules

### Atom Development
- All tools (except `read` and `skill`) must be loaded from `~/.config/atom/tools/`
- Show floating notifications (top-right) when tools fail to load
- Tools are standalone TypeScript files with zod schemas

### Testing
- Test with `bun` instead of `npm`
- Use tmux for TUI testing to avoid terminal conflicts
