import { db, tid } from './db'
import { logger } from './logger'

/**
 * Deleting things, and saying what that costs first.
 *
 * The app had no delete at all, which is defensible for about a week and then
 * becomes its own problem: a test import sits in the contact list forever, a
 * campaign built wrong cannot be cleared away, and the operator starts
 * distrusting the numbers because they are counting things that should not be
 * there.
 *
 * Two rules shape everything here.
 *
 * **Say what goes with it.** A contact is not one row. Deleting one destroys
 * their timeline, the emails to and from them, their tasks and their deals — and
 * an operator tidying up a list has no reason to expect that. So every delete has
 * a preview, and the confirmation names the counts rather than asking "are you
 * sure?" about an unspecified amount of damage.
 *
 * **Never let a delete undo a suppression.** Someone who unsubscribed is recorded
 * in two places: `unsubscribedAt` on the contact, and a `SuppressionEntry` keyed
 * on their address. The second has no foreign key to the first, deliberately — so
 * deleting the contact leaves the suppression standing and re-importing them
 * cannot start emailing them again. That already held for a real unsubscribe. It
 * did *not* hold for someone marked do-not-contact by hand, which writes no
 * suppression entry, so this module writes one before deleting them. Emailing
 * someone who told you to stop is the worst thing this system can do, and
 * "we deleted the record" is not a defence.
 */

export type DeletePreview = {
  /** What is being removed, for the confirmation line. */
  label: string
  /** Collateral, by kind, only listing what is non-zero. */
  alsoRemoved: { what: string; count: number }[]
  /** Things that survive but change, e.g. contacts losing their account. */
  sideEffects: string[]
  /** Non-empty means refuse: the caller shows these instead of a confirm button. */
  blockers: string[]
  /**
   * An offer the operator can accept, when there is a defensible answer either
   * way and only they know which they mean.
   *
   * Deleting a company because the record was junk should take its people with
   * it; deleting one because you have stopped tracking them should not. Guessing
   * is wrong in half of all cases, so the dialog asks.
   */
  option?: { key: 'cascadeContacts'; label: string; count: number }
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function previewContactDelete(ids: string[]): Promise<DeletePreview> {
  const contacts = await db().contact.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, email: true },
  })

  const [activities, emails, tasks, deals, enrollments] = await Promise.all([
    db().activity.count({ where: { contactId: { in: ids } } }),
    db().emailMessage.count({ where: { contactId: { in: ids } } }),
    db().task.count({ where: { contactId: { in: ids } } }),
    db().deal.count({ where: { contactId: { in: ids } } }),
    db().sequenceEnrollment.count({ where: { contactId: { in: ids } } }),
  ])

  const label =
    contacts.length === 1
      ? [contacts[0].firstName, contacts[0].lastName].filter(Boolean).join(' ') ||
        contacts[0].email ||
        'this contact'
      : `${contacts.length} contacts`

  return {
    label,
    alsoRemoved: [
      { what: plural(activities, 'timeline entry', 'timeline entries'), count: activities },
      { what: plural(emails, 'email'), count: emails },
      { what: plural(tasks, 'task'), count: tasks },
      { what: plural(deals, 'deal'), count: deals },
      { what: plural(enrollments, 'campaign enrolment'), count: enrollments },
    ].filter((x) => x.count > 0),
    sideEffects: [
      'Anyone who unsubscribed stays suppressed — re-importing them will not start emailing them again.',
    ],
    blockers: [],
  }
}

export async function deleteContacts(ids: string[]): Promise<{ deleted: number }> {
  // Preserve the suppression *before* the row goes. A contact marked
  // do-not-contact by hand has no suppression entry of their own, so deleting
  // them without this makes them freshly emailable on the next import.
  const suppressible = await db().contact.findMany({
    where: {
      id: { in: ids },
      email: { not: null },
      OR: [{ unsubscribedAt: { not: null } }, { status: 'do_not_contact' }],
    },
    select: { email: true, unsubscribedAt: true },
  })

  for (const c of suppressible) {
    await db().suppressionEntry.upsert({
      where: { tenantId_type_value: { tenantId: tid(), type: 'email', value: c.email! } },
      update: {},
      create: {
        tenantId: tid(),
        type: 'email',
        value: c.email!,
        reason: c.unsubscribedAt ? 'unsubscribe' : 'manual',
      },
    })
  }

  if (suppressible.length) {
    logger.info(
      { count: suppressible.length },
      'preserved suppression for contacts being deleted'
    )
  }

  const { count } = await db().contact.deleteMany({ where: { id: { in: ids } } })
  return { deleted: count }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function previewAccountDelete(
  id: string,
  opts: { cascadeContacts?: boolean } = {}
): Promise<DeletePreview> {
  const account = await db().account.findUnique({ where: { id }, select: { name: true } })
  const people = await db().contact.findMany({ where: { accountId: id }, select: { id: true } })
  const contacts = people.length
  const [deals, activities] = await Promise.all([
    db().deal.count({ where: { accountId: id } }),
    db().activity.count({ where: { accountId: id } }),
  ])

  // With the option taken, the real cost is the contacts' cost — their
  // timelines, their mail, their deals — so the preview has to be theirs.
  const cascaded = opts.cascadeContacts && contacts > 0
    ? await previewContactDelete(people.map((p) => p.id))
    : null

  return {
    label: account?.name ?? 'this account',
    alsoRemoved: [
      { what: plural(activities, 'timeline entry', 'timeline entries'), count: activities },
      ...(cascaded
        ? [{ what: plural(contacts, 'contact'), count: contacts }, ...cascaded.alsoRemoved]
        : []),
    ].filter((x) => x.count > 0),
    sideEffects: cascaded
      ? cascaded.sideEffects
      : [
          // Default: contacts and deals survive with no company rather than being
          // destroyed. People at a company you stop tracking are still people you know.
          contacts > 0
            ? `${contacts} ${plural(contacts, 'contact')} will stay, without a company.`
            : '',
          deals > 0 ? `${deals} ${plural(deals, 'deal')} will stay, without a company.` : '',
        ].filter(Boolean),
    blockers: [],
    option:
      contacts > 0
        ? {
            key: 'cascadeContacts',
            label: `Also delete the ${contacts} ${plural(contacts, 'contact')} at this company`,
            count: contacts,
          }
        : undefined,
  }
}

export async function deleteAccount(
  id: string,
  opts: { cascadeContacts?: boolean } = {}
): Promise<{ contactsDeleted: number }> {
  let contactsDeleted = 0

  if (opts.cascadeContacts) {
    const people = await db().contact.findMany({ where: { accountId: id }, select: { id: true } })
    // Through deleteContacts, not a bare deleteMany: the suppression guard has to
    // apply here too, or deleting a company is a way to un-unsubscribe everyone
    // who works there.
    if (people.length) {
      contactsDeleted = (await deleteContacts(people.map((p) => p.id))).deleted
    }
  }

  await db().account.deleteMany({ where: { id } })
  return { contactsDeleted }
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

export async function previewSequenceDelete(id: string): Promise<DeletePreview> {
  const sequence = await db().sequence.findUnique({
    where: { id },
    select: { name: true, status: true },
  })
  const [steps, active, total] = await Promise.all([
    db().sequenceStep.count({ where: { sequenceId: id } }),
    db().sequenceEnrollment.count({
      where: { sequenceId: id, status: { in: ['active', 'waiting_on_human', 'paused'] } },
    }),
    db().sequenceEnrollment.count({ where: { sequenceId: id } }),
  ])

  return {
    label: sequence?.name ?? 'this campaign',
    alsoRemoved: [
      { what: plural(steps, 'step'), count: steps },
      { what: plural(total, 'enrolment record'), count: total },
    ].filter((x) => x.count > 0),
    sideEffects: [
      'Contacts and everything already sent to them are untouched.',
    ],
    // Refuse rather than silently stopping live outreach. Pausing is one click
    // and makes the operator state the intent; deleting a running campaign out
    // from under people mid-sequence is not something to infer from a click on
    // a bin icon.
    blockers:
      sequence?.status === 'active' && active > 0
        ? [
            `${active} ${plural(active, 'person', 'people')} ${active === 1 ? 'is' : 'are'} ` +
              'still being worked by this campaign. Pause it first, which stops them where ' +
              'they are, then delete it.',
          ]
        : [],
  }
}

export async function deleteSequence(id: string): Promise<void> {
  await db().sequence.deleteMany({ where: { id } })
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function previewTemplateDelete(id: string): Promise<DeletePreview> {
  const template = await db().emailTemplate.findUnique({ where: { id }, select: { name: true } })
  const usedBy = await db().sequenceStep.findMany({
    where: { templateId: id },
    select: { sequence: { select: { name: true } } },
  })

  const names = [...new Set(usedBy.map((s) => s.sequence.name))]

  return {
    label: template?.name ?? 'this template',
    alsoRemoved: [],
    sideEffects: names.length
      ? [
          `Used by ${names.join(', ')}. Those steps keep the copy they already have — ` +
            'a template is a starting point, not a live link.',
        ]
      : [],
    blockers: [],
  }
}

export async function deleteTemplate(id: string): Promise<void> {
  await db().emailTemplate.deleteMany({ where: { id } })
}

// ---------------------------------------------------------------------------
// Inbox messages
// ---------------------------------------------------------------------------

export async function previewMessageDelete(ids: string[]): Promise<DeletePreview> {
  const messages = await db().emailMessage.findMany({
    where: { id: { in: ids }, direction: 'inbound' },
    select: { id: true, subject: true, status: true },
  })

  const label =
    messages.length === 1
      ? `“${messages[0].subject || '(no subject)'}”`
      : `${messages.length} messages`

  return {
    label,
    alsoRemoved: [],
    sideEffects: [
      // The reason this delete is safe, stated rather than assumed. Everything a
      // reply *did* — stopping the campaign, suppressing the address, marking the
      // contact replied — lives on those records, not on this one. Deleting the
      // mail is throwing away the copy, not reversing the decision.
      'Anything this reply already did — stopping a campaign, marking someone ' +
        'unsubscribed — stays done. Only the copy of the message goes.',
    ],
    blockers: [],
  }
}

export async function deleteMessages(ids: string[]): Promise<{ deleted: number }> {
  const { count } = await db().emailMessage.deleteMany({
    where: { id: { in: ids }, direction: 'inbound' },
  })
  return { deleted: count }
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export async function previewDealDelete(id: string): Promise<DeletePreview> {
  const deal = await db().deal.findUnique({ where: { id }, select: { name: true } })
  return {
    label: deal?.name ?? 'this deal',
    alsoRemoved: [],
    sideEffects: ['The contact and everything sent to them are untouched.'],
    blockers: [],
  }
}

export async function deleteDeal(id: string): Promise<void> {
  await db().deal.deleteMany({ where: { id } })
}
