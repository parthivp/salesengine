import { pagePermission } from '@/lib/auth'
import { PageHeader, PhaseNotice, AccessDenied } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'

export const metadata = { title: 'Audit log · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function Page() {
  // `audit:read` rather than `admin:access`: the audit log is the one admin
  // surface a role could plausibly be given on its own, so it keeps its own
  // permission. Owner and admin hold it today.
  const guard = await pagePermission('audit:read')
  return (
    <>
      <PageHeader title="Audit log" />
      {guard.ok ? (
        <PhaseNotice phase={1} feature="Audit log" />
      ) : (
        <AccessDenied what="The audit log" role={ROLE_LABELS[guard.role]} />
      )}
    </>
  )
}
