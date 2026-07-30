import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'LinkedIn queue · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="LinkedIn queue" />
      <PhaseNotice phase={6} feature="LinkedIn queue" />
    </>
  )
}
