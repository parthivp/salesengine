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
| 3 | Email engine — SES, mailboxes, sequences, scheduler, deliverability | **Shipped** |
| 4 | CRM — connector layer, Salesforce adapter, field mapping, sync | **Shipped** |
| 5 | Workflow — tasks, follow-ups, pipeline, reporting | **Shipped** |
| 6 | LinkedIn — Sales Nav import, AI drafting, human-in-the-loop queue | Next |
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
| `EMAIL_TRANSPORT` | `log` \| `ses` \| `auto`. **Set `log` anywhere that is not production.** |
| `AWS_*`, `SES_CONFIGURATION_SET` | Email sending via SES. |
| `SALESFORCE_CLIENT_*` | Salesforce Connected App, for CRM sync. |

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
npm test    # 166 tests, incl. 6 that try and fail to cross the tenant boundary
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
  components/              sidebar, topbar, shared UI, charts
  lib/
    db.ts                  Prisma clients, withTenant(), tenant context
    auth.ts                sessions, login, permission guards
    rbac.ts                permissions and record visibility
    crypto.ts              AES-256-GCM sealing, token hashing
    queue.ts               BullMQ queues, job registry, repeatables
    audit.ts               append-only trail
    crm/
      types.ts             the CrmAdapter contract
      mapping.ts           field mapping, transforms, conflict resolution
      sync.ts              the sync engine: echo suppression, watermarks, conflicts
      salesforce.ts        first adapter
      fake.ts              in-memory CRM used to test convergence
    workflow/
      tasks.ts             queue ordering, outcome chaining
      pipeline.ts          rot detection, weighted forecast, stage moves
      reports.ts           funnels, leaderboard, deliverability summary
    email/
      merge.ts             merge-tag rendering with fallbacks
      schedule.ts          sending windows, timezones, mailbox capacity
      send.ts              transports, signed tracking + unsubscribe links
      deliverability.ts    SPF/DKIM/DMARC, content linting, reputation
  worker/
    index.ts               worker process entrypoint
    handlers.ts            job registry
    jobs/
      sequence.ts          the step machine, enrollment, reply handling
      enrichment.ts        Apollo enrichment and rescoring
      crm.ts               sync jobs, OAuth token refresh
```

---

## Numbers we refuse to show

Three places deliberately show a dash instead of a figure, because the figure would
be worse than nothing:

- **Rates under a meaningful sample.** A rep with 3 sends and 1 reply is not a 33%
  performer. Rates below 20 sends (50 for deliverability) return null.
- **Win rate with nothing closed.** Computed over closed deals only — including open
  ones understates it early in a quarter and makes it useless for comparison.
- **Unparseable numbers pushed to a CRM.** `"unknown"` employees becomes null, not 0.

The leaderboard is also ranked by outcomes — won value, meetings, replies — never by
emails sent. Ranking on volume rewards exactly the behaviour that burns a domain.

Charts follow the bundled data-viz method: palettes were run through its validator
against this app's actual surface rather than chosen by eye, every chart has a table
twin so no value is reachable only by hover, and the funnel uses a single-hue ordinal
ramp (a value-ramp on ordered stages) rather than categorical colour.

---

## Sending safety

Real sending is opted into, never inherited. `EMAIL_TRANSPORT=log` runs the entire engine —
scheduling, rendering, tracking links, status transitions — without anything leaving the
server.

This exists because it caught a real problem during development: the build environment had
ambient AWS credentials, so `auto` armed live SES sending in a *test run*. Any CI runner or
laptop with a shared AWS profile has the same exposure.

The engine also refuses to send in these cases rather than sending something wrong:

- an unresolved merge tag (`Hi {{first_name}},` reaching a prospect)
- a mailbox failing SPF or DKIM
- every mailbox at its daily cap — it defers instead
- the contact replied, unsubscribed, bounced, or a colleague at the same account replied
- bounce or complaint rates approaching the AWS thresholds

---

## CRM sync

One internal contract (`CrmAdapter`), many adapters. Everything expensive — the sync engine,
field mapping, conflict resolution, watermarks, retry — sits *above* that interface, so the
second adapter costs a fraction of the first.

The engine's defining risk is the echo loop: in bidirectional sync, a write can bounce between
systems forever, burning API quota while appearing to work. Two things prevent it:

- only the **mapped projection** is hashed, so a change to an unmapped field is not a change;
- empty and absent values hash identically, so a record pulled from a CRM that leaves a field
  blank does not immediately look "changed" and get pushed back.

Both are covered by tests that run five full sync cycles and assert zero writes after the first.

Conflicts are resolved from an explicit per-connection policy (newest wins / CRM wins / app
wins / ask me). When the policy cannot decide — both sides changed and timestamps are missing
or identical — the record is **flagged rather than guessed**, and neither version is
overwritten until a human chooses. Some local fields (`score`, `unsubscribedAt`, `tenantId`)
can never be written by a CRM, whatever the mapping says.

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
| `npm run db:seed-sequences` | Seed a mailbox, templates and a live sequence, driven through the real engine |
| `npm run start:standalone` | Copy static assets into the standalone build and run it |
| `npm run db:studio` | Prisma Studio |
| `npm test` | Vitest, incl. isolation tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm run db:provision` | Role password, grants, and the row-level-security audit |
| `npm run check` | Readiness report; exits non-zero on a blocker |
| `npm run tenant:create` | Create a real workspace and its first owner |
| `node scripts/init-env.mjs` | Create `.env` and generate the required secrets |
| `node scripts/smoke.mjs` | Walk every route as each role; fails on any error or wrong authorization |

## Deploying

Step-by-step, local first then online: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

```bash
cp .env.example .env      # fill in AUTH_SECRET, ENCRYPTION_KEY, APP_DB_PASSWORD
docker compose up -d --build
```

The `migrate` service runs before the app and worker start, and does three things:
applies migrations, sets the runtime role's password from `APP_DB_PASSWORD`, and
**verifies that row-level security covers every tenant-scoped table**. If a table
carrying a `tenantId` has no policy, it exits non-zero and the app never starts —
a tenant-isolation hole fails the deploy rather than going live.

Two database roles, and the distinction is load-bearing:

| Role | Used by | Row-level security |
|---|---|---|
| `salesengine` (owner) | migrations, seeds, the platform-admin page | **bypassed** |
| `salesengine_app` | app, worker — everything serving a request | enforced |

Running the app as the owner turns tenant isolation off completely, while every
application-level check goes on looking correct and every test goes on passing.
The compose file wires this correctly and `deployment.test.ts` fails if that ever
changes.

After deploying, check what is still missing:

```bash
npm run check          # or npm run check <tenant-slug>
```

It exits non-zero on a blocker, so it works as a deploy gate. The same report is
at **Admin → Readiness**. Every item on it is a way the system can look healthy
and do nothing — a dead worker, an unverified sending domain, a mailbox nobody
polls. A dashboard full of zeroes reads as a quiet week whichever it is.

The worker writes a heartbeat every minute; the app treats a three-minute gap as
"gone". That check is a queued job rather than a timer inside the process, so it
proves the worker is still *draining its queues* — a worker wedged on a poisoned
job is as useless as one that has crashed, and only the queued version notices.

To run the same checks against a database you provisioned by hand:

```bash
npm run db:deploy      # prisma migrate deploy
npm run db:provision   # role password, grants, and the RLS audit
```

## Dependency advisories

`npm audit` reports zero vulnerabilities in what ships:

```
npm audit --omit=dev     # none
```

The full audit reports 9 high advisories, all in the **dev-only lint toolchain**
and all the same root cause: `eslint-plugin-import@2.32.0` (the current release)
depends on `minimatch@^3`, which depends on a `brace-expansion` with an
unbounded-expansion DoS. Nothing here is reachable at runtime — the linter runs
over this repo's own source, on a developer machine, and is not part of the build
output.

Two fixes were tried and reverted, because both broke the toolchain while
satisfying the audit:

- **Overriding `brace-expansion` to a patched 5.x.** `minimatch@3` does
  `require('brace-expansion')` and calls the result; v5 exports a namespace
  object, so every lint run died with `TypeError: expand is not a function`.
- **Upgrading to `eslint@10`**, which npm suggests. `eslint-plugin-react` — a
  dependency of `eslint-config-next` — declares `eslint: ^9.7` at most, and eslint
  10 changed a rule-context API it uses, so linting failed with
  `contextOrFilename.getFilename is not a function`.

The remaining advisories clear when `eslint-plugin-import` moves off `minimatch@3`.
Re-check on any `eslint-config-next` upgrade. A linter that runs is worth more
than a green audit for a DoS in a glob parser we feed our own config to.

Overrides that *are* in place, in `package.json`:

| Package | Why |
|---|---|
| `postcss` → 8.5.25 | Next pins 8.4.31 internally (sourceMappingURL path traversal, XSS) |
| `sharp` → 0.35.3 | Next pins 0.34.5 (inherited libvips CVEs) |
