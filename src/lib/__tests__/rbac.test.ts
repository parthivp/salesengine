import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { can, PERMISSIONS } from '../rbac'
import type { UserRole } from '@prisma/client'

const ROLES: UserRole[] = ['owner', 'admin', 'manager', 'rep']

describe('permission matrix', () => {
  it('gives the admin surface to owner and admin only', () => {
    expect(can('owner', 'admin:access')).toBe(true)
    expect(can('admin', 'admin:access')).toBe(true)
    expect(can('manager', 'admin:access')).toBe(false)
    expect(can('rep', 'admin:access')).toBe(false)
  })

  it('still lets every role read teammates and sending identities', () => {
    // The reason `admin:access` had to exist as a separate permission: these are
    // needed by assignee pickers and sequence setup, so they cannot be the thing
    // that gates workspace administration.
    for (const role of ROLES) {
      expect(can(role, 'user:read'), role).toBe(true)
      expect(can(role, 'mailbox:read'), role).toBe(true)
    }
  })

  it('keeps administration of those resources away from manager and rep', () => {
    for (const role of ['manager', 'rep'] as UserRole[]) {
      expect(can(role, 'user:update'), role).toBe(false)
      expect(can(role, 'user:invite'), role).toBe(false)
      expect(can(role, 'mailbox:create'), role).toBe(false)
      expect(can(role, 'mailbox:update'), role).toBe(false)
      expect(can(role, 'integration:read'), role).toBe(false)
      expect(can(role, 'integration:update'), role).toBe(false)
      expect(can(role, 'audit:read'), role).toBe(false)
      expect(can(role, 'tenant:update'), role).toBe(false)
    }
  })

  it('expands a resource wildcard but not across resources', () => {
    expect(can('admin', 'team:create')).toBe(true) // team:* is granted
    expect(can('rep', 'contact:delete')).toBe(true) // contact:* is granted
    expect(can('rep', 'tenant:delete')).toBe(false)
    expect(can('rep', 'nonsense:read')).toBe(false)
  })

  it('grants owner everything', () => {
    for (const p of ['admin:access', 'tenant:delete', 'anything:at:all']) {
      expect(can('owner', p), p).toBe(true)
    }
  })

  it('lists no permission for a role that is not a real role', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...ROLES].sort())
  })
})

/**
 * A structural test over the route files rather than over behaviour.
 *
 * The defect this exists for was not a wrong permission — it was a page that never
 * asked. Two of the six admin routes had no guard at all, and no unit test would
 * have noticed, because there was nothing to call. The risk is identical for the
 * next admin page somebody adds, so the check is on the file: every route under
 * /admin or /platform must consult a guard.
 */
describe('every privileged route is guarded', () => {
  const appDir = join(process.cwd(), 'src/app/(app)')

  function pagesUnder(group: string): string[] {
    const root = join(appDir, group)
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name, 'page.tsx'))
      .filter((p) => existsSync(p))
  }

  const adminPages = pagesUnder('admin')
  const platformPages = pagesUnder('platform')

  it('finds the routes at all, so a rename cannot silently empty this suite', () => {
    expect(adminPages.length).toBeGreaterThanOrEqual(5)
    expect(platformPages.length).toBeGreaterThanOrEqual(1)
  })

  it.each(adminPages.map((p) => [p.replace(process.cwd(), ''), p]))(
    '%s checks a permission',
    (_label, path) => {
      const src = readFileSync(path, 'utf8')
      expect(src).toMatch(/pagePermission\(|requirePermission\(|pagePlatformAdmin\(/)
    }
  )

  it.each(platformPages.map((p) => [p.replace(process.cwd(), ''), p]))(
    '%s requires a platform admin',
    (_label, path) => {
      const src = readFileSync(path, 'utf8')
      expect(src).toMatch(/pagePlatformAdmin\(|requirePlatformAdmin\(/)
    }
  )

  it('refuses rather than throwing, so the response is 403 and not 500', () => {
    // requirePermission throws, and a throw inside a server component renders as a
    // 500. Pages use the page-level guards; only actions and route handlers throw.
    for (const path of [...adminPages, ...platformPages]) {
      const src = readFileSync(path, 'utf8')
      expect(src, path).not.toMatch(/await requirePermission\(/)
      expect(src, path).not.toMatch(/await requirePlatformAdmin\(/)
      expect(src, path).toMatch(/AccessDenied/)
    }
  })

  it('gates the admin nav on the same permission the pages check', () => {
    // A nav that offers a page the page then refuses is a bug in one of the two;
    // when they were different permissions, the nav was the accurate one.
    const sidebar = readFileSync(join(process.cwd(), 'src/components/sidebar.tsx'), 'utf8')
    const adminItems = sidebar
      .split(/title: 'Admin'/)[1]
      ?.split(']')[0] ?? ''
    const hrefs = [...adminItems.matchAll(/href: '(\/admin\/[^']+)'/g)].map((m) => m[1])
    expect(hrefs.length).toBeGreaterThanOrEqual(5)

    for (const href of hrefs) {
      const line = adminItems.split('\n').find((l) => l.includes(`href: '${href}'`)) ?? ''
      const permission = /permission: '([^']+)'/.exec(line)?.[1]
      expect(permission, href).toBeTruthy()
      expect(can('rep', permission!), `rep should not be offered ${href}`).toBe(false)
      expect(can('manager', permission!), `manager should not be offered ${href}`).toBe(false)
      expect(can('admin', permission!), `admin should be offered ${href}`).toBe(true)
    }
  })
})
