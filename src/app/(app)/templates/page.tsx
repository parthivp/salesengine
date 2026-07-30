import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Templates · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Templates" />
      <PhaseNotice phase={3} feature="Templates" />
    </>
  )
}
