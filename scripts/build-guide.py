#!/usr/bin/env python3
"""
Builds the how-to guide as one self-contained HTML file.

Screenshots are embedded as data URLs rather than linked, so the guide is a single
file that works from a USB stick, an email attachment or a folder with no server —
which is how an operator actually opens something like this.

Run after scripts/seed-guide.ts and the screenshot pass:
    python3 scripts/build-guide.py > docs/how-to-use.html
"""

import base64
import html
import os
import sys

SHOTS = "/tmp/shots/opt"


def img(name: str, caption: str = "") -> str:
    path = os.path.join(SHOTS, f"{name}.png")
    if not os.path.exists(path):
        print(f"missing screenshot: {name}", file=sys.stderr)
        return ""
    with open(path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    cap = f'<figcaption>{caption}</figcaption>' if caption else ""
    return (
        f'<figure class="shot">'
        f'<img src="data:image/png;base64,{b64}" alt="{html.escape(caption or name)}" loading="lazy">'
        f"{cap}</figure>"
    )


# --------------------------------------------------------------------------
# Content
# --------------------------------------------------------------------------

SECTIONS = []


def section(id_, title, kicker, body):
    SECTIONS.append({"id": id_, "title": title, "kicker": kicker, "body": body})


section(
    "start", "Before you start", "the shape of it",
    """
<p class="lede">SalesEngine does the record-keeping, the prioritising, the drafting, the
email sending and the reply-reading. You decide who is worth talking to, and you
press send on anything that goes to LinkedIn.</p>

<p>That split is deliberate and permanent. Nothing in this app touches
linkedin.com on your behalf — no browser extension, no automation, no scraping.
Every LinkedIn action is you, in your own logged-in session, which is why your
account is not at risk.</p>

<div class="callout">
  <h4>Your day, in one line</h4>
  <p>Open <strong>LinkedIn queue</strong>, work the cards, done. Everything else in
  the app exists either to fill that queue or to catch what comes back from it.
  Fifteen minutes is a full day's outreach.</p>
</div>

<h3>Signing in</h3>
<p>Open <code>http://localhost:3000</code> and sign in with the account you created
during setup. There is no self-serve signup — accounts are created from the command
line, on purpose, because this is an internal tool before it is a product.</p>
"""
    + img("login", "The sign-in screen. One account per person; roles decide what each can see."),
)

section(
    "dashboard", "Dashboard", "where you land",
    """
<p>The first thing you see. It answers one question — <em>is anything waiting for
me?</em> — and otherwise gets out of the way.</p>
"""
    + img("dashboard", "Dashboard: today's numbers, what needs attention, recent activity.")
    + """
<h3>What to look at</h3>
<ul>
  <li><strong>Cards waiting</strong> — LinkedIn work queued for you today.</li>
  <li><strong>Replies</strong> — anyone who has written back and not yet been dealt with.</li>
  <li><strong>Recent activity</strong> — the running history of what the app and you have done.</li>
</ul>
<p>If the numbers are all zero and you expected otherwise, go to
<strong>Admin → Readiness</strong>; it will tell you which part is not running.</p>
""",
)

section(
    "queue", "LinkedIn queue", "the daily loop",
    """
<p class="lede">This is the screen you will spend your time in. Everything else feeds it.</p>
"""
    + img("linkedin", "The queue: one card per person, each with a drafted note and the reasoning behind it.")
    + """
<h3>Working a card, step by step</h3>
<ol class="steps">
  <li><strong>Read the draft.</strong> It is composed from facts actually on the record —
  seniority, function, company size, whether you have emailed before. Nothing is
  inferred or invented.</li>
  <li><strong>Edit it if it does not sound like you.</strong> The box is editable; the
  character count updates as you type, and it turns red past LinkedIn's limit.</li>
  <li><strong>Press “Copy &amp; open profile.”</strong> The note is copied to your clipboard
  and their LinkedIn profile opens in a new tab.</li>
  <li><strong>Paste and send</strong> on LinkedIn, in your own browser.</li>
  <li><strong>Come back and click “I sent it.”</strong> This is your word, not something
  the app observed — it cannot see LinkedIn — and the timeline records it that way.</li>
</ol>

<h3>The other buttons</h3>
<table>
  <tr><td><strong>Already connected</strong></td><td>You are already connected to this person.
  Records the connection and takes them out of the campaign rather than marching them
  through the remaining steps.</td></tr>
  <tr><td><strong>Not a fit</strong></td><td>Wrong person. Marks them unqualified and stops
  any campaign they are in.</td></tr>
  <tr><td><strong>Skip</strong></td><td>Not today. The card comes back.</td></tr>
</table>

<h3>Reading the labels</h3>
<ul>
  <li><strong>score</strong> — how well they match, from seniority, function and company size.
  Higher cards come first.</li>
  <li><strong>Why:</strong> — the specific reasons behind that score, so you can disagree with it.</li>
  <li><strong>Grounded in:</strong> — which facts the draft actually used.</li>
  <li><span class="tag warn">generic</span> — the record was too thin to say anything specific,
  so the draft is close to a template. Anyone else in the same situation would get
  nearly the same note. Worth fixing before sending.</li>
</ul>

<h3>The daily cap</h3>
<p>Twenty connection requests a day. That is not an attempt to stay under a detection
threshold — it is roughly where acceptance rates fall and people start reporting you.
The queue warns rather than silently truncating, because a hidden cap looks like a
broken product.</p>

<div class="callout">
  <h4>“Invitations accepted”</h4>
  <p>The tile at the top shows how many of your invitations were accepted, and flags the
  oldest one still outstanding. You do not have to check LinkedIn for this — when
  someone accepts, LinkedIn emails you, and the app reads that notification and updates
  the record itself.</p>
  <p><strong>Outstanding is not the same as declined.</strong> LinkedIn never tells anyone an
  invitation was declined, so a request that never converts is genuinely
  indistinguishable from one still pending. The app says “outstanding” rather than
  inventing a status.</p>
</div>

<h3>“Write it my way”</h3>
<p>If English is not your first language, or the draft simply is not what you want to
say: click <strong>Write it my way</strong>, type your meaning however it comes out —
rough, ungrammatical, in note form — and press <strong>Improve</strong>.</p>
<p>It rewrites your words using only the facts on the record, and it is given what you
have already sent this person and other people recently, so it does not repeat you.
If it produces a number that is in neither your notes nor the record, the card flags
it — you are the one who knows whether it is true.</p>
<p class="muted">This needs an OpenAI key in <code>.env</code>. Without one the button is
simply absent and everything else works as normal.</p>
""",
)

section(
    "contacts", "Contacts", "the people",
    """
<p>Everyone you have imported or captured. Scored, filterable, and the source the queue
draws from.</p>
"""
    + img("contacts", "Contacts: score, status, company and the last thing that happened.")
    + """
<h3>Getting people in</h3>
<p>Two routes, both from the <strong>LinkedIn queue</strong> page:</p>
<ol class="steps">
  <li><strong>Import a lead list</strong> — a CSV keyed on LinkedIn profile URL. Re-importing
  the same list updates rather than duplicates, so you can add columns and import again.</li>
  <li><strong>Build target list</strong> — takes your highest-scoring contacts that have a
  profile URL and turns them into cards.</li>
</ol>

<div class="callout amber">
  <h4>Sales Navigator has no export</h4>
  <p>On any plan. There is no button to find. Build the CSV by hand from what is on
  screen — and while you are there, copy the <strong>industry</strong> and
  <strong>headcount</strong> into the file too. Those two fields are what the drafts read,
  and a list without them produces notes about geography.</p>
</div>

<h3>A contact's record</h3>
"""
    + img("contact-detail", "One person: their details, their company, and every interaction in order.")
    + """
<p>The timeline is the useful part — every connection request, acceptance, email, reply
and note, in order, with where each fact came from.</p>
""",
)

section(
    "accounts", "Accounts", "the companies",
    """
<p>People are grouped into companies automatically, by domain where you have one and by
name where you do not.</p>
"""
    + img("accounts", "Accounts: industry, headcount, and how many contacts you have at each.")
    + """
<p><strong>Industry and headcount matter more than they look.</strong> They are what the
LinkedIn drafts use to say something specific. An account without them produces
cards labelled <span class="tag warn">generic</span>.</p>
<p>You can fill them from the CSV import, or by connecting an enrichment provider under
<strong>Integrations</strong>.</p>
""",
)

section(
    "campaigns", "Sequences &amp; campaigns", "running it over a list",
    """
<p class="lede">A campaign runs the same shape over a whole list, and decides per person
what happens next.</p>
"""
    + img("sequences", "Every campaign, its status, and how many people are in it.")
    + """
<h3>What a campaign looks like</h3>
<pre class="flow">1  connect                        <span class="ann">← you send</span>
2  wait 3 days
3  if they accepted → message     <span class="ann">← you send</span>
4  wait 4 days
5  if still no reply → email      <span class="ann">← the app sends</span></pre>

<p><strong>LinkedIn steps stop and wait for you.</strong> The campaign does not advance
until you actually work the card, so it can never claim to have sent something you
did not. If a card sits untouched for two weeks it skips that step and moves on,
rather than parking forever while looking busy.</p>

<h3>The funnel</h3>
"""
    + img("sequence-detail", "A campaign: where people drop out, the steps, and the sending rules.")
    + """
<p>Every stage counts something that was actually recorded, never inferred from how far
along someone is:</p>
<table>
  <tr><td><strong>Enrolled</strong></td><td>Added to the campaign.</td></tr>
  <tr><td><strong>Invited</strong></td><td>You recorded a connection request as sent.</td></tr>
  <tr><td><strong>Accepted</strong></td><td>From LinkedIn's own notification email, or the
  Connections export.</td></tr>
  <tr><td><strong>Replied</strong></td><td>By email. LinkedIn replies are not visible to this app.</td></tr>
</table>
<p>The line about people <em>parked waiting on a card</em> is the one that explains a quiet
week: the campaign is not stuck, it is waiting for you.</p>
""",
)

section(
    "templates", "Templates", "what the emails say",
    """
<p>Reusable email copy with merge tags. Every template is checked for the patterns that
hurt deliverability before it can be used.</p>
"""
    + img("templates", "The composer, with a live preview against a real contact and the available merge tags.")
    + """
<h3>Merge tags</h3>
<p>Write <code>{{first_name}}</code> and the engine fills it per recipient. Use the fallback
form — <code>{{first_name | there}}</code> — so a missing value never blocks a send or
produces “Hi ,”.</p>
<p>The preview on the right renders against a real contact from your database, so you see
what actually goes out rather than the template.</p>
<p><strong>Write it my way</strong> works here too, and keeps the merge tags as tags rather
than resolving them.</p>
""",
)

section(
    "inbox", "Inbox", "what came back",
    """
<p>Replies, matched to the person who sent them and classified.</p>
"""
    + img("inbox", "Inbox: each reply with what the app made of it.")
    + """
<h3>What the classifications mean</h3>
<table>
  <tr><td><span class="tag good">interested</span></td><td>Stops the campaign immediately and
  files a task. Nothing damages a relationship faster than a fifth automated email after
  someone has answered.</td></tr>
  <tr><td><span class="tag">not now</span></td><td>Genuine interest, wrong timing. Stops the
  campaign; worth a diarised follow-up.</td></tr>
  <tr><td><span class="tag">out of office</span></td><td>Holds the campaign until they are
  back, rather than stopping it.</td></tr>
  <tr><td><span class="tag warn">unsubscribe</span></td><td>Honoured permanently, across every
  campaign, immediately.</td></tr>
  <tr><td><span class="tag warn">bounce</span></td><td>Marks the address dead so nothing else
  is sent to it.</td></tr>
</table>
<p>The app classifies; you judge. Anything it is unsure about is flagged for review rather
than acted on.</p>
""",
)

section(
    "tasks", "My tasks", "the follow-ups",
    """
<p>Everything with your name on it: LinkedIn cards, follow-up reminders, calls.</p>
"""
    + img("tasks", "Tasks, by due date, with what each one is about.")
    + """
<p>Most tasks appear here on their own — a campaign step comes due, someone accepts a
connection and the follow-up moves forward, a reply arrives and needs a human. You can
also add your own.</p>
""",
)

section(
    "deals", "Deals", "the pipeline",
    """
<p>Once someone is actually talking to you, they become a deal on a pipeline with stages
you control.</p>
"""
    + img("deals", "The pipeline, by stage, with value and expected close.")
    + """
<p>This is the part the app deliberately does not automate. Moving a deal is a judgement
about a conversation, not a data operation.</p>
""",
)

section(
    "reports", "Reports", "what is working",
    """
<p>Which campaign, and which step of it, actually produced conversations.</p>
"""
    + img("reports", "Reports: activity over time, and per-campaign performance.")
    + """
<div class="callout">
  <h4>Judge by replies, not opens</h4>
  <p>Open tracking is off by default and should stay off. Apple Mail Privacy Protection
  and Gmail's image proxy pre-fetch tracking pixels, so opens are badly inflated — and
  the pixel itself is a small deliverability cost. Reply rate is the number that means
  something.</p>
</div>
""",
)

section(
    "cleanup", "Deleting things", "when a record should not be there",
    """
<p class="lede">A test import, a company you no longer track, a campaign built wrong.
Contacts, accounts, campaigns, templates and deals can all be deleted — and every
confirmation tells you what else goes with it before you press the button.</p>

<p>A contact is never one row. Deleting one also removes their timeline, the emails to
and from them, their tasks, their deals and their campaign enrolments. So the dialog
counts those first rather than asking “are you sure?” about an unspecified amount of
damage.</p>
"""
    + img("delete-contacts", "Tick the rows, press Delete. The confirmation counts the collateral.")
    + """
<h3>Deleting a company</h3>
<p>Removing a company does <strong>not</strong> remove its people by default — someone you
stop tracking as an account is still a person you know. If you do want them gone,
tick the box, and the dialog restates the cost as <em>their</em> cost.</p>
"""
    + img("delete-account", "The option is offered, not guessed, and taking it changes what the dialog says.")
    + """
<div class="callout amber">
  <h4>Two things deleting will not do</h4>
  <p><strong>It will not un-unsubscribe anyone.</strong> If someone unsubscribed or you
  marked them do-not-contact, that is kept after the contact is gone — including when
  they are removed as part of a company. Re-importing them later will not start
  emailing them again.</p>
  <p><strong>It will not stop a campaign mid-flight.</strong> A running campaign with
  people still in it refuses to be deleted. Pause it first — that stops everyone where
  they are — then delete it.</p>
</div>

<p>Every delete is written to the <strong>Audit log</strong>, one entry per record, so
“was this one of them?” has an answer afterwards. Nothing here is undoable.</p>
""",
)

section(
    "admin", "Admin", "setup and health",
    """
<h3>Readiness</h3>
<p>The first place to look when nothing is happening. It checks every way the system can
appear healthy and do nothing.</p>
"""
    + img("readiness", "Readiness: blockers, warnings and what to do about each.")
    + """
<p>A dashboard full of zeroes reads the same whether the cause is a quiet week, a dead
worker, an unverified domain or a mailbox nobody polls. This page tells them apart.</p>

<h3>Mailboxes</h3>
"""
    + img("mailboxes", "The sending identity, its DNS authentication, and reply collection.")
    + """
<ul>
  <li><strong>SPF / DKIM / DMARC</strong> must be green. Unauthenticated mail goes to spam and
  damages the domain permanently, so the app refuses to send until they pass.</li>
  <li><strong>Warming</strong> — a new sending domain starts at 20 a day and ramps up. Going
  from zero to a hundred is the classic way to get filtered for good.</li>
  <li><strong>Microsoft 365 reply collection</strong> — connects your mailbox through Graph.
  This is what makes replies and connection-acceptance tracking work.</li>
</ul>

<h3>Users &amp; teams</h3>
"""
    + img("users", "People, their roles and what each role can see.")
    + """
<p>Roles are enforced on the server, not by hiding buttons. A rep sees their own records;
a manager sees their team's; an admin sees everything.</p>

<h3>Integrations</h3>
"""
    + img("integrations", "Optional connections. Everything works without them.")
    + """
<h3>Settings</h3>
"""
    + img("settings", "Workspace-level settings: sending windows, pipeline stages, defaults.")
    + """
<h3>Audit log</h3>
"""
    + img("audit", "Who did what, when. Every write that matters is recorded.")
    + """
""",
)

section(
    "reference", "Reference", "who does what",
    """
<h3>What runs by itself, and what does not</h3>
<table class="wide">
  <thead><tr><th>Step</th><th>Who</th><th>Why</th></tr></thead>
  <tbody>
    <tr><td>Sourcing leads</td><td class="you">You</td><td>Needs judgement, and no export exists</td></tr>
    <tr><td>Scoring and grouping</td><td class="app">App</td><td>Mechanical</td></tr>
    <tr><td>Drafting messages</td><td class="app">App</td><td>From facts on the record only</td></tr>
    <tr><td><strong>Sending on LinkedIn</strong></td><td class="you">You</td><td>Automating it risks your account. Non-negotiable.</td></tr>
    <tr><td>Sending email</td><td class="app">App</td><td>Your mailbox, your domain, capped and warmed</td></tr>
    <tr><td>Reading replies</td><td class="app">App</td><td>Stops campaigns before you annoy someone</td></tr>
    <tr><td>Tracking acceptances</td><td class="app">App</td><td>Read from LinkedIn's notification email to your inbox</td></tr>
    <tr><td>Deciding what a reply means</td><td class="you">You</td><td>The app classifies; you judge</td></tr>
    <tr><td>Moving a deal</td><td class="you">You</td><td>A sales job, not a data job</td></tr>
  </tbody>
</table>

<h3>Limits worth knowing</h3>
<table>
  <tr><td>Connection requests</td><td>20 / day</td></tr>
  <tr><td>LinkedIn messages</td><td>30 / day</td></tr>
  <tr><td>Connection note length</td><td>300 characters, enforced</td></tr>
  <tr><td>Email, new domain</td><td>20 / day, ramping to 200</td></tr>
  <tr><td>Campaign waiting on you</td><td>14 days, then it skips the step</td></tr>
</table>

<h3>When something looks wrong</h3>
<table>
  <tr><td>Queue is empty</td><td>Press <strong>Build target list</strong>. If it queues nothing,
  you have no contacts with a profile URL.</td></tr>
  <tr><td>Every card says <span class="tag warn">generic</span></td><td>The accounts have no
  industry or headcount. Add them to the CSV and re-import.</td></tr>
  <tr><td>Nothing is sending</td><td><strong>Admin → Readiness</strong>. Usually
  <code>EMAIL_TRANSPORT</code> is still <code>log</code>, or the mailbox is blocked on DNS.</td></tr>
  <tr><td>No replies ever arrive</td><td>Check the mailbox row says <em>reply collection on</em>
  and has polled recently.</td></tr>
  <tr><td>Campaign is not moving</td><td>Look for “parked waiting on a card” on the campaign
  page. It is waiting for you.</td></tr>
</table>
""",
)

# --------------------------------------------------------------------------
# Render
# --------------------------------------------------------------------------

nav = "\n".join(
    f'<li><a href="#{s["id"]}">{s["title"]}</a></li>' for s in SECTIONS
)

body = "\n".join(
    f'<section id="{s["id"]}">'
    f'<p class="kicker">{s["kicker"]}</p>'
    f'<h2>{s["title"]}</h2>'
    f'{s["body"]}'
    f"</section>"
    for s in SECTIONS
)

print(f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SalesEngine — how to use it</title>
<style>
  :root{{
    --ink-900:#12161c;--ink-700:#39424e;--ink-500:#6a7380;--ink-400:#8b939d;
    --ink-200:#e0e4e9;--ink-100:#eef1f4;--surface:#fff;--page:#f6f8fa;
    --brand:#2f6df6;--brand-soft:#eaf1fe;--good:#0e8a5f;--good-soft:#e6f5ef;
    --warn:#9a6206;--warn-soft:#fdf2e0;--rule:#e6eaef;
  }}
  @media (prefers-color-scheme:dark){{
    :root{{
      --ink-900:#eef1f4;--ink-700:#c5ccd4;--ink-500:#98a1ab;--ink-400:#7d8691;
      --ink-200:#333b45;--ink-100:#232a32;--surface:#181d23;--page:#0f1317;
      --brand:#7aa3ff;--brand-soft:#1b2740;--good:#4fc596;--good-soft:#0f2a21;
      --warn:#e0a955;--warn-soft:#302410;--rule:#2b333c;
    }}
    .shot img{{filter:brightness(.92)}}
  }}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--page);color:var(--ink-900);
    font:16px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}}
  .wrap{{max-width:1180px;margin:0 auto;padding:0 24px}}
  header.top{{padding:56px 0 32px;border-bottom:1px solid var(--rule);margin-bottom:8px}}
  header.top h1{{font-size:34px;margin:0 0 6px;letter-spacing:-.02em}}
  header.top p{{margin:0;color:var(--ink-500);font-size:16px;max-width:62ch}}
  .layout{{display:grid;grid-template-columns:210px 1fr;gap:48px;align-items:start}}
  @media (max-width:900px){{.layout{{grid-template-columns:1fr;gap:0}} nav.toc{{position:static!important;margin:24px 0}}}}
  nav.toc{{position:sticky;top:24px;padding:20px 0}}
  nav.toc ol{{list-style:none;margin:0;padding:0;font-size:13.5px}}
  nav.toc li{{margin:0 0 7px}}
  nav.toc a{{color:var(--ink-500);text-decoration:none}}
  nav.toc a:hover{{color:var(--brand)}}
  section{{padding:44px 0;border-bottom:1px solid var(--rule)}}
  section:last-child{{border-bottom:0}}
  .kicker{{font-size:11.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-400);
    margin:0 0 4px;font-weight:600}}
  h2{{font-size:26px;margin:0 0 16px;letter-spacing:-.015em}}
  h3{{font-size:17px;margin:30px 0 10px;letter-spacing:-.005em}}
  h4{{font-size:14px;margin:0 0 5px}}
  p{{margin:0 0 13px;color:var(--ink-700);max-width:70ch}}
  .lede{{font-size:17.5px;color:var(--ink-900)}}
  .muted{{color:var(--ink-500);font-size:14px}}
  ul,ol{{color:var(--ink-700);max-width:70ch;padding-left:22px}}
  li{{margin:0 0 7px}}
  ol.steps{{counter-reset:s;list-style:none;padding-left:0}}
  ol.steps li{{counter-increment:s;position:relative;padding-left:34px;margin-bottom:11px}}
  ol.steps li::before{{content:counter(s);position:absolute;left:0;top:1px;width:22px;height:22px;
    border-radius:50%;background:var(--brand-soft);color:var(--brand);font-size:12px;font-weight:650;
    display:grid;place-items:center}}
  code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
    background:var(--ink-100);padding:1.5px 5px;border-radius:4px}}
  pre.flow{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;line-height:1.9;
    background:var(--ink-100);padding:14px 18px;border-radius:10px;overflow-x:auto;max-width:70ch;
    color:var(--ink-900)}}
  pre.flow .ann{{color:var(--ink-400)}}
  table{{border-collapse:collapse;width:100%;max-width:74ch;font-size:14.5px;margin:6px 0 14px}}
  table.wide{{max-width:100%}}
  td,th{{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rule);
    vertical-align:top;color:var(--ink-700)}}
  th{{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-400);font-weight:600}}
  td:first-child{{color:var(--ink-900);width:31%}}
  td.you{{color:var(--warn);font-weight:600;width:auto}}
  td.app{{color:var(--good);font-weight:600;width:auto}}
  .tag{{display:inline-block;font-size:11.5px;font-weight:600;padding:1.5px 7px;border-radius:5px;
    background:var(--ink-100);color:var(--ink-500)}}
  .tag.warn{{background:var(--warn-soft);color:var(--warn)}}
  .tag.good{{background:var(--good-soft);color:var(--good)}}
  .callout{{background:var(--surface);border:1px solid var(--ink-200);border-left:3px solid var(--brand);
    border-radius:8px;padding:14px 18px;margin:18px 0;max-width:72ch}}
  .callout.amber{{border-left-color:var(--warn)}}
  .callout p{{margin:0;font-size:14.5px}}
  .callout p+p{{margin-top:9px}}
  figure.shot{{margin:18px 0 22px}}
  figure.shot img{{width:100%;display:block;border:1px solid var(--ink-200);border-radius:10px;
    background:var(--surface)}}
  figcaption{{font-size:13px;color:var(--ink-400);margin-top:8px}}
  footer{{padding:36px 0 64px;color:var(--ink-400);font-size:13.5px}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>SalesEngine — how to use it</h1>
    <p>Every screen, what it is for, and the order you meet them in. Screenshots are
    from a live workspace with real data in it.</p>
  </header>

  <div class="layout">
    <nav class="toc"><ol>{nav}</ol></nav>
    <main>{body}</main>
  </div>

  <footer>
    The one hard rule: nothing in this system touches linkedin.com on your behalf.
    No headless browser, no proxies, no fingerprint rotation, no scraping. Every
    LinkedIn action is a person pressing send in their own logged-in session.
  </footer>
</div>
</body>
</html>""")
