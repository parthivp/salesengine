# syntax=docker/dockerfile:1

# ---- deps -------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ----------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
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
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl tini
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Next standalone output: server.js plus only the modules it actually needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The worker and migrations run from the same image, so they need the full
# node_modules, the Prisma schema and the TypeScript sources.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
