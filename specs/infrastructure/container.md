# Container Environment

Run Quark inside a Docker container with source mounted from the host.

## Files

- `Dockerfile` — `oven/bun:1.3.10` base, installs deps, entrypoint via `src/cli.ts`
- `docker-compose.yml` — mounts source, isolates node_modules, mounts config
- `.dockerignore` — excludes node_modules, dist, logs

## Volume strategy

| Mount | Purpose |
|---|---|
| `.:/quark` | Quark source (live, from host) |
| `/quark/node_modules` | Anonymous volume — Linux deps, not macOS |
| `~/.config/quark:/root/.config/quark` | Config + sessions (shared with host) |

## Usage

```bash
# Build
docker compose build

# Run TUI
docker compose run --rm quark

# Work on a project
docker compose run --rm -v ~/your-project:/workspace -w /workspace quark
```

## Notes

- `node_modules` inside the container is isolated from the host's macOS node_modules
- Sessions are shared with host Quark — do not run both simultaneously
- API keys: if config.yaml uses `env:VAR_NAME`, pass vars via `docker compose run -e KEY=val`
- TTY is required for the TUI (`stdin_open: true` + `tty: true` in compose)
