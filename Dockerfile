# Build the browser bundle.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run web:build

# Run only production dependencies and the server sources.
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY --from=build /app/web/dist ./web/dist
COPY web/backend.ts web/server.ts ./web/
COPY src ./src
EXPOSE 4173
VOLUME ["/root/.config/quark"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:4173/api/health');if(!r.ok)process.exit(1)"
CMD ["bun", "run", "web:serve"]
