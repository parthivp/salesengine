import type { SessionUser } from '@/lib/auth'
import { ROLE_LABELS } from '@/lib/rbac'
import { initials } from '@/lib/utils'

export function Topbar({
  user,
  tenant,
}: {
  user: SessionUser
  tenant: { name: string; slug: string; plan: string }
}) {
  return (
    <header className="h-14 shrink-0 border-b border-ink-200 bg-white px-6 lg:px-8 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-ink-900 truncate">{tenant.name}</span>
        <span className="text-[11px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-ink-100 text-ink-500">
          {tenant.plan}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-right hidden sm:block">
          <p className="text-sm font-medium leading-tight">{user.name}</p>
          <p className="text-xs text-ink-500 leading-tight">{ROLE_LABELS[user.role]}</p>
        </div>
        <div
          className="h-8 w-8 rounded-full bg-brand-100 text-brand-700 grid place-items-center text-xs font-semibold"
          title={user.email}
        >
          {initials(user.name)}
        </div>
        <form action="/logout" method="post">
          <button
            type="submit"
            className="text-sm text-ink-500 hover:text-ink-900 transition px-2 py-1 rounded-md hover:bg-ink-100"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  )
}
