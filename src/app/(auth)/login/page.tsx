import { redirect } from 'next/navigation'
import { getAuth } from '@/lib/auth'
import { LoginForm } from './login-form'

export const metadata = { title: 'Sign in · SalesEngine' }

export default async function LoginPage() {
  if (await getAuth()) redirect('/dashboard')

  return (
    <main className="min-h-screen grid lg:grid-cols-2">
      {/* Left: the form */}
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2.5 mb-10">
            <div className="h-9 w-9 rounded-lg bg-brand-600 grid place-items-center">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 11 19-9-9 19-2-8-8-2Z" />
              </svg>
            </div>
            <span className="text-lg font-semibold tracking-tight">SalesEngine</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-sm text-ink-500">
            Welcome back. Enter your details to continue.
          </p>

          <LoginForm />
        </div>
      </div>

      {/* Right: context panel */}
      <div className="hidden lg:flex flex-col justify-between bg-ink-950 text-ink-100 p-12">
        <div />
        <div className="max-w-md">
          <blockquote className="text-xl leading-relaxed font-medium text-white">
            Prospect, sequence and sync — without putting a single account at risk.
          </blockquote>
          <div className="mt-8 grid gap-3 text-sm text-ink-400">
            <Feature>Apollo-backed lead intelligence and enrichment</Feature>
            <Feature>Multi-step email sequences with deliverability guardrails</Feature>
            <Feature>Bi-directional CRM sync, Salesforce first</Feature>
            <Feature>Compliant LinkedIn workflow — no automation fingerprint</Feature>
          </div>
        </div>
        <p className="text-xs text-ink-600">
          Tenant-isolated at the database layer. Every action audited.
        </p>
      </div>
    </main>
  )
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 items-start">
      <svg viewBox="0 0 24 24" className="h-4 w-4 mt-0.5 shrink-0 text-brand-400" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <span>{children}</span>
    </div>
  )
}
