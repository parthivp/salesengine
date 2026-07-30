import { NextResponse, type NextRequest } from 'next/server'
import { prismaAdmin, withTenant, db } from '@/lib/db'
import { salesforceAdapter } from '@/lib/crm/salesforce'
import { sealObject } from '@/lib/crypto'
import { safeEqual } from '@/lib/crypto'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { requireAuth } from '@/lib/auth'

/**
 * OAuth callback.
 *
 * Two checks that are not optional:
 *  - the caller must already be signed in, so a stray callback cannot attach an
 *    org to a workspace nobody is authenticated for;
 *  - the `state` must match what we stored for that tenant, compared in constant
 *    time. Without it, an attacker can complete the flow with their own org and
 *    have the victim's workspace sync against it.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  if (error) {
    return redirectWith(`Salesforce returned "${error}".`)
  }
  if (!code || !state) {
    return redirectWith('Missing code or state.')
  }

  let auth
  try {
    auth = await requireAuth()
  } catch {
    return NextResponse.redirect(new URL('/login', env.APP_URL), { status: 303 })
  }

  const [tenantId, token] = state.split(':')
  if (!tenantId || !token || tenantId !== auth.tenant.id) {
    return redirectWith('This connection request does not belong to your workspace.')
  }

  const connection = await prismaAdmin.crmConnection.findFirst({
    where: { tenantId, provider: 'salesforce' },
  })
  if (!connection) return redirectWith('No pending Salesforce connection found.')

  const stored = (connection.credentials ?? {}) as { oauthState?: string }
  if (!stored.oauthState || !safeEqual(stored.oauthState, token)) {
    logger.warn({ tenantId }, 'Salesforce callback state mismatch')
    return redirectWith('Connection request expired or invalid. Please start again.')
  }

  try {
    const tokens = await salesforceAdapter.exchange({
      code,
      redirectUri: `${env.APP_URL}/api/crm/salesforce/callback`,
    })

    await withTenant(tenantId, async () => {
      await db().crmConnection.update({
        where: { id: connection.id },
        data: {
          status: 'connected',
          instanceUrl: tokens.instanceUrl,
          externalId: tokens.externalId,
          syncEnabled: true,
          lastError: null,
          credentials: {
            conflictPolicy: 'last_write_wins',
            expiresAt: tokens.expiresAt?.toISOString(),
            // Tokens are encrypted at rest; the oauthState is consumed and dropped.
            sealed: sealObject({
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
            }),
          } as never,
        },
      })
    })
  } catch (err) {
    logger.error({ err }, 'Salesforce token exchange failed')
    return redirectWith(err instanceof Error ? err.message : 'Token exchange failed.')
  }

  return NextResponse.redirect(new URL('/admin/integrations?connected=salesforce', env.APP_URL), {
    status: 303,
  })
}

function redirectWith(message: string) {
  const url = new URL('/admin/integrations', env.APP_URL)
  url.searchParams.set('error', message)
  return NextResponse.redirect(url, { status: 303 })
}
