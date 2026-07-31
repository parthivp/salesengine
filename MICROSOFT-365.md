# Connecting a Microsoft 365 mailbox

For reply collection. IMAP is not an option: Basic authentication for IMAP is
permanently disabled in every Exchange Online tenant, and Microsoft's own
documentation states that neither you nor Microsoft support can re-enable it. So
this uses Microsoft Graph with an app registration.

You need to be a Global Administrator, or have someone who is grant consent at
step 4.

---

## 1. Register the app

[Entra admin centre](https://entra.microsoft.com) → **Applications** → **App registrations**
→ **New registration**.

- **Name**: `SalesEngine reply collection`
- **Supported account types**: *Accounts in this organizational directory only*
- **Redirect URI**: leave blank — this app never signs a user in

Register, then copy from the Overview page:

- **Application (client) ID**
- **Directory (tenant) ID**

## 2. Create a client secret

**Certificates & secrets** → **Client secrets** → **New client secret**.

Set the longest expiry you are comfortable with, and put a reminder in your
calendar for a week before it. **Copy the `Value` column, not `Secret ID`** — the
value is shown once and never again.

## 3. Add the permission

**API permissions** → **Add a permission** → **Microsoft Graph** →
**Application permissions** (not Delegated — there is no user signed in).

Add **`Mail.Read`** — and **`Mail.Send`** if you want the app to send email as
well as read replies.

`Mail.ReadBasic.All` is the lower-privileged option and is not enough here: it
excludes the message body, which the classifier needs to tell an interested reply
from a decline.

**On `Mail.Send`.** Adding it means sequences send from this mailbox, on your own
domain, through the same app registration — no Amazon SES account, no domain to
verify, no sandbox to come out of, and SPF, DKIM and DMARC already correct because
Microsoft set them up. Leave it off and everything still works except sending: the
LinkedIn queue, reply detection and connection-acceptance tracking all need only
`Mail.Read`.

Both permissions are scoped to the single mailbox by step 5, so `Mail.Send` does
not mean "send as anyone in the organisation" once that policy is in place.

## 4. Grant admin consent

Still on **API permissions**: **Grant admin consent for &lt;your tenant&gt;**.

Until this is done the app authenticates and then gets 403 on every mailbox.

## 5. Restrict it to one mailbox — do not skip this

As granted, these permissions apply to **every mailbox in your organisation** —
`Mail.Read` reads all of them, and `Mail.Send` can send as any of them.
That is far more than it needs, and far more than you want sitting in an app
registration.

In [Exchange Online PowerShell](https://learn.microsoft.com/en-us/powershell/exchange/connect-to-exchange-online-powershell):

```powershell
Connect-ExchangeOnline

# A group holding only the mailboxes this app may read
New-DistributionGroup -Name "SalesEngine Mailboxes" `
  -Type Security -Alias salesengine-mailboxes `
  -Members "you@yourdomain.com"

New-ApplicationAccessPolicy `
  -AppId "<Application (client) ID>" `
  -PolicyScopeGroupId salesengine-mailboxes@yourdomain.com `
  -AccessRight RestrictAccess `
  -Description "SalesEngine may read only these mailboxes"
```

Confirm it took effect:

```powershell
Test-ApplicationAccessPolicy -Identity you@yourdomain.com -AppId "<client id>"
# AccessCheckResult should be: Granted

Test-ApplicationAccessPolicy -Identity someone.else@yourdomain.com -AppId "<client id>"
# AccessCheckResult should be: Denied
```

Policy changes can take up to an hour to propagate. If the app is denied
immediately after you create the policy, wait and retry before assuming it is
misconfigured.

## 6. Connect it in SalesEngine

**Admin → Mailboxes**, on the mailbox row: **Replies arrive via: Microsoft 365**
→ **Connect**. Enter the directory ID, client ID, secret value and the mailbox
address.

It verifies against Graph before saving anything, so a mistake is reported
immediately rather than becoming a mailbox that silently never polls. The secret
is encrypted with AES-256-GCM and never shown again.

Polling starts from the **next** message that arrives — existing mail is not
ingested, so connecting this does not stop sequences on old threads or file
hundreds of tasks.

---

## When it does not work

| What you see | What it means |
|---|---|
| `invalid_client` from Entra | Wrong secret, or you copied the Secret ID instead of the Value. |
| `unauthorized_client` | The app is not in this tenant, or the directory ID is wrong. |
| "Authenticated, but denied access to that mailbox" | Admin consent was not granted, **or** an Application Access Policy excludes it. Run `Test-ApplicationAccessPolicy` to tell the two apart. |
| "No mailbox found" | The address does not resolve in that tenant. Use the full UPN. |
| Worked, then stopped weeks later | The client secret expired. Create a new one and reconnect. |

The last row is the one that catches people out, and it fails quietly: replies
just stop arriving. **Admin → Readiness** reports a failing mailbox, and the
Inbox shows the error on the mailbox — check there before assuming nobody has
replied.
