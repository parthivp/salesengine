import { PageHeader, PhaseNotice } from '@/components/ui'

export const metadata = { title: 'Contacts · SalesEngine' }

export default function Page() {
  return (
    <>
      <PageHeader title="Contacts" />
      <PhaseNotice phase={2} feature="Contacts" />
    </>
  )
}
