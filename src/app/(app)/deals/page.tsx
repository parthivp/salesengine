import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { ownerFilter } from '@/lib/rbac'
import { PageHeader, Card, StatTile, EmptyState } from '@/components/ui'
import { formatCurrency, formatNumber } from '@/lib/utils'
import { ensureDefaultStages, assessDeal, computeForecast } from '@/lib/workflow/pipeline'
import { Kanban } from 'lucide-react'
import { Board, NewDealButton } from './client'

export const metadata = { title: 'Deals · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function DealsPage() {
  const auth = await requirePermission('deal:read')

  const { stages, deals, forecast } = await withTenant(auth.tenant.id, async () => {
    const stages = await ensureDefaultStages()
    const deals = await db().deal.findMany({
      where: ownerFilter(auth.scope),
      include: {
        stage: true,
        account: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true, email: true } },
        owner: { select: { name: true } },
      },
      orderBy: { value: 'desc' },
      take: 400,
    })
    return { stages, deals, forecast: computeForecast(deals) }
  })

  const now = new Date()
  const rotting = deals.filter((d) => assessDeal(d, d.stage, now).status === 'rotting').length

  const serialised = deals.map((d) => {
    const health = assessDeal(d, d.stage, now)
    return {
      id: d.id,
      name: d.name,
      value: Number(d.value),
      currency: d.currency,
      stageId: d.stageId,
      owner: d.owner?.name ?? null,
      accountName: d.account?.name ?? null,
      contactId: d.contact?.id ?? null,
      contactName: d.contact
        ? [d.contact.firstName, d.contact.lastName].filter(Boolean).join(' ') || d.contact.email
        : null,
      expectedCloseDate: d.expectedCloseDate?.toISOString() ?? null,
      health: { status: health.status, reason: health.reason ?? null, days: health.daysSinceActivity },
    }
  })

  return (
    <>
      <PageHeader
        title="Deals"
        description="Weighted by stage probability, because summing open deal values is the number nobody believes."
        action={<NewDealButton />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-6">
        <StatTile
          label="Open pipeline"
          value={formatCurrency(forecast.openValue)}
          hint={`${formatNumber(forecast.openCount)} deals`}
        />
        <StatTile
          label="Weighted"
          value={formatCurrency(forecast.weightedValue)}
          hint="by stage probability"
          tone="positive"
        />
        <StatTile label="Won" value={formatCurrency(forecast.wonValue)} tone="positive" />
        <StatTile
          label="Win rate"
          value={forecast.winRate == null ? '—' : `${forecast.winRate.toFixed(0)}%`}
          hint={forecast.winRate == null ? 'nothing closed yet' : 'of closed deals'}
        />
        <StatTile
          label="Needs attention"
          value={formatNumber(rotting)}
          hint="stalled or past close date"
          tone={rotting > 0 ? 'warning' : 'neutral'}
        />
      </div>

      {deals.length === 0 ? (
        <Card>
          <EmptyState
            icon={Kanban}
            title="No deals yet"
            description="Create one from a qualified contact, or let a “Meeting booked” task outcome prompt you."
            action={<NewDealButton />}
          />
        </Card>
      ) : (
        <Board
          stages={stages.map((s) => ({
            id: s.id,
            name: s.name,
            probability: s.probability,
            isWon: s.isWon,
            isLost: s.isLost,
          }))}
          deals={serialised}
        />
      )}
    </>
  )
}
