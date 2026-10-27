# Publish the Sila Mail API on silamail.glcpaints.com:9001 (two copies)

One program, two copies, **one name**. The app always calls `https://silamail.glcpaints.com:9001`;
DNS decides which copy answers (MailPlan APIs 2 and 3):

| | Internal copy | External copy |
|---|---|---|
| Server | `10.1.245.2` (silamail, inside) | `45.63.120.158` (sila.glcpaints.com, outside) |
| DNS for `silamail.glcpaints.com` | **internal** DNS → 10.1.245.2 | **public** DNS → 45.63.120.158 |
| Reads | `InternalMail` (live) | `Mail` (the published copy) |
| `MailApi:Role` | `Internal` | `External` |
| Mail Monitor figures | live from InternalMail | the snapshot the connector pushes |
| "Sync now" / "Add mailbox" | straight to the connector on the same server | handed to the connector with its next push |
| Also receives | — | the connector's monitor push and the publisher's batches |

Users read **their own** mailbox (found by their Sila username), read-only for now. Both copies
check the Sila login token with **7400's public key**.

> The connector pushes to the external copy by the **server's own name**,
> `https://sila.glcpaints.com:9001` — inside the company `silamail.glcpaints.com` points back to
> the internal copy.

## Step 1 — DNS and network (IT, once)

1. **Internal DNS**: `silamail.glcpaints.com` → `10.1.245.2` (probably there already).
2. **Public DNS**: `silamail.glcpaints.com` → `45.63.120.158`.
3. Port **9001** open: on 10.1.245.2 to the office network; on 45.63.120.158 to the internet (users
   outside the office). Both copies refuse anything without a valid Sila token.

## Step 2 — SQL (once, in SSMS)

On **silamail** (InternalMail):
1. `InternalMail_004_Username.sql`
2. `InternalMail_005_MailApiLogin.sql` (your own password) — login `sila_mail_api`, **read-only**.

On **sila.glcpaints.com** (Mail):
1. `Mail_002_CompressBodies.sql` (if not run yet), `Mail_004_Username.sql`
2. `Mail_003_ExternalLogin.sql` (your own password) — login `sila_mail_external`, read/write on `[mail]`.

## Step 3 — 7400's public key (once)

Both copies need `App_Data\auth-signing-key.public.pem`. The Files API (:7500) already has this file
in its `App_Data` folder — copy it. Or, on the 7400 server in the 7400 site folder:

```powershell
dotnet .\Plus.Api.dll --export-public-key
```

(It is a **public** key: safe to copy; the private key never leaves 7400.)

## Step 4 — Install each copy

On each server: extract `Sila.MailApi-IIS.zip` to `D:\API\MailApi\`, create
`D:\API\MailApi\App_Data\` and put the key from step 3 in it.

Create `D:\API\MailApi\appsettings.Mail.local.json` (never in the zip):

**Internal copy (10.1.245.2)**
```json
{
  "MailApi": { "Role": "Internal" },
  "ConnectionStrings": {
    "Mail": "Server=localhost;Database=InternalMail;User ID=sila_mail_api;Password=<step 2>;Encrypt=True;TrustServerCertificate=True;Application Name=Sila Mail API"
  }
}
```

**External copy (sila.glcpaints.com)**
```json
{
  "MailApi": { "Role": "External" },
  "ConnectionStrings": {
    "Mail": "Server=localhost;Database=Mail;User ID=sila_mail_external;Password=<step 2>;Encrypt=True;TrustServerCertificate=True;Application Name=Sila Mail API"
  },
  "Connector": { "PushKey": "<the Mail Monitor key = the connector's Monitor:PushKey>" },
  "Sync": { "Key": "<a new sync key = the connector's Publish:Key>" }
}
```

IIS on each: **Add Website** `9001-MailApi`, pool `9001-MailApi` (**No Managed Code**), path
`D:\API\MailApi`, **https 9001**, certificate `*.glcpaints.com`. Then (elevated PowerShell):

```powershell
icacls "D:\API\MailApi\appsettings.Mail.local.json" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "IIS AppPool\9001-MailApi:R"
icacls "D:\API\MailApi\App_Data" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "IIS AppPool\9001-MailApi:(OI)(CI)RX"
```

Recycle the pool. Check `https://silamail.glcpaints.com:9001/health` (from the office: the internal
copy) and `https://sila.glcpaints.com:9001/health` (the external copy):

```json
{"success":true,"service":"Sila Mail API","role":"Internal","databaseOk":true,...}
```

## Step 5 — The Mail Connector API (10.1.245.2)

1. Update it with the new `Sila.MailConnector-IIS.zip` (stop `9000-MailConnector`, copy over
   `D:\API\Mail` keeping `appsettings.Exchange.local.json`, start). The new `appsettings.Production.json`
   lets the internal Mail API call it (`10.1.245.2` in `Access:AllowedNetworks`) and pushes the
   Mail Monitor to `https://sila.glcpaints.com:9001/mail/v1/monitor/push`.
2. Its `Monitor:PushKey` must equal the external copy's `Connector:PushKey`.
3. **Publisher (after approval):** add to `appsettings.Exchange.local.json`
   `"Publish": { "Url": "https://sila.glcpaints.com:9001/sync/v1", "Key": "<the external copy's Sync:Key>" }`.

## Step 6 — Fill in usernames

In **System Settings → Mail Monitor → Accounts → Add mailbox**, add each existing mailbox again
(same user, same address): that stores its Sila username, which users need to read their mail.

## Step 7 — Web app, then 7400

Publish the web app (the Mail Monitor now calls the Mail API). Then update 7400 (SilaApi): its old
Mail Monitor endpoints are removed — do this after the Mail API copies are up.

## Updating later

Stop the pool, copy the new files over `D:\API\MailApi` (keep `appsettings.Mail.local.json` and
`App_Data`), start the pool.
