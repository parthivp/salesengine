'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { login } from '@/lib/auth'
import { logger } from '@/lib/logger'

export type LoginState = { error: string | null }

const schema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

export async function loginAction(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  try {
    const result = await login(parsed.data.email, parsed.data.password)
    if (!result.ok) return { error: result.error }
  } catch (err) {
    logger.error({ err }, 'login failed unexpectedly')
    return { error: 'Something went wrong. Please try again.' }
  }

  redirect('/dashboard')
}
