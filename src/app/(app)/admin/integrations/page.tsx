import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Integrations · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Integrations" />
      <PhaseNotice phase={4} feature="Integrations" />
    </>
  )
}
