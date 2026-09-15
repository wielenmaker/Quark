const backend = Bun.spawn(["bun", "--watch", "web/server.ts"], {
  cwd: `${import.meta.dir}/..`,
  env: { ...process.env, PORT: "4174" },
  stdout: "inherit",
  stderr: "inherit",
})

const frontend = Bun.spawn(["bunx", "vite", "--config", "web/vite.config.ts"], {
  cwd: `${import.meta.dir}/..`,
  stdout: "inherit",
  stderr: "inherit",
})

const stop = () => {
  backend.kill()
  frontend.kill()
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

await Promise.race([backend.exited, frontend.exited])
stop()
