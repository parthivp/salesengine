import Link from 'next/link'
import { requirePermission } from '@/lib/auth'
import { PageHeader } from '@/components/ui'
import { ArrowLeft } from 'lucide-react'
import { PasteImport } from './client'

export const metadata = { title: 'Read a saved LinkedIn page · SalesEngine' }

export default async function PastePage() {
  await requirePermission('contact:create')

  return (
    <>
      <Link
        href="/linkedin"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to the queue
      </Link>
      <PageHeader
        title="Read a saved LinkedIn page"
        description="Sales Navigator has no export. Save a page from your browser, and this reads the people out of it — you check what it found before anything is imported."
      />
      <div className="max-w-6xl">
        <PasteImport />
      </div>
    </>
  )
}
