import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Audit log · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Audit log" />
      <PhaseNotice phase={1} feature="Audit log" />
    </>
  )
}
