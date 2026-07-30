import { prismaAdmin } from '@/lib/db'
import { hashToken } from '@/lib/crypto'
import { AcceptInvite } from './client'

export const metadata = { title: 'Join · SalesEngine' }
export const dynamic = 'force-dynamic'

/**
 * Invitation acceptance.
 *
 * Looks up by token *hash* — the raw token never exists server-side beyond this
 * comparison, which is the same handling a session token gets.
 *
 * Runs against the admin client deliberately: the visitor has no session and
 * therefore no tenant context, so there is nothing for row-level security to scope
 * to yet. The token is the authorisation.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const invite = await prismaAdmin.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { tenant: { select: { name: true } } },
  })

  const invalid = !invite || invite.acceptedAt !== null || invite.expiresAt < new Date()

  if (invalid) {
    // Deliberately one message for all three cases. Distinguishing "expired" from
    // "already used" from "never existed" tells someone probing tokens which
    // guesses were close.
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink-900">This invitation cannot be used</h1>
        <p className="mt-2 text-sm text-ink-600">
          It may have expired, or already been accepted. Ask whoever invited you to send a new one.
        </p>
        <a href="/login" className="mt-4 inline-block text-sm text-brand-700 hover:underline">
          Go to sign in
        </a>
      </Shell>
    )
  }

  const user = await prismaAdmin.user.findFirst({
    where: { tenantId: invite.tenantId, email: invite.email },
    select: { name: true },
  })

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-ink-900">
        Join {invite.tenant.name}
      </h1>
      <p className="mt-1 text-sm text-ink-600">
        Setting a password for <span className="font-medium text-ink-800">{invite.email}</span>.
      </p>
      <AcceptInvite token={token} name={user?.name ?? ''} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center bg-ink-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-ink-200 bg-white p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md bg-brand-600 grid place-items-center">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" stroke="currentColor"
                 strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 11 19-9-9 19-2-8-8-2Z" />
            </svg>
          </div>
          <span className="font-semibold tracking-tight text-ink-900">SalesEngine</span>
        </div>
        {children}
      </div>
    </div>
  )
}
