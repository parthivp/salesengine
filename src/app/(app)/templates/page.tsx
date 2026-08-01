import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, EmptyState, Badge } from '@/components/ui'
import { formatRelative } from '@/lib/utils'
import { lintContent } from '@/lib/email/deliverability'
import { AVAILABLE_TAGS, unknownTags } from '@/lib/email/merge'
import { Mail } from 'lucide-react'
import { TemplateComposer } from './composer'
import { rewriteEnabled } from '@/lib/ai/rewrite'

export const metadata = { title: 'Templates · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function TemplatesPage() {
  const auth = await requirePermission('template:read')

  const templates = await withTenant(auth.tenant.id, () =>
    db().emailTemplate.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 })
  )

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable email copy with merge tags. Every template is linted for the patterns that hurt deliverability before it can be used."
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <TemplateComposer canImprove={rewriteEnabled()} />
        </div>

        <div className="lg:col-span-2 space-y-6">
          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">Merge tags</h2>
              <p className="mt-0.5 text-xs text-ink-500">
                Use <code className="text-ink-700">{'{{tag | fallback}}'}</code> so a missing value
                never blocks a send.
              </p>
            </div>
            <ul className="p-4 grid grid-cols-2 gap-1.5">
              {AVAILABLE_TAGS.map((t) => (
                <li key={t.key} className="text-xs">
                  <code className="text-brand-700">{`{{${t.key}}}`}</code>
                  <span className="block text-ink-400 truncate">{t.example}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">
                Saved templates{' '}
                <span className="text-ink-400 font-normal">({templates.length})</span>
              </h2>
            </div>
            {templates.length === 0 ? (
              <EmptyState
                icon={Mail}
                title="No templates yet"
                description="Compose one on the left and save it to reuse across sequences."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {templates.map((t) => {
                  const lint = lintContent({
                    subject: t.subject,
                    bodyText: t.bodyText,
                    hasUnsubscribe: true,
                  })
                  const bad = unknownTags(`${t.subject} ${t.bodyText}`)
                  return (
                    <li key={t.id} className="px-5 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-ink-900 truncate">{t.name}</p>
                          <p className="text-xs text-ink-500 truncate">{t.subject}</p>
                        </div>
                        <Badge
                          tone={
                            lint.blocking || bad.length
                              ? 'danger'
                              : lint.score > 20
                                ? 'warning'
                                : 'success'
                          }
                        >
                          {lint.blocking || bad.length ? 'needs work' : lint.score > 20 ? 'risky' : 'clean'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-ink-400">
                        Updated {formatRelative(t.updatedAt)}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
