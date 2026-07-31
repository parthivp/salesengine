/**
 * The condition vocabulary, in one place with no imports.
 *
 * The engine evaluates these and the sequence UI labels them, and the two used to
 * agree only by coincidence — the UI kept a `Record<string, string>` of labels, so
 * a condition the engine understood but the UI did not simply rendered as nothing.
 * A branch invisible in the UI is worse than an unsupported one: the campaign looks
 * unconditional and behaves otherwise.
 *
 * Typing the label map against this union makes that a compile error.
 */
export const STEP_CONDITIONS = [
  'always',
  'if_opened',
  'if_not_opened',
  'if_clicked',
  'if_not_clicked',
  'if_no_reply',
  // Needs the LinkedIn acceptance signal, which arrives from LinkedIn's own
  // notification email — see src/lib/linkedin/acceptance.ts.
  'if_connected',
  'if_not_connected',
] as const

export type StepCondition = (typeof STEP_CONDITIONS)[number]
