import { pagePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, EmptyState, AccessDenied } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'
import { formatNumber, formatRelative } from '@/lib/utils'
import { Plug, AlertTriangle } from 'lucide-react'
import { ConnectPanel, MappingTable, ConflictList, SyncControls } from './client'
import { salesforceConfigured } from '@/lib/crm/config'

export const metadata = { title: 'Integrations · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function IntegrationsPage() {
  const guard = await pagePermission('admin:access')
  if (!guard.ok) {
    return (
      <>
        <PageHeader title="Integrations" />
        <AccessDenied what="Integrations" role={ROLE_LABELS[guard.role]} />
      </>
    )
  }
  const auth = guard.auth

  const data = await withTenant(auth.tenant.id, async () => {
    const connections = await db().crmConnection.findMany({
      include: {
        fieldMappings: { orderBy: [{ object: 'asc' }, { localField: 'asc' }] },
        _count: { select: { syncRecords: true } },
      },
    })

    const conflicts = await db().crmSyncRecord.findMany({
      where: { conflictAt: { not: null } },
      orderBy: { conflictAt: 'desc' },
      take: 20,
    })

    const linked = await Promise.all(
      connections.map(async (c) => ({
        id: c.id,
        byObject: Object.fromEntries(
          (
            await db().crmSyncRecord.groupBy({
              by: ['object'],
              where: { connectionId: c.id },
              _count: { _all: true },
            })
          ).map((g) => [g.object, g._count._all])
        ),
        failing: await db().crmSyncRecord.count({
          where: { connectionId: c.id, lastError: { not: null } },
        }),
      }))
    )

    return { connections, conflicts, linked }
  })

  const configured = salesforceConfigured()

  return (
    <>
      <PageHeader
        title="Integrations"
        description="CRM sync. The connector layer is provider-agnostic; Salesforce is the first adapter."
      />

      {!configured && (
        <Card className="mb-6 p-4 border-amber-200 bg-amber-50/50">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-ink-900">
                Salesforce credentials are not configured on this deployment
              </p>
              <p className="mt-1 text-sm text-ink-600">
                Create a Connected App in Salesforce (Setup → App Manager → New Connected App) with
                the <code>api</code> and <code>refresh_token</code> scopes and callback{' '}
                <code>/api/crm/salesforce/callback</code>, then set{' '}
                <code>SALESFORCE_CLIENT_ID</code> and <code>SALESFORCE_CLIENT_SECRET</code>.
              </p>
              <p className="mt-1 text-sm text-ink-600">
                Everything below the connect step — mapping, conflict policy, the sync engine — is
                built and tested against an in-memory CRM, so it works the moment a real org is
                attached.
              </p>
            </div>
          </div>
        </Card>
      )}

      {data.connections.length === 0 ? (
        <>
          <ConnectPanel configured={configured} />
          <Card className="mt-6">
            <EmptyState
              icon={Plug}
              title="No CRM connected"
              description="Connect Salesforce to sync accounts, contacts and leads both ways."
            />
          </Card>
        </>
      ) : (
        <div className="space-y-6">
          {data.connections.map((conn) => {
            const stats = data.linked.find((l) => l.id === conn.id)
            const policy =
              ((conn.credentials as { conflictPolicy?: string })?.conflictPolicy ??
                'last_write_wins') as 'last_write_wins' | 'crm_wins' | 'app_wins' | 'manual'

            return (
              <Card key={conn.id}>
                <div className="px-5 py-4 border-b border-ink-200 flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-ink-900 capitalize">
                        {conn.provider}
                      </h2>
                      <Badge
                        tone={
                          conn.status === 'connected' ? 'success'
                          : conn.status === 'error' ? 'danger'
                          : conn.status === 'expired' ? 'warning'
                          : 'neutral'
                        }
                      >
                        {conn.status}
                      </Badge>
                      {conn.syncEnabled ? <Badge tone="brand">sync on</Badge> : <Badge>sync off</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      {conn.instanceUrl ?? 'no instance URL'} · last sync{' '}
                      {formatRelative(conn.lastSyncAt)}
                    </p>
                    {conn.lastError && (
                      <p className="mt-1 text-xs text-red-700 max-w-xl">{conn.lastError}</p>
                    )}
                  </div>

                  <SyncControls
                    connectionId={conn.id}
                    syncEnabled={conn.syncEnabled}
                    policy={policy}
                    hasMappings={conn.fieldMappings.length > 0}
                  />
                </div>

                <dl className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm border-b border-ink-100">
                  <div>
                    <dt className="text-xs text-ink-500">Linked records</dt>
                    <dd className="font-medium tabular-nums">
                      {formatNumber(conn._count.syncRecords)}
                    </dd>
                  </div>
                  {['account', 'contact', 'lead'].map((o) => (
                    <div key={o}>
                      <dt className="text-xs text-ink-500 capitalize">{o}s</dt>
                      <dd className="font-medium tabular-nums">
                        {formatNumber(stats?.byObject[o] ?? 0)}
                      </dd>
                    </div>
                  ))}
                </dl>

                {stats?.failing ? (
                  <p className="px-5 py-2 text-xs text-red-700 border-b border-ink-100">
                    {stats.failing} record{stats.failing === 1 ? '' : 's'} failed on the last pass and
                    will be retried.
                  </p>
                ) : null}

                <MappingTable
                  connectionId={conn.id}
                  mappings={conn.fieldMappings.map((m) => ({
                    id: m.id,
                    object: m.object,
                    localField: m.localField,
                    remoteField: m.remoteField,
                    direction: m.direction,
                    transform: m.transform,
                  }))}
                />
              </Card>
            )
          })}

          {data.conflicts.length > 0 && (
            <ConflictList
              conflicts={data.conflicts.map((c) => ({
                id: c.id,
                object: c.object,
                localId: c.localId,
                remoteId: c.remoteId,
                reason: c.lastError ?? 'Conflict',
                at: c.conflictAt?.toISOString() ?? null,
              }))}
            />
          )}
        </div>
      )}
    </>
  )
}
