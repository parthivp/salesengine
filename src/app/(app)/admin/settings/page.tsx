import { pagePermission } from '@/lib/auth'
import { PageHeader, PhaseNotice, AccessDenied } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'

export const metadata = { title: 'Settings · SalesEngine' }
export const dynamic = 'force-dynamic'

/**
 * Guarded even though it renders nothing yet. A placeholder that skips the check
 * teaches the wrong shape — the guard becomes the thing nobody remembers to add
 * when the real content lands, and by then the route has been public for months.
 */
export default async function Page() {
  const guard = await pagePermission('admin:access')
  return (
    <>
      <PageHeader title="Settings" />
      {guard.ok ? (
        <PhaseNotice phase={1} feature="Settings" />
      ) : (
        <AccessDenied what="Workspace settings" role={ROLE_LABELS[guard.role]} />
      )}
    </>
  )
}
