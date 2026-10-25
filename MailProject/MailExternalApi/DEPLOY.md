# Publish the Mail External API on sila.glcpaints.com:7700

The external half of the copy (MailPlan "API 3"). It receives publish batches from the Mail
Connector API inside the company and writes them to the `Mail` database on this server.

> **Before step 8:** turning the publisher on puts a copy of company mail on this server, outside
> the company. MailPlan section 4 asks for management / IT security approval first. Steps 1–7 move
> no mail.

Server: `sila.glcpaints.com` (45.63.120.158) — the server of SilaApi :7400 and of the `Mail` database.
Site: IIS, HTTPS port **7700** (change it if 7700 is taken; then use your port everywhere below).

## Step 1 — Firewall (once)

Open inbound TCP **7700** on this server **only from the company's address `41.128.171.146`**. Nobody
else ever needs it. (The API also refuses any other address: `Sync:AllowedNetworks`.)

## Step 2 — SQL (once), in SSMS on this server

1. If not done yet: `Mail_002_CompressBodies.sql` (MailProject/Database/External).
2. `Mail_003_ExternalLogin.sql` — put your own strong password in it first. Creates the login
   `sila_mail_external`: read/write on the `[mail]` tables of `Mail` only.

## Step 3 — Copy the files

Extract `Sila.MailExternal-IIS.zip` to e.g. `D:\API\MailExternal\`.

## Step 4 — The sync key (once)

A **new** random key (not the Mail Monitor key). In PowerShell on either server:

```powershell
$b = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

It goes here (step 5) and on the mail server (step 8).

## Step 5 — The secrets file

Create `D:\API\MailExternal\appsettings.External.local.json` (never in the zip):

```json
{
  "ConnectionStrings": {
    "Mail": "Server=localhost;Database=Mail;User ID=sila_mail_external;Password=<password from step 2>;Encrypt=True;TrustServerCertificate=True;Application Name=Sila Mail External"
  },
  "Sync": { "Key": "<key from step 4>" }
}
```

## Step 6 — The IIS site

In IIS Manager: **Add Website** — name `7700-MailExternal`, new pool `7700-MailExternal`, path
`D:\API\MailExternal`, binding **https**, port **7700**, certificate `*.glcpaints.com`. Then:

1. *Application Pools → 7700-MailExternal → Advanced Settings*: **.NET CLR Version** = *No Managed Code*.
2. Secrets file for the pool only (elevated PowerShell):
   ```powershell
   icacls "D:\API\MailExternal\appsettings.External.local.json" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "IIS AppPool\7700-MailExternal:R"
   ```
3. Recycle the pool.

## Step 7 — Check it

On this server open **https://sila.glcpaints.com:7700/health**. Expected:

```json
{"success":true,"service":"Sila Mail External API","databaseOk":true,"schemaOk":true,"lastAppliedSeq":0,...}
```

- `databaseOk: false` → the connection string / password (step 5).
- `schemaOk: false` → run `Mail_002_CompressBodies.sql` (step 2).

## Step 8 — Turn the publisher on (after approval)

On the **mail server** (10.1.245.2):

1. Update the Mail Connector API with the new `Sila.MailConnector-IIS.zip` (stop pool, copy over
   `D:\API\Mail` keeping `appsettings.Exchange.local.json`, start pool).
2. Add to `D:\API\Mail\appsettings.Exchange.local.json`:
   ```json
   "Publish": {
     "Url": "https://sila.glcpaints.com:7700/sync/v1",
     "Key": "<the same key from step 4>"
   }
   ```
   then run the `icacls` line for that file again and recycle `9000-MailConnector`.

The first copy sends everything already in InternalMail (≈190,000 messages with bodies and
attachment details, a few hundred MB compressed), in batches of up to 500 changes; then only
changes, within seconds. Watch it in **System Settings → Mail Monitor → Overview**: *Waiting to
publish* counts down, *external copy* shows **up** with the last publish time.

## Updating later

Stop the pool, copy the new files over the site folder (keep `appsettings.External.local.json`),
start the pool.
