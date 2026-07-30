import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Inbox · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Inbox" />
      <PhaseNotice phase={3} feature="Inbox" />
    </>
  )
}
