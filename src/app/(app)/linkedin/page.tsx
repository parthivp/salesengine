import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, StatTile, EmptyState, Badge } from '@/components/ui'
import { formatNumber } from '@/lib/utils'
import { buildQueue } from '@/lib/linkedin/queue'
import { DAILY_CEILINGS, ACTION_LABEL } from '@/lib/linkedin/policy'
import { Linkedin, ShieldCheck } from 'lucide-react'
import { QueueCards, BuildListButton, SalesNavImport, EnrichButton, ConnectionsImport } from './client'

export const metadata = { title: 'LinkedIn queue · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function LinkedInPage() {
  const auth = await requireAuth()
  // Read the clock once, at the top. The page is force-dynamic so this is a fresh
  // value per request, and hoisting it keeps the render itself pure.
  const now = new Date().getTime()

  const { cards, pacing, counts } = await withTenant(auth.tenant.id, async () => {
    const q = await buildQueue({
      userId: auth.user.id,
      senderFirstName: auth.user.name.split(' ')[0],
    })

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    const [sentToday, withProfile, invited, connected, pending] = await Promise.all([
      db().task.count({
        where: {
          type: 'linkedin', assigneeId: auth.user.id, status: 'completed',
          outcome: 'sent', completedAt: { gte: startOfDay },
        },
      }),
      db().contact.count({
        where: { linkedinUrl: { not: null }, status: { notIn: ['do_not_contact', 'unqualified'] } },
      }),
      db().contact.count({ where: { linkedinInvitedAt: { not: null } } }),
      db().contact.count({ where: { linkedinConnectedAt: { not: null } } }),
      // Invited, no acceptance seen. Not the same as "declined" — LinkedIn never
      // tells anyone that — so the label says outstanding, not rejected.
      db().contact.findMany({
        where: { linkedinInvitedAt: { not: null }, linkedinConnectedAt: null },
        select: { linkedinInvitedAt: true },
        orderBy: { linkedinInvitedAt: 'asc' },
      }),
    ])

    const oldest = pending[0]?.linkedinInvitedAt ?? null
    return {
      ...q,
      counts: {
        sentToday, withProfile, invited, connected,
        pending: pending.length,
        oldestPendingDays: oldest
          ? Math.floor((now - oldest.getTime()) / 86_400_000)
          : null,
      },
    }
  })

  // Cards drafted from nothing but a location. They all have the same cause and
  // the same fix, so the offer to fix it belongs once on the page rather than on
  // each card.
  const thin = cards.filter((c) => c.draft.generic).length

  const serialised = cards.map((c) => ({
    taskId: c.taskId,
    contactId: c.contactId,
    action: c.action,
    name: c.name,
    title: c.title,
    company: c.company,
    profileUrl: c.profileUrl,
    score: c.score,
    text: c.draft.text,
    limit: c.draft.limit,
    generic: c.draft.generic,
    usedHooks: c.draft.usedHooks,
    checks: c.checks,
    rationale: c.rationale,
  }))

  return (
    <>
      <PageHeader
        title="LinkedIn queue"
        description="The app builds the list and drafts the message. You send it, from your own browser."
        action={<BuildListButton />}
      />

      {/* The position, stated where the rep actually is — not buried in a README. */}
      <Card className="mb-6 p-4 border-emerald-200 bg-emerald-50/40">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-ink-900">Nothing here touches LinkedIn on your behalf</p>
            <p className="mt-1 text-ink-600 leading-relaxed">
              No headless browser, no proxies, no auto-send, no scraping. Cards are built from
              contacts already in your CRM — imported by you, synced from your CRM, or enriched by a
              data provider. You click Send in your own logged-in session, which is why there is no
              automation fingerprint to detect — and why your account is not at risk.
            </p>
            <p className="mt-1.5 text-ink-500 text-xs">
              Roughly 3 seconds per card. Forty connection requests is about four minutes, against
              ninety doing it cold.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile label="Cards waiting" value={formatNumber(cards.length)} />
        <StatTile
          label="Sent today"
          value={`${formatNumber(counts.sentToday)} / ${DAILY_CEILINGS.connect}`}
          hint="suggested ceiling"
          tone={pacing.connect.allowed ? 'positive' : 'warning'}
        />
        <StatTile
          label="Contacts with a profile"
          value={formatNumber(counts.withProfile)}
          hint="eligible for the queue"
        />
        {/* The question the queue could not answer before: of everyone you invited,
            how many said yes — and is anything sitting unanswered for weeks. */}
        <StatTile
          label="Invitations accepted"
          value={
            counts.invited > 0
              ? `${formatNumber(counts.connected)} / ${formatNumber(counts.invited)}`
              : '—'
          }
          hint={
            counts.invited === 0
              ? 'none sent yet'
              : counts.pending === 0
                ? 'all answered'
                : counts.oldestPendingDays != null && counts.oldestPendingDays >= 14
                  ? `${formatNumber(counts.pending)} outstanding, oldest ${counts.oldestPendingDays}d`
                  : `${formatNumber(counts.pending)} outstanding`
          }
          tone={
            counts.oldestPendingDays != null && counts.oldestPendingDays >= 21
              ? 'warning'
              : undefined
          }
        />
      </div>

      {!pacing.connect.allowed && (
        <Card className="mb-6 p-4 border-amber-200 bg-amber-50/50">
          <p className="text-sm text-amber-900">{pacing.connect.message}</p>
        </Card>
      )}
      {pacing.connect.allowed && pacing.connect.message && (
        <p className="mb-4 text-sm text-amber-800">{pacing.connect.message}</p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {cards.length === 0 ? (
            <Card>
              <EmptyState
                icon={Linkedin}
                title="Nothing in the queue"
                description={
                  counts.withProfile > 0
                    ? `You have ${formatNumber(counts.withProfile)} contact${
                        counts.withProfile === 1 ? '' : 's'
                      } with a LinkedIn profile. Build a target list to start.`
                    : 'Import a CSV of leads, or add profile URLs to your contacts, and the queue fills itself.'
                }
                action={<BuildListButton />}
              />
            </Card>
          ) : (
            <QueueCards cards={serialised} canSend={pacing.connect.allowed} />
          )}
        </div>

        <div className="space-y-6">
          {thin > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-semibold text-ink-900 mb-2">These drafts are thin</h2>
              <EnrichButton thin={thin} />
            </Card>
          )}

          <SalesNavImport />

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900 mb-2">Who accepted</h2>
            <ConnectionsImport />
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900 mb-2">Why the caps exist</h2>
            <p className="text-sm text-ink-600 leading-relaxed">
              {DAILY_CEILINGS.connect} {ACTION_LABEL.connect} and {DAILY_CEILINGS.message}{' '}
              {ACTION_LABEL.message} a day. These are not attempts to stay under a detection
              threshold — they are the point past which acceptance rates fall and people start
              reporting you. The queue warns rather than silently truncating, because a hidden cap
              looks like a broken product.
            </p>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900 mb-2">On the drafts</h2>
            <p className="text-sm text-ink-600 leading-relaxed">
              Drafts are composed from facts actually on the record — seniority, function, company
              size, whether you have already emailed them. Nothing is inferred or invented. A card
              whose record is thin is labelled <Badge>generic</Badge> rather than dressed up: on
              LinkedIn, one made-up detail costs the relationship outright.
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}
