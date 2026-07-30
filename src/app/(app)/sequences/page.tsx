import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Sequences · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Sequences" />
      <PhaseNotice phase={3} feature="Sequences" />
    </>
  )
}
