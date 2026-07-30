import Link from 'next/link'
import { requirePermission } from '@/lib/auth'
import { PageHeader } from '@/components/ui'
import { ImportWizard } from './wizard'
import { ArrowLeft } from 'lucide-react'

export const metadata = { title: 'Import contacts · SalesEngine' }

export default async function ImportPage() {
  await requirePermission('contact:create')

  return (
    <>
      <Link
        href="/contacts"
        className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900 mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to contacts
      </Link>
      <PageHeader
        title="Import contacts"
        description="Upload a CSV, map the columns, validate, then import. Existing values are never overwritten."
      />
      <div className="max-w-3xl">
        <ImportWizard />
      </div>
    </>
  )
}
