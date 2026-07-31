# Deployment

Two stages: prove it works on your laptop, then put the same artifact on a server.

The point of doing it in that order is that the thing you test locally is byte-for-byte
the thing you deploy — same image, same compose file, same migration and provisioning
steps. Nothing about the server is special.

---

## Stage 1 — Local, on Windows

### What you need

**Docker Desktop** ([docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)),
with the WSL2 backend, which is the default on Windows 11. Nothing else — no Node, no
Postgres, no Redis on the host. The compose stack brings all of it.

Give Docker at least **4 GB** of memory (Settings → Resources). Postgres, Redis, the app
and the worker together sit at roughly 1.5 GB idle.

### 1. Get the code

```powershell
cd $env:USERPROFILE\source\salesengine
git pull
```

### 2. Create `.env`

One command, and it needs nothing installed on the host but Docker:

```powershell
docker run --rm -v "${PWD}:/w" -w /w node:22-alpine node scripts/init-env.mjs
```

That copies `.env.example`, generates `AUTH_SECRET`, `ENCRYPTION_KEY` and
`APP_DB_PASSWORD` at the exact lengths the schema requires, and prints what it did.
It is safe to re-run — it fills in blanks and never overwrites a value that is already
set, because regenerating `AUTH_SECRET` would sign everyone out.

**Copying `.env.example` by hand is not enough.** It ships those three keys as `""`,
and Docker Compose treats an empty value exactly like a missing one:

```
error while interpolating services.migrate.environment.APP_DB_PASSWORD:
required variable APP_DB_PASSWORD is missing a value
```

That message is byte-identical whether `.env` is absent or present-with-blanks, so it
cannot tell you which you have. To check by hand:

```powershell
Test-Path .env
Select-String -Path .env -Pattern '^(AUTH_SECRET|ENCRYPTION_KEY|APP_DB_PASSWORD)='
```

The secrets are hex on purpose: they are substituted into database URLs, where a `@`,
`:`, `/`, `#` or `?` silently produces a malformed connection string rather than an
error you can read.

Leave everything else alone for now. In particular leave:

```
EMAIL_TRANSPORT="log"
```

so nothing can send real mail while you are poking at it. `.env` is gitignored.

### 3. Start it

```powershell
docker compose up -d --build
```

The first build takes a few minutes. The order is enforced by the compose file:
`postgres` and `redis` become healthy → `migrate` runs and must exit successfully →
`app` and `worker` start.

Watch it:

```powershell
docker compose logs -f migrate
```

You want to see:

```
✓ salesengine_app password set from APP_DB_PASSWORD
✓ grants refreshed for salesengine_app
Row-level security across 23 tenant-scoped tables:
  ✓ all 23 enabled, FORCEd, and carrying a policy
Provisioning complete.
```

If that step fails, `app` and `worker` never start — deliberately. A tenant-scoped table
without a row-level-security policy is a table one workspace can read from another, and
that should stop a deploy rather than go live.

### 4. Create your workspace

The database is empty. There is no self-serve signup — this is internal-first by design —
so the first account is made from the command line:

```powershell
docker compose exec app npx tsx scripts/create-tenant.ts
```

It prompts for a workspace name, your name, email and password. The first account created
on a deployment also becomes its platform admin.

If you would rather look at demo data first, `docker compose exec app npx tsx prisma/seed.ts`
creates two fake workspaces with `.test` addresses and the password `ChangeMe12345`. Do not
do that on a server you intend to keep.

### 5. Look at it

Open **http://localhost:3000** and sign in.

Then go to **Admin → Readiness**. It will tell you exactly what is not yet configured. On a
fresh local stack it should show the worker alive, Redis reachable, migrations applied, and
warn that email transport is `log` and that no mailbox is polled for replies. That is the
correct state for a local test.

The same report from a terminal:

```powershell
docker compose exec app npx tsx scripts/check.ts
```

### What this has been tested against

Every step above was rehearsed in a Linux container environment before you run it,
against the real `postgres:16-alpine` and `redis:7-alpine` images, with the app and
worker running from an image and talking over a compose network:

- all three migrations applied to a virgin database
- `provision-db.ts` set the runtime password and reported 23 of 23 tenant tables
  `ENABLE`d, `FORCE`d and carrying a policy, exiting 0
- tenant isolation proven directly in SQL: workspace A sees only A's rows, B only
  B's, no tenant context returns nothing, and a cross-tenant insert is refused with
  `new row violates row-level security policy`
- the worker registered its schedules and wrote heartbeats that the app container
  read through Redis
- a workspace created with `create-tenant.ts`, and authenticated requests to
  `/dashboard`, `/admin/readiness`, `/admin/users` and `/inbox` all returning 200
  with the real workspace name rendered

The one step that could not be rehearsed is the image build itself — that sandbox
blocked Alpine's package CDN and the npm registry from inside containers, so
`apk add` and `npm ci` could not run there. Those work normally on your machine.
If the build fails, it will fail at one of those two lines and it will be a network
or proxy problem, not a problem with the Dockerfile.

### 6. Prove the machinery actually runs

Readiness tells you the parts are present. This tells you they work:

```powershell
# The worker should be logging a heartbeat every minute and a sequence tick
docker compose logs -f worker
```

Then, in the app: create a contact, build a sequence, enrol the contact. With
`EMAIL_TRANSPORT="log"` the engine runs end to end and writes what it *would* have sent to
the worker log, including merge tags rendered and the unsubscribe footer appended. That
exercises scheduling, sending windows, mailbox caps and the outbox — everything except the
final handoff to a mail provider.

### Stopping and resetting

```powershell
docker compose down            # stop, keep the data
docker compose down -v         # stop and delete the database volumes
```

### If something goes wrong

| Symptom | Cause |
|---|---|
| `migrate` exits 1 with an RLS list | A tenant table has no policy. `SELECT apply_tenant_rls();` then re-run. |
| Compose refuses to start, mentions `APP_DB_PASSWORD` | `.env` is missing, **or present with `APP_DB_PASSWORD=""`** — compose treats empty and unset identically. Run the `init-env.mjs` command in step 2. |
| Login fails, `app` logs a connection error | `DIRECT_DATABASE_URL` is wrong. Compose sets it; if you overrode it in `.env` for host use, the container inherits `localhost` and cannot reach Postgres. |
| Port 3000 in use | `APP_PORT=3001 docker compose up -d` |
| Slow first build | Expected. Rebuilds are cached. |

### The alternative, if Docker gives you trouble

`docker-compose.dev.yml` runs only Postgres and Redis, and you run the app on the host:

```powershell
docker compose -f docker-compose.dev.yml up -d
npm ci
npx prisma migrate deploy
npm run db:provision
npm run dev          # terminal 1
npm run worker:dev   # terminal 2
```

This needs Node 22 on Windows. It is better for iterating on code and worse as a rehearsal
for deployment, because it is not the artifact you will ship.

---

## Stage 2 — Online

### What this app needs from a host

This is the part that rules most free tiers out, so it is worth being explicit:

1. **A always-on process.** The worker is a long-running daemon, not a request handler.
   Scale-to-zero platforms stop it, and a stopped worker means sequences silently do not
   send. Most free serverless tiers cannot host it.
2. **Real Redis.** BullMQ needs Redis 6.2+ including blocking commands. Serverless
   Redis-compatible services are a known problem here — BullMQ's tracker has had an open
   issue titled *"Warn users that BullMQ is not compatible with Upstash"* for years. I would
   not build on one.
3. **Postgres you can administer.** The two-role design needs `CREATE ROLE` and RLS control.
   Managed Postgres usually allows this, but check before committing.
4. **About 2 GB of RAM** for everything on one box.

The simplest arrangement that satisfies all four is one small VM running the same
`docker compose up -d` you just ran locally.

### Options, cheapest first

| Option | Cost | Reality |
|---|---|---|
| **Oracle Cloud Always Free** | **£0** | 2 OCPU / 12 GB ARM, 200 GB storage. Genuinely free with no card charge. Caveats below. |
| **Hetzner CX23** | **€5.49/mo** | 2 vCPU / 4 GB / 40 GB NVMe, 20 TB traffic. Boring and reliable. |
| Hetzner CAX11 (ARM) | €5.99/mo | 2 vCPU / 4 GB. Same, ARM. |
| Neon + Upstash + a host | ~£0 | Free Postgres (512 MB) and Redis, but see the BullMQ problem above. I would not. |

**On Oracle's free tier:** it is the only genuinely free option that can run this properly,
and it is a real 2-core/12 GB machine. Two things to know. In mid-2026 Oracle
[quietly halved the allocation](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/)
from 4 OCPU/24 GB to 2 OCPU/12 GB, updating the docs with no announcement and enforcing it
inconsistently — so the terms can move under you. And ARM capacity in popular regions is
often unavailable for days at a time when you try to create the instance.

For something running your actual pipeline, €5.49/month at Hetzner buys away both problems.
That is my recommendation unless £0 is a hard requirement — in which case Oracle works, and
the deployment steps are identical either way.

### Deploying to either

```bash
ssh you@your-server
git clone <your repo> salesengine && cd salesengine
cp .env.example .env && nano .env      # same three secrets, plus APP_URL
docker compose up -d --build
docker compose exec app npx tsx scripts/create-tenant.ts
docker compose exec app npx tsx scripts/check.ts
```

Set `APP_URL` to the address people will actually use. Open and click tracking, unsubscribe
links and invitation links are all built from it, so a wrong value here produces links that
resolve to nothing.

You will also want a reverse proxy terminating TLS in front of port 3000 — Caddy is two
lines of config and gets certificates automatically. Session cookies are marked `secure` in
production, so **the app will not keep you logged in over plain HTTP.**

### Then, to actually send mail

Everything above runs the engine with sending disabled. Turning it on is a separate
exercise: verify a domain in Amazon SES, add the SPF/DKIM/DMARC records it gives you, come
out of the SES sandbox, then set `EMAIL_TRANSPORT="ses"` and add the mailbox in the app. The
Mailboxes page checks the DNS for you and refuses to send from a domain that fails SPF or
DKIM, because unauthenticated mail goes to spam and damages the domain you send from.
