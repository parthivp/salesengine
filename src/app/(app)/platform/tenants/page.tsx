import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Tenants · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Tenants" />
      <PhaseNotice phase={1} feature="Tenants" />
    </>
  )
}
