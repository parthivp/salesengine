import { db } from '../db'

/**
 * Campaign funnel: where people actually fall out.
 *
 * The sequences page used to report emails sent and a reply rate, which for a
 * LinkedIn campaign describes none of the work — no email is sent at all, and the
 * two numbers that matter are how many invitations were accepted and how many of
 * those turned into a conversation.
 *
 * Every stage is counted from a fact somebody recorded or a system observed, never
 * inferred from the step index. An enrollment sitting on step 3 does not prove
 * steps 1 and 2 happened: a step can time out, be skipped by a condition, or be
 * abandoned by the operator, and a funnel that assumes otherwise overstates the
 * top and flatters the campaign.
 *
 * Must be called inside a tenant context.
 */

export type FunnelStage = {
  key: 'enrolled' | 'invited' | 'accepted' | 'replied'
  label: string
  count: number
  /** Share of the stage before it, so the drop is legible without arithmetic. */
  ofPrevious: number | null
  hint?: string
}

export type CampaignFunnel = {
  stages: FunnelStage[]
  /** Parked on a card nobody has actioned. The number that explains a quiet week. */
  waitingOnYou: number
  medianDaysToAccept: number | null
}

export async function campaignFunnel(sequenceId: string): Promise<CampaignFunnel> {
  const enrollments = await db().sequenceEnrollment.findMany({
    where: { sequenceId },
    select: {
      status: true,
      contact: {
        select: {
          linkedinInvitedAt: true,
          linkedinConnectedAt: true,
          lastRepliedAt: true,
        },
      },
    },
  })

  const enrolled = enrollments.length
  const invited = enrollments.filter((e) => e.contact.linkedinInvitedAt).length
  const accepted = enrollments.filter((e) => e.contact.linkedinConnectedAt).length
  const replied = enrollments.filter(
    (e) => e.contact.lastRepliedAt || e.status === 'stopped_replied'
  ).length

  const share = (n: number, of: number) => (of > 0 ? n / of : null)

  const gaps = enrollments
    .filter((e) => e.contact.linkedinInvitedAt && e.contact.linkedinConnectedAt)
    .map(
      (e) =>
        (e.contact.linkedinConnectedAt!.getTime() - e.contact.linkedinInvitedAt!.getTime()) /
        86_400_000
    )
    // Negative gaps happen: someone marked "already connected" was connected
    // before the campaign invited them. Counting those would drag the median
    // below zero and make the number nonsense.
    .filter((d) => d >= 0)
    .sort((a, b) => a - b)

  const median =
    gaps.length === 0
      ? null
      : gaps.length % 2
        ? gaps[(gaps.length - 1) / 2]
        : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2

  return {
    stages: [
      { key: 'enrolled', label: 'Enrolled', count: enrolled, ofPrevious: null },
      {
        key: 'invited',
        label: 'Invited',
        count: invited,
        ofPrevious: share(invited, enrolled),
        hint: 'connection request recorded as sent',
      },
      {
        key: 'accepted',
        label: 'Accepted',
        count: accepted,
        ofPrevious: share(accepted, invited),
        hint: 'from LinkedIn’s own notification, or the Connections export',
      },
      {
        key: 'replied',
        label: 'Replied',
        count: replied,
        ofPrevious: share(replied, accepted),
        hint: 'by email — LinkedIn replies are not visible to this app',
      },
    ],
    waitingOnYou: enrollments.filter((e) => e.status === 'waiting_on_human').length,
    medianDaysToAccept: median == null ? null : Math.round(median * 10) / 10,
  }
}
