import type { UserRole } from '@prisma/client'

/**
 * Two orthogonal questions:
 *   1. Can this user perform this action?          -> `can()`
 *   2. Which records is this user allowed to see?  -> `visibilityScope()`
 *
 * Keeping them separate avoids the usual mess where "manager" is hardcoded in
 * forty query builders.
 */

/**
 * `admin:access` gates the /admin surface itself, separately from the resource
 * permissions the pages also need.
 *
 * The distinction is load-bearing and was found by walking the app as a rep. A rep
 * holds `user:read` so that assignee pickers can list teammates, and `mailbox:read`
 * so a sequence can show which identity will send. Gating the admin pages on those
 * same permissions let a rep open /admin/users — everyone's role, status and last
 * seen — and /admin/mailboxes, with its reputation and bounce figures. Reading a
 * colleague's name and administering the workspace are different privileges, so
 * they are now different permissions.
 */
export const PERMISSIONS = {
  owner: ['*'],
  admin: [
    'admin:access',
    'tenant:read', 'tenant:update',
    'user:read', 'user:invite', 'user:update', 'user:disable',
    'team:*', 'customfield:*', 'integration:*', 'mailbox:*',
    'sequence:*', 'template:*', 'contact:*', 'account:*', 'lead:*',
    'deal:*', 'task:*', 'list:*', 'form:*', 'report:*', 'audit:read',
    'apikey:*', 'suppression:*',
  ],
  manager: [
    'tenant:read', 'user:read', 'team:read',
    'sequence:*', 'template:*', 'contact:*', 'account:*', 'lead:*',
    'deal:*', 'task:*', 'list:*', 'form:read', 'report:read',
    'mailbox:read', 'suppression:*',
  ],
  rep: [
    'tenant:read', 'user:read', 'team:read',
    'sequence:read', 'sequence:enroll', 'template:read', 'template:create',
    'contact:*', 'account:*', 'lead:*', 'deal:*', 'task:*', 'list:*',
    'report:read', 'mailbox:read', 'suppression:create',
  ],
} as const satisfies Record<UserRole, readonly string[]>

export type Permission = string

export function can(role: UserRole, permission: Permission): boolean {
  const granted = PERMISSIONS[role] as readonly string[]
  if (granted.includes('*')) return true
  if (granted.includes(permission)) return true

  const [resource] = permission.split(':')
  return granted.includes(`${resource}:*`)
}

export function assertCan(role: UserRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw new ForbiddenError(`Role "${role}" lacks permission "${permission}"`)
  }
}

export class ForbiddenError extends Error {
  readonly status = 403
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401
  constructor(message = 'Not authenticated') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

// --- record visibility -----------------------------------------------------

export type Scope = { kind: 'all' } | { kind: 'team'; userIds: string[] } | { kind: 'own'; userId: string }

export function visibilityScope(
  role: UserRole,
  userId: string,
  teamMemberIds: string[] = []
): Scope {
  switch (role) {
    case 'owner':
    case 'admin':
      return { kind: 'all' }
    case 'manager':
      return { kind: 'team', userIds: [...new Set([userId, ...teamMemberIds])] }
    case 'rep':
      return { kind: 'own', userId }
  }
}

/**
 * Turns a scope into a Prisma `where` fragment on an owner column.
 * Records with no owner are visible to everyone — unassigned leads must be
 * claimable, otherwise inbound goes into a black hole.
 */
export function ownerFilter(scope: Scope, field = 'ownerId') {
  switch (scope.kind) {
    case 'all':
      return {}
    case 'team':
      return { OR: [{ [field]: { in: scope.userIds } }, { [field]: null }] }
    case 'own':
      return { OR: [{ [field]: scope.userId }, { [field]: null }] }
  }
}

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  rep: 'Sales rep',
}

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  owner: 'Full control including billing and tenant deletion.',
  admin: 'Full control of settings, integrations and all records.',
  manager: 'Sees and manages their team’s records and sequences.',
  rep: 'Sees and manages their own records.',
}
