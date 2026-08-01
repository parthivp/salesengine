# Sales Navigator fixtures

Real pages, saved from a browser with **Ctrl+S → "Webpage, Complete"**, used to test
`src/lib/linkedin/parse-salesnav.ts`.

They are real on purpose. A parser tested against markup we wrote ourselves only
proves we can read our own selectors; the thing that actually breaks is LinkedIn
changing a page, and only a real page catches that.

## When the parser breaks

1. Save a fresh page here under a descriptive name.
2. `npx vitest run src/lib/__tests__/parse-salesnav.test.ts` — the failing test names
   the field.
3. `npx tsx scripts/parse-report.ts` — the per-field hit rate, before and after.

Keep the old fixture alongside the new one where the layout genuinely changed, so a
fix for the new page cannot silently break the old one.

## What is in them

Eight real people's names, titles, companies and locations, and the LinkedIn member
id of the account they were saved from. No cookies or tokens — a saved page does not
carry them.

If that is not something to keep in this repository, delete this directory. The
tests skip when it is absent rather than failing.
