# SalesEngine

Multi-tenant sales engagement platform — lead intelligence, sequenced outreach, CRM sync.

Apollo-style prospecting and enrichment, Dripify-style multi-step sequences, bi-directional
CRM sync starting with Salesforce, and a compliant LinkedIn workflow that carries no
account-ban risk.

See [PLAN.md](./PLAN.md) for the full feature set, architecture and delivery roadmap.

---

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold — Compose stack, Prisma, worker, CI | **Shipped** |
| 1 | Foundation — tenancy + RLS, auth, RBAC, teams, audit log | **Shipped** |
| 2 | Lead database — contacts, accounts, CSV import, capture, Apollo enrichment, scoring | **Shipped** |
| 3 | Email engine — SES, mailboxes, sequences, scheduler, deliverability | Next |
| 4 | CRM — connector layer, Salesforce adapter, field mapping, sync | Planned |
| 5 | Workflow — tasks, follow-ups, pipeline, reporting | Planned |
| 6 | LinkedIn — Sales Nav import, AI drafting, human-in-the-loop queue | Planned |
| 7 | Scale-out — HubSpot adapter, public API, webhooks | Planned |
| 8 | Commercial — Stripe billing, self-serve signup | Planned |

---

## Quick start

```bash
git clone <this repo> && cd salesengine
cp .env.example .env          # then fill in AUTH_SECRET and ENCRYPTION_KEY

# Backing services only; app and worker run on the host with hot reload.
docker compose -f docker-compose.dev.yml up -d

npm install
npm run db:deploy             # applies migrations, including the RLS policies
npm run db:seed               # creates the demo tenant

npm run dev                   # terminal 1 — http://localhost:3000
npm run worker:dev            # terminal 2 — sequence scheduler and jobs
```

Sign in with `parthiv@acme.test` / `ChangeMe12345`.

### Whole stack in containers

```bash
docker compose up -d --build
```

Boots Postgres, Redis, migrations, the app and the worker. This is what runs on the VPS.

---

## Required configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection. Must use the **restricted** role — RLS does not apply to superusers. |
| `DIRECT_DATABASE_URL` | Owner role with `BYPASSRLS`. Migrations, seeds and platform-admin queries only. |
| `REDIS_URL` | BullMQ backing store. |
| `AUTH_SECRET` | ≥32 chars. Session signing. |
| `ENCRYPTION_KEY` | Exactly 32 bytes. AES-256-GCM for OAuth tokens and mailbox credentials. |
| `APOLLO_API_KEY` | Lead search and enrichment (Phase 2). |
| `AWS_*`, `SES_CONFIGURATION_SET` | Email sending (Phase 3). |
| `SALESFORCE_CLIENT_*` | CRM connected app (Phase 4). |

The app validates all of these at boot and refuses to start on a bad config — a missing
`AUTH_SECRET` in production should be a crash, not a silently forgeable session.

---

## Tenant isolation

Three layers, deliberately redundant:

1. **Request context** — `AsyncLocalStorage` carries the resolved tenant from the session to
   the data layer, so no function threads it by hand.
2. **Explicit `tid()`** — writes state their tenant (`data: { tenantId: tid(), ... }`), which
   throws outside a tenant context. An earlier draft injected it invisibly via a Prisma client
   extension; that was removed because TypeScript could not verify the injection, so every
   create site type-checked as if `tenantId` were optional.
3. **Postgres RLS** — every table carrying `tenantId` has `FORCE ROW LEVEL SECURITY` with a
   policy keyed on `current_setting('app.current_tenant')`. When unset it evaluates to NULL,
   so the default is *no rows*. Fail-closed by construction.

Layer 3 is the one that matters: a forgotten `where` clause, a raw query, or a future bug
still cannot read or write another tenant's data.

```bash
npm test    # 24 tests, incl. 6 that try and fail to cross the tenant boundary
```

---

## Layout

```
prisma/
  schema.prisma            data model
  migrations/              includes the RLS policy migration
  seed.ts                  demo tenant + an isolation counterparty
src/
  app/
    (auth)/                login, logout
    (app)/                 authenticated shell — dashboard, pipeline, outreach, admin
  components/              sidebar, topbar, shared UI
  lib/
    db.ts                  Prisma clients, withTenant(), tenant context
    auth.ts                sessions, login, permission guards
    rbac.ts                permissions and record visibility
    crypto.ts              AES-256-GCM sealing, token hashing
    queue.ts               BullMQ queues, job registry, repeatables
    audit.ts               append-only trail
  worker/
    index.ts               worker process entrypoint
    handlers.ts            job handlers incl. the sequence scheduler tick
```

---

## A note on LinkedIn

This project does not automate LinkedIn against their User Agreement, and implements no
detection evasion — no fingerprint rotation, no residential proxies, no humanised timing.

Phase 6 instead builds the target list, drafts the message, and queues it for the rep to send
from their own browser in one click. ~3 seconds per action instead of ~2 minutes, with no
automation fingerprint and no risk to the account. Everything else in the product is fully
automated.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run worker:dev` | Worker with reload |
| `npm run build` | Production build |
| `npm run db:migrate` | Create + apply a migration |
| `npm run db:deploy` | Apply pending migrations |
| `npm run db:seed` | Seed tenants and users |
| `npm run db:seed-demo` | Seed realistic contacts/accounts through the real import path |
| `npm run db:rescore` | Recompute all scores after changing scoring rules |
| `npm run db:studio` | Prisma Studio |
| `npm test` | Vitest, incl. isolation tests |
| `npm run typecheck` | `tsc --noEmit` |
