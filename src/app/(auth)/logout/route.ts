import { NextResponse } from 'next/server'
import { destroySession } from '@/lib/auth'
import { env } from '@/lib/env'

async function end() {
  await destroySession()
  return NextResponse.redirect(new URL('/login', env.APP_URL), { status: 303 })
}

export const POST = end
export const GET = end
