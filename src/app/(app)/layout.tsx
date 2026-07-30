import { redirect } from 'next/navigation'
import { getAuth } from '@/lib/auth'
import { Sidebar } from '@/components/sidebar'
import { Topbar } from '@/components/topbar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuth()
  if (!auth) redirect('/login')

  return (
    <div className="min-h-screen flex bg-ink-50">
      <Sidebar role={auth.user.role} isPlatformAdmin={auth.user.isPlatformAdmin} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar user={auth.user} tenant={auth.tenant} />
        <main className="flex-1 px-6 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  )
}
