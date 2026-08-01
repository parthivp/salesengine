# syntax=docker/dockerfile:1

# Debian slim rather than Alpine, deliberately.
#
# Alpine uses musl, and musl's resolver returned *only* AAAA records for
# `login.microsoftonline.com` — no IPv4 addresses at all. Docker Desktop gives
# containers no IPv6 route, so every call to Entra and Graph failed with
# ENETUNREACH, surfacing as a bare "fetch failed" on the mailbox connect screen
# and implicating credentials that were correct.
#
# Nothing above the resolver could fix it, and all of it was tried:
# `--dns-result-order=ipv4first` had no IPv4 addresses to reorder;
# `--no-network-family-autoselection` had nothing to fall back to; disabling IPv6
# in the container's network namespace did not change what musl returned. glibc
# resolves the same name to IPv4 and the problem disappears.
#
# The cost is a larger image — roughly 150 MB against 50 — which is a bad trade
# only if the smaller one works.

# ---- deps -------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ----------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma needs a URL present at generate time; the real one is injected at runtime.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DIRECT_DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV AUTH_SECRET="build-time-placeholder-secret-not-used-at-runtime"
ENV ENCRYPTION_KEY="buildtimeplaceholderkey_32bytes!"
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate
RUN npm run build

# ---- runner -----------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The node images already ship a `node` user at uid 1000, so 1001 is free.
RUN groupadd --gid 1001 nodejs \
 && useradd --uid 1001 --gid nodejs --create-home --shell /usr/sbin/nologin nextjs

# Next standalone output: server.js plus only the modules it actually needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The worker, migrations and the operator scripts all run from this same image,
# so it needs the full node_modules, the Prisma schema, the TypeScript sources
# and scripts/ — the compose `migrate` step runs scripts/provision-db.ts, and
# `docker compose exec app` is how a workspace gets created and readiness checked.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# Debian puts tini in /usr/bin; Alpine put it in /sbin.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
