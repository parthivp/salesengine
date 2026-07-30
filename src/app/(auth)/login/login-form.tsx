'use client'

import { useActionState } from 'react'
import { loginAction, type LoginState } from './actions'

const initial: LoginState = { error: null }

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initial)

  return (
    <form action={formAction} className="mt-8 space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-ink-700 mb-1.5">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          placeholder="you@company.com"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-ink-700 mb-1.5">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••••"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
        />
      </div>

      {state.error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed transition"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
