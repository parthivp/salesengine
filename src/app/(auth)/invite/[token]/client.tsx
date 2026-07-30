'use client'

import { useState, useTransition } from 'react'
import { acceptInvite } from './actions'

export function AcceptInvite({ token, name: initialName }: { token: string; name: string }) {
  const [name, setName] = useState(initialName)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Checked here for a fast, kind message; the server checks length and content
  // independently, because this component is not a security boundary.
  const mismatch = confirm.length > 0 && password !== confirm
  const tooShort = password.length > 0 && password.length < 10

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('Those passwords do not match.')
      return
    }
    startTransition(async () => {
      const r = await acceptInvite({ token, name, password })
      // Success redirects, so anything returned here is a failure.
      if (r && !r.ok) setError(r.error)
    })
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-ink-700 mb-1">Your name</span>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
        />
      </label>

      <label className="block">
        <span className="block text-sm font-medium text-ink-700 mb-1">Choose a password</span>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
        />
        <span className={tooShort ? 'mt-1 block text-xs text-amber-700' : 'mt-1 block text-xs text-ink-400'}>
          At least 10 characters.
        </span>
      </label>

      <label className="block">
        <span className="block text-sm font-medium text-ink-700 mb-1">Confirm it</span>
        <input
          id="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
          className={
            mismatch
              ? 'w-full rounded-lg border border-red-300 px-3 py-2 text-sm outline-none'
              : 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition'
          }
        />
        {mismatch && <span className="mt-1 block text-xs text-red-700">These do not match.</span>}
      </label>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || !name.trim() || password.length < 10 || mismatch}
        className="w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {pending ? 'Setting up…' : 'Join the workspace'}
      </button>
    </form>
  )
}
