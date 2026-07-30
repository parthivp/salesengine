'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { UserRole } from '@prisma/client'
import { can } from '@/lib/rbac'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, Users, Building2, Send, ListChecks, Kanban,
  Inbox, BarChart3, Settings, Shield, Linkedin, Mail, Plug,
} from 'lucide-react'

type Item = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  permission?: string
  phase?: number
}

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: 'Work',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/tasks', label: 'My tasks', icon: ListChecks },
      { href: '/inbox', label: 'Inbox', icon: Inbox },
      { href: '/linkedin', label: 'LinkedIn queue', icon: Linkedin },
    ],
  },
  {
    title: 'Pipeline',
    items: [
      { href: '/contacts', label: 'Contacts', icon: Users, permission: 'contact:read' },
      { href: '/accounts', label: 'Accounts', icon: Building2, permission: 'account:read' },
      { href: '/deals', label: 'Deals', icon: Kanban, permission: 'deal:read' },
    ],
  },
  {
    title: 'Outreach',
    items: [
      { href: '/sequences', label: 'Sequences', icon: Send, permission: 'sequence:read' },
      { href: '/templates', label: 'Templates', icon: Mail, permission: 'template:read' },
      { href: '/reports', label: 'Reports', icon: BarChart3, permission: 'report:read' },
    ],
  },
  {
    title: 'Admin',
    items: [
      // These must be the same permissions the pages check. When they were the
      // resource permissions (`user:read`, `mailbox:read`) the nav showed a rep two
      // admin pages it could actually open — the nav was right about the pages, and
      // the pages were wrong.
      { href: '/admin/users', label: 'Users & teams', icon: Users, permission: 'admin:access' },
      { href: '/admin/mailboxes', label: 'Mailboxes', icon: Mail, permission: 'admin:access' },
      { href: '/admin/integrations', label: 'Integrations', icon: Plug, permission: 'admin:access' },
      { href: '/admin/settings', label: 'Settings', icon: Settings, permission: 'admin:access' },
      { href: '/admin/audit', label: 'Audit log', icon: Shield, permission: 'audit:read' },
    ],
  },
]

export function Sidebar({
  role,
  isPlatformAdmin,
}: {
  role: UserRole
  isPlatformAdmin: boolean
}) {
  const pathname = usePathname()

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-ink-200 bg-white">
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-ink-200">
        <div className="h-7 w-7 rounded-md bg-brand-600 grid place-items-center">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 11 19-9-9 19-2-8-8-2Z" />
          </svg>
        </div>
        <span className="font-semibold tracking-tight">SalesEngine</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {SECTIONS.map((section) => {
          const visible = section.items.filter(
            (i) => !i.permission || can(role, i.permission)
          )
          if (!visible.length) return null

          return (
            <div key={section.title}>
              <p className="px-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(item.href + '/')
                  const Icon = item.icon
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition',
                          active
                            ? 'bg-brand-50 text-brand-700 font-medium'
                            : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
                        )}
                      >
                        <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-brand-600' : 'text-ink-400')} />
                        <span className="truncate">{item.label}</span>
                        {item.phase && (
                          <span
                            className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-ink-100 text-ink-500"
                            title={`Lands in Phase ${item.phase}`}
                          >
                            P{item.phase}
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}

        {isPlatformAdmin && (
          <div>
            <p className="px-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
              Platform
            </p>
            <Link
              href="/platform/tenants"
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition',
                pathname.startsWith('/platform')
                  ? 'bg-amber-50 text-amber-800 font-medium'
                  : 'text-ink-600 hover:bg-ink-100'
              )}
            >
              <Shield className="h-4 w-4 shrink-0 text-amber-600" />
              Tenants
            </Link>
          </div>
        )}
      </nav>
    </aside>
  )
}
