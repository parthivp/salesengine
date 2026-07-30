import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Settings · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Settings" />
      <PhaseNotice phase={1} feature="Settings" />
    </>
  )
}
