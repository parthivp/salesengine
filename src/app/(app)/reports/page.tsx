import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Reports · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Reports" />
      <PhaseNotice phase={5} feature="Reports" />
    </>
  )
}
