import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Deals · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Deals" />
      <PhaseNotice phase={5} feature="Deals" />
    </>
  )
}
