import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'My tasks · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="My tasks" />
      <PhaseNotice phase={5} feature="My tasks" />
    </>
  )
}
