# syntax=docker/dockerfile:1
#
# The Beckon server: Next.js app, WebSocket gateways, migrations. One image for Fly.io and for
# self-hosting (docs/deploy.md). Build context is the repository root:
#   docker build -t beckon .
#
# Production does not run through tsx: the custom server and the migration runner are compiled to
# dist/*.mjs by `npm run build`.

# Pinned by version and digest; Dependabot proposes updates (.github/dependabot.yml).
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY web/ ./
# Service worker (public/sw.js), `next build`, and dist/server.mjs + dist/migrate.mjs.
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
WORKDIR /app
# The base image's unprivileged `node` user (uid 1000) runs everything; nothing is writable by it
# except what Next needs for its cache.
COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/next.config.ts ./next.config.ts
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/drizzle ./drizzle
COPY --from=build --chown=root:root /app/install ./install
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=node:node /app/.next ./.next
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Apply migrations first with: node dist/migrate.mjs  (Fly does this as its release_command)
CMD ["node", "dist/server.mjs"]
