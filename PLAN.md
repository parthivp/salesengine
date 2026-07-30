# SalesEngine — Product & Engineering Plan

A multi-tenant sales engagement platform: Apollo-style lead intelligence + Dripify-style
sequenced outreach + CRM sync, built for an internal sales team first and a SaaS product second.

**Status:** Phases 0–3 shipped → Phase 4 (CRM connector + Salesforce) next
**Owner:** Parthiv
**Last updated:** 2026-07-30

---

## 1. Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Stack | Next.js 16 (App Router) full-stack + separate worker process | One codebase, one deploy, no duplicate DTOs. Saves ~2–3 weeks vs. a separate NestJS API. |
| Language | TypeScript end to end | Shared types between UI, API routes, workers and DB. |
| Database | PostgreSQL 16 + Prisma | Row-level tenant isolation, JSONB for custom fields, mature. |
| Jobs | Redis 7 + BullMQ | Sequence scheduling, CRM sync, enrichment, email send. Long-running — needs a real worker, not serverless. |
| Email sending | Amazon SES | $0.10 / 1,000 emails. 10–50× cheaper than SendGrid/Postmark at outreach volume. |
| Lead data | Apollo.io API | Already licensed. Building our own enrichment would cost months and lose. |
| CRM | Pluggable connector interface, Salesforce adapter first | 3–4 days for the abstraction vs. a 2-week rewrite the first time a customer needs HubSpot. |
| Hosting | Docker Compose on a single VPS (Hetzner CPX21 class) | ~$12–15/mo all-in vs. $50–70 serverless or $120+ AWS. Same containers lift to AWS later. |
| Tenancy | Multi-tenant from day one, billing deferred | Team is tenant #1. Foundations now, Stripe when we sell. |
| LinkedIn | Human-in-the-loop queue, Phase 6 | Compliant with LinkedIn's User Agreement. No account-ban exposure. Deferred because it is the most expensive piece per unit of value. |

### 1.1 On LinkedIn — the explicit position

LinkedIn's User Agreement prohibits unauthorised scraping and automated activity. Tools that
drive a headless browser or cloud IP against LinkedIn on your behalf work until detection
catches up, and the cost of being caught is your sales team's real identity going offline.

This product therefore does **not** implement detection evasion — no fingerprint rotation,
no residential proxies, no humanised timing jitter designed to defeat classification.

What it does instead (Phase 6):

- Imports Sales Navigator CSV exports (an export LinkedIn itself provides)
- Builds and prioritises the target list
- Drafts the personalised message with AI
- Queues it as a card in a **LinkedIn Queue** view
- A Chrome extension pastes the message into the rep's own real LinkedIn tab on click

The rep spends ~3 seconds per action instead of ~2 minutes. 40 connection requests ≈ 4 minutes
instead of ~90. LinkedIn sees a human using their site — because it is one.

Everything else in the product — lead DB, email sequencing, CRM sync, capture, admin — is
fully automated with no such caveat.

---

## 2. Feature set

### 2.1 Lead intelligence & database (Apollo-side)

- **Unified lead DB** — Accounts (companies), Contacts (people), Leads (unqualified inbound)
- **Apollo search** — people & company search from inside the app, saved searches
- **Enrichment** — bulk match/enrich on import, scheduled re-enrichment for stale records
- **CSV import** — column mapping UI, dry-run preview, error report download
- **Web form capture** — public endpoint + embeddable JS snippet, per-tenant capture keys
- **Inbound routing** — assignment rules (round-robin, territory, owner-of-account)
- **Deduplication** — deterministic (email, domain) + fuzzy (name+company) merge with review queue
- **Lists & segments** — static lists and saved dynamic segments over any field
- **Custom fields** — per-tenant JSONB-backed custom fields on every object
- **Lead scoring** — rule-based scoring (fit + engagement), score history, threshold triggers
- **Do-not-contact** — global suppression list, per-tenant, domain and address level
- **Activity timeline** — every email, task, sequence step, CRM sync and field change per record

### 2.2 Outreach & sequences (Dripify-side)

- **Sequence builder** — visual multi-step: email → wait → condition → email → task → LinkedIn step
- **Branching** — if opened / if clicked / if replied / if no-reply-after-N-days
- **A/B testing** — variant steps with automatic winner selection on reply rate
- **Personalisation** — Handlebars-style merge tags with fallbacks; AI-drafted first lines
- **Sending windows** — per-sequence business hours, per-prospect timezone, holiday calendar
- **Throttling** — per-mailbox daily caps, ramp-up schedule for new mailboxes
- **Auto-stop on reply** — reply detection stops the whole sequence for that contact and their account
- **Mailbox connection** — Gmail & Outlook OAuth for send-as, plus SES for high volume
- **Deliverability guardrails** — SPF/DKIM/DMARC checks, spam-word linting, bounce/complaint
  handling, automatic pause on complaint-rate breach
- **Templates** — shared template library, snippets, per-tenant approval workflow
- **Unsubscribe** — one-click list-unsubscribe header + hosted page, honoured globally

### 2.3 Follow-ups, tasks & pipeline

- **Task queue** — the rep's daily to-do: calls, manual emails, LinkedIn cards, follow-ups
- **Follow-up reminders** — auto-created on reply, on meeting booked, on step completion
- **Snooze & reschedule** — with reason capture
- **Pipeline board** — stages, drag-drop, deal value, expected close, rotting-deal alerts
- **Meeting booking** — calendar link insertion, booked-meeting detection, no-show follow-up
- **Notes & call logging** — with outcome/disposition picklists

### 2.4 CRM integration

- **Connector interface** — one internal contract, many adapters
- **Salesforce adapter (Phase 4)** — OAuth, REST + Bulk API 2.0, Platform Events/CDC for
  near-real-time inbound
- **Field mapping UI** — map our fields ↔ CRM fields per tenant, per object, with transforms
- **Bi-directional sync** — configurable direction per object, conflict resolution
  (last-write-wins / CRM-wins / app-wins / manual review)
- **Activity write-back** — emails, calls, tasks logged to the CRM record
- **Sync health dashboard** — queue depth, last sync, failures with retry
- **HubSpot adapter** — Phase 7, ~1/4 the effort once the interface exists

### 2.5 Admin portal (tenant-level)

- **Users & roles** — Owner / Admin / Manager / Rep, invite flow, deactivation
- **Teams** — rep grouping, manager visibility scoping
- **Permissions** — record visibility (own / team / all), field-level restrictions
- **Mailbox management** — connected mailboxes, health, daily caps, warm-up state
- **Integration settings** — CRM connection, Apollo key, SES domain verification
- **Custom fields & picklists**
- **Sequence approval** — optional gate before a sequence can go live
- **Audit log** — who changed what, when, immutable
- **Usage dashboard** — emails sent, credits used, seats

### 2.6 Super-admin portal (platform-level)

- **Tenant management** — create, suspend, impersonate (audited), delete with export
- **Plan & limits** — seats, monthly email cap, enrichment credit cap
- **Platform health** — job queue depth, error rates, SES reputation, per-tenant volume
- **Feature flags** — per-tenant rollout
- **Billing** — Stripe, deferred to Phase 8

### 2.7 Cross-cutting

- **AI assist** — message drafting, reply classification (interested / not now / not interested /
  OOO / wrong person), summarisation of an account's history
- **Reporting** — funnel by sequence, rep leaderboard, reply/meeting rates, cohort retention
- **Notifications** — in-app, email digest, optional Slack
- **Webhooks & public API** — outbound webhooks on key events; REST API with per-tenant keys
- **Import/export** — full tenant data export (GDPR-friendly)

---

## 3. Architecture

```
                            ┌───────────────────────┐
   Browser ────────────────►│  Next.js 16 (App Rtr) │
   Chrome extension ───────►│  UI + API routes      │
                            │  Auth.js + RBAC       │
                            └───────┬───────────────┘
                                    │ Prisma
                            ┌───────▼───────────────┐
                            │  PostgreSQL 16        │◄─────┐
                            │  row-level tenancy    │      │
                            └───────────────────────┘      │
                                    ▲                      │
                            ┌───────┴───────────────┐      │
   BullMQ ◄─── Redis 7 ────►│  Worker (Node)        │──────┘
                            │  • sequence scheduler │
                            │  • email send/receive │
                            │  • CRM sync           │
                            │  • enrichment         │
                            │  • scoring            │
                            └───┬──────────┬────────┘
                                │          │
                    ┌───────────▼──┐  ┌────▼──────────┐
                    │ Amazon SES   │  │ Apollo API    │
                    │ Gmail/Graph  │  │ Salesforce    │
                    └──────────────┘  └───────────────┘
```

### 3.1 Tenant isolation

Every tenant-scoped table carries `tenantId`. Three layers of defence:

1. **Postgres Row-Level Security** — policies keyed on a session variable
   `app.current_tenant`, set on every connection checkout. This is the backstop: even a
   forgotten `where` clause cannot leak across tenants.
2. **Explicit `tid()`** — every write states its tenant, and `tid()` throws outside a tenant
   context. Shipped as a Prisma client extension first; removed because the invisible
   injection made every create site type-check as though `tenantId` were optional, hiding the
   class of bug it was meant to prevent.
3. **Request context** — `AsyncLocalStorage` carries the resolved tenant from the session
   through to the DB layer, so no function has to thread it manually.

Rejected: schema-per-tenant (migration pain at scale) and database-per-tenant (cost).

### 3.2 The sequence engine

The core loop, and the piece most likely to be got wrong:

- A `SequenceEnrollment` is a contact's position in a sequence.
- A **repeating scheduler job** (every minute) finds enrollments whose `nextRunAt <= now`
  and enqueues one `processEnrollmentStep` job each — never a long-lived timer per contact.
- `processEnrollmentStep` is **idempotent** and guarded by a per-enrollment lock. It
  evaluates the current step's conditions, performs the action, and sets `nextRunAt` for
  the following step honouring sending windows, prospect timezone and mailbox caps.
- Reply/bounce/unsubscribe events set enrollment status to `stopped` transactionally, so a
  race between "send next step" and "they replied" cannot double-send.
- Every send writes an outbox row **before** calling SES, so a crash mid-send is recoverable
  and never duplicates.

### 3.3 CRM connector contract

```ts
interface CrmAdapter {
  readonly key: 'salesforce' | 'hubspot' | 'pipedrive' | 'zoho'
  connect(tenantId: string, oauth: OAuthGrant): Promise<CrmConnection>
  describeObjects(conn: CrmConnection): Promise<CrmObjectSchema[]>
  pull(conn: CrmConnection, object: CrmObject, since: Date, cursor?: string)
    : Promise<CrmPage<CrmRecord>>
  push(conn: CrmConnection, object: CrmObject, records: CrmRecord[])
    : Promise<CrmWriteResult[]>
  logActivity(conn: CrmConnection, activity: CrmActivity): Promise<void>
  subscribeToChanges?(conn: CrmConnection, cb: ChangeHandler): Promise<Unsubscribe>
}
```

Sync engine, field mapping, conflict resolution and retry live **above** this interface, so an
adapter is only transport + schema translation. That is why HubSpot later costs a fraction.

### 3.4 Deliverability — the thing that actually decides success

Cold outreach dies from bad deliverability, not missing features. Built in from Phase 3:

- Separate sending domain from the primary corporate domain
- SPF, DKIM, DMARC verified before a mailbox can send; blocked otherwise
- New-mailbox ramp: 20/day rising ~20%/week to a configured ceiling
- Per-mailbox and per-tenant daily caps, enforced in the scheduler not at send time
- Bounce & complaint webhooks from SES → automatic suppression, automatic pause on
  complaint rate > 0.1%
- Spam-word and link-ratio linting on templates before activation
- Plain-text-first sending, no tracking-pixel-by-default (opt-in per sequence)

---

## 4. Data model (core)

| Table | Purpose | Key fields |
|---|---|---|
| `Tenant` | Root of isolation | slug, plan, limits, status |
| `User` | Person, belongs to a tenant | email, role, teamId, status |
| `Team` | Rep grouping | name, managerId |
| `Account` | Company | domain, name, industry, size, apolloId, customFields |
| `Contact` | Person at an account | email, name, title, accountId, apolloId, score, ownerId |
| `Lead` | Unqualified inbound | source, status, convertedContactId |
| `Sequence` | Outreach program | name, status, settings |
| `SequenceStep` | One step | order, type, delay, template, conditions, variantOf |
| `SequenceEnrollment` | Contact in a sequence | contactId, sequenceId, currentStepId, nextRunAt, status |
| `Mailbox` | Sending identity | provider, email, dailyCap, warmupState, health |
| `EmailMessage` | Sent/received | direction, threadId, messageId, status, opens, clicks |
| `Task` | Rep to-do | type, dueAt, status, contactId, assigneeId |
| `Deal` | Pipeline item | stage, value, closeDate, accountId |
| `CrmConnection` | Per-tenant CRM link | provider, tokens, status |
| `CrmFieldMapping` | Mapping rules | object, localField, remoteField, direction, transform |
| `CrmSyncRecord` | Link + watermark | localId, remoteId, lastPulledAt, lastPushedAt, hash |
| `SuppressionEntry` | DNC | type (email/domain), value, reason |
| `AuditLog` | Immutable trail | actorId, action, entity, before, after |
| `CustomFieldDef` | Per-tenant schema | object, key, type, options |

---

## 5. Phased delivery

Each phase ends with a working, demoable system pushed to GitHub as its own tagged release.

| Phase | Scope | Outcome |
|---|---|---|
| **0. Scaffold** | Monorepo, Docker Compose, Prisma, CI, base UI shell | `docker compose up` boots the whole stack |
| **1. Foundation** | Tenancy + RLS, auth, RBAC, teams, admin shell, audit log | Log in, invite a rep, isolation provably enforced |
| **2. Lead DB** | Accounts/Contacts/Leads, CSV import, form capture, Apollo search + enrich, dedupe, lists, scoring | Import 1,000 leads, enrich them, segment them |
| **3. Email engine** | SES + mailbox OAuth, templates, sequence builder, scheduler, tracking, reply detection, deliverability guardrails | Run a real 4-step sequence end to end |
| **4. CRM** | Connector layer, Salesforce adapter, field mapping UI, bi-directional sync, activity write-back, sync health | Contacts flow both ways with your Salesforce org |
| **5. Workflow** | Task queue, follow-ups, pipeline board, dashboards, reporting | A rep can run their whole day inside the app |
| **6. LinkedIn** | Sales Nav CSV import, target lists, AI drafting, human-in-the-loop queue, Chrome extension | 40 LinkedIn touches in ~4 minutes, compliantly |
| **7. Scale-out** | HubSpot adapter, public API, webhooks, AI reply classification | Sellable to non-Salesforce teams |
| **8. Commercial** | Stripe billing, self-serve signup, plan limits, usage metering | Take money |

Phases 0–3 are the minimum for the platform to be useful. Phase 4 makes it fit your existing
process. Phases 5–6 are where reps stop using anything else.

---

## 6. Running cost

| Item | Monthly |
|---|---|
| VPS (4 vCPU / 8 GB, runs everything) | ~$12 |
| Backups / snapshots | ~$2 |
| Domain + Cloudflare | ~$1 |
| Amazon SES (50k emails) | ~$5 |
| **Infrastructure total** | **~$20** |
| Apollo credits | existing licence |

Compared with Vercel + Neon + Upstash at ~$50–70/mo, or AWS ECS/RDS at ~$120–160/mo floor.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Deliverability collapse from cold email | Guardrails in Phase 3, not bolted on later. Separate sending domain. Hard caps. |
| Salesforce API limits | Bulk API 2.0 for backfill, CDC for deltas, per-tenant rate budget with backoff |
| Tenant data leak | Postgres RLS as backstop beneath the ORM layer; isolation tests in CI |
| Apollo credit burn | Per-tenant enrichment caps, cache enrichment results, re-enrich on a schedule not on view |
| Sequence double-send | Outbox pattern + idempotency keys + per-enrollment locking |
| LinkedIn account risk | Human-in-the-loop only; no automation fingerprint |
| Single VPS is a SPOF | Nightly off-box backups from day one; documented restore. Move to managed Postgres when revenue justifies it. |
