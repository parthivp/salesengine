# SalesEngine LinkedIn Queue — Chrome extension

## What it does

- Fetches your queue from SalesEngine and shows it as a small panel on linkedin.com.
- Fills the connection-note textarea with the drafted message when you click **Fill note**.
- Reports back what you did, so the queue stays in sync.

## What it deliberately does not do

- **It never clicks Send.** The note is filled; the send is yours. This is the whole
  point of the design, not a limitation we intend to remove.
- It does not scrape profiles, search results, or your connection graph.
- It does not run on a schedule, in the background, or on pages you are not looking at.
- It does not touch LinkedIn when the tab is not focused.
- It requests host permission for `linkedin.com` and your SalesEngine origin only.

If you want automated sending, this extension is not it, and no version of it will be.
LinkedIn's User Agreement prohibits automated activity, and a restricted account takes
your rep's real professional identity offline — a far worse outcome than three seconds
of clicking.

## Install (unpacked, for now)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Click the toolbar icon and set your SalesEngine URL (defaults to
   `http://localhost:3000`)
4. Sign in to SalesEngine in the same browser — the extension reuses that session
   cookie and stores no credentials of its own

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | remembers your SalesEngine URL and the current card |
| `activeTab` | reads the LinkedIn tab you are looking at, only when you act |
| `https://www.linkedin.com/*` | to inject the panel and fill the note field |
| your SalesEngine origin | to fetch the queue and post back outcomes |

No `tabs`, no `webRequest`, no `scripting` on arbitrary hosts, no analytics.
