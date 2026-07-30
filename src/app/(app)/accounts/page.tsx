import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Accounts · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Accounts" />
      <PhaseNotice phase={2} feature="Accounts" />
    </>
  )
}
