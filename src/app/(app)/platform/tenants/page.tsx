import { pagePlatformAdmin } from '@/lib/auth'
import { PageHeader, PhaseNotice, AccessDenied } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'

export const metadata = { title: 'Tenants · SalesEngine' }
export const dynamic = 'force-dynamic'

/**
 * Platform admin, not tenant owner. This surface crosses tenants, so no role
 * inside a tenant can be sufficient — including owner. That distinction is the
 * whole reason `isPlatformAdmin` is a separate flag rather than a fifth role.
 */
export default async function Page() {
  const guard = await pagePlatformAdmin()
  return (
    <>
      <PageHeader title="Tenants" />
      {guard.ok ? (
        <PhaseNotice phase={1} feature="Tenants" />
      ) : (
        <AccessDenied
          what="Platform administration"
          role={ROLE_LABELS[guard.role]}
          contact="whoever operates this deployment"
        />
      )}
    </>
  )
}
