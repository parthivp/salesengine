import { pagePermission } from '@/lib/auth'
import { InvitePanel, UserControls } from './client'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, AccessDenied } from '@/components/ui'
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from '@/lib/rbac'
import { formatRelative, initials } from '@/lib/utils'
import type { UserStatus } from '@prisma/client'

export const metadata = { title: 'Users & teams · SalesEngine' }
export const dynamic = 'force-dynamic'

const STATUS_TONE: Record<UserStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  invited: 'warning',
  disabled: 'neutral',
}

export default async function UsersPage() {
  // `admin:access`, not `user:read`: a rep holds `user:read` so assignee pickers
  // can list teammates, which is not the same as seeing everyone's role, status
  // and last sign-in.
  const guard = await pagePermission('admin:access')
  if (!guard.ok) {
    return (
      <>
        <PageHeader title="Users & teams" />
        <AccessDenied what="Workspace administration" role={ROLE_LABELS[guard.role]} />
      </>
    )
  }
  const auth = guard.auth

  const { users, teams, tenant } = await withTenant(auth.tenant.id, async () => {
    const [users, teams] = await Promise.all([
      db().user.findMany({
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
        include: { team: { select: { name: true } } },
      }),
      db().team.findMany({
        orderBy: { name: 'asc' },
        include: { manager: { select: { name: true } }, _count: { select: { members: true } } },
      }),
    ])
    const tenant = await db().tenant.findUniqueOrThrow({
      where: { id: auth.tenant.id },
      select: { seatLimit: true },
    })
    return { users, teams, tenant }
  })

  // Counted the same way `checkSeatQuota` counts, so the panel cannot promise a
  // seat the enforcer will then refuse.
  const seatsUsed = users.filter((u) => u.status === 'active' || u.status === 'invited').length

  return (
    <>
      <PageHeader
        title="Users & teams"
        description="Who can access this workspace, and what they can see."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
      <Card>
        <div className="px-5 py-4 border-b border-ink-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">
            Users <span className="text-ink-400 font-normal">({users.length})</span>
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Role</th>
                <th className="px-5 py-2.5 font-medium">Team</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 font-medium">Last seen</th>
                <th className="px-5 py-2.5 font-medium text-right">Manage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-ink-50/60">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="h-7 w-7 rounded-full bg-ink-100 text-ink-600 grid place-items-center text-[11px] font-semibold shrink-0">
                        {initials(u.name)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-ink-900 truncate">{u.name}</p>
                        <p className="text-xs text-ink-500 truncate">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <span title={ROLE_DESCRIPTIONS[u.role]} className="text-ink-700">
                      {ROLE_LABELS[u.role]}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-ink-600">{u.team?.name ?? '—'}</td>
                  <td className="px-5 py-3">
                    <Badge tone={STATUS_TONE[u.status]}>{u.status}</Badge>
                  </td>
                  <td className="px-5 py-3 text-ink-500">{formatRelative(u.lastLoginAt)}</td>
                  <td className="px-5 py-3">
                    <UserControls
                      userId={u.id}
                      name={u.name}
                      role={u.role}
                      status={u.status}
                      isSelf={u.id === auth.user.id}
                      canManageOwners={auth.user.role === 'owner'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4 border-b border-ink-200">
          <h2 className="text-sm font-semibold text-ink-900">
            Teams <span className="text-ink-400 font-normal">({teams.length})</span>
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Managers see every record owned by anyone on their team.
          </p>
        </div>
        {teams.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">No teams yet.</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {teams.map((t) => (
              <li key={t.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-ink-900">{t.name}</p>
                  <p className="text-xs text-ink-500">
                    Manager: {t.manager?.name ?? 'unassigned'}
                  </p>
                </div>
                <Badge>{t._count.members} members</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
        </div>

        <div className="space-y-6">
          <InvitePanel
            seatsUsed={seatsUsed}
            seatLimit={tenant.seatLimit}
            canInviteOwner={auth.user.role === 'owner'}
          />
        </div>
      </div>
    </>
  )
}
