# Publish the Mail Connector API on 10.1.245.2:9000

Server: `silamail.glcpaints.com` (10.1.245.2) — the same server as the `InternalMail` database (SQL :1433).
Site: IIS, HTTPS on port **9000**, app pool `SilaMailConnector`.

The API calls **out** only: to Exchange (`webmail1.glcpaints.com:443`), to SQL on this server, and to
the external Sila Mail API (`sila.glcpaints.com:9001`) for the Mail Monitor and the copy. Nothing
needs to call **in** from other machines: its endpoints answer only on this server
(`Access:AllowedNetworks` = localhost and this server's own address, for the internal Sila Mail
API), so port 9000 is **not** opened in the firewall.

## Step 1 — Prerequisites on 10.1.245.2 (once)

1. **IIS** with **Application Initialization** (keeps the API started after a server restart):
   ```powershell
   Install-WindowsFeature Web-Server, Web-AppInit
   ```
2. **.NET 10 Hosting Bundle** (ASP.NET Core Runtime 10.0.x — *Hosting Bundle*) from
   https://dotnet.microsoft.com/download/dotnet/10.0, then `iisreset`.
3. A **certificate** for `silamail.glcpaints.com` in *Local Machine → Personal* (the one the :7020 site
   uses is fine). Its thumbprint:
   ```powershell
   Get-ChildItem Cert:\LocalMachine\My | Format-Table Thumbprint, Subject, NotAfter
   ```
4. **Outbound HTTPS** from this server to `webmail1.glcpaints.com:443` and `sila.glcpaints.com:9001`
   (check with `Test-NetConnection sila.glcpaints.com -Port 9001`).

## Step 2 — Copy the files

1. Copy `Sila.MailConnector-IIS.zip` to the server.
2. Extract it to the site folder, e.g. `D:\Sites\SilaMailConnector\`.

The folder holds `Sila.MailConnector.dll`, `web.config`, `appsettings.json`,
`appsettings.Production.json`, `Install-MailConnector.ps1`, this file, and `SQL\` (the InternalMail
scripts, already run).

## Step 3 — Make the Mail Monitor key (once)

One random key, shared with the external Sila Mail API (its Connector:PushKey). In a normal PowerShell window on the server (works in
Windows PowerShell 5.1 and PowerShell 7):

```powershell
$b = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Keep it for step 4 and for the external Sila Mail API (`Connector:PushKey`). Don't email or chat it.

## Step 4 — The secrets file

Create `appsettings.Exchange.local.json` in the site folder (it is never in the zip):

```json
{
  "ConnectionStrings": {
    "InternalMail": "Server=localhost,1433;Database=InternalMail;User ID=sila_mail_connector;Password=<SQL password>;Encrypt=True;TrustServerCertificate=True;Application Name=Sila Mail Connector"
  },
  "Exchange": {
    "Username": "<service account, e.g. svc-sila-mail@glc.local>",
    "Password": "<its password>"
  },
  "Monitor": {
    "PushKey": "<the key from step 3>"
  }
}
```

- If this server is **not** joined to the `glc.local` domain, add `"AuthSchemes": [ "NTLM" ]` under
  `Exchange` (the same as on the test Mac).
- The EWS address, allowed domains and the SilaApi push address are already in
  `appsettings.Production.json`.

## Step 5 — Create the IIS site

In an **elevated** PowerShell, in the site folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-MailConnector.ps1 -CertThumbprint "<thumbprint from step 1>"
```

It creates the pool and the site on https :9000 (always running: no idle stop, no daily recycle,
preloaded), binds the certificate, and lets only Administrators, SYSTEM and the pool read the
secrets file. Safe to run again.

**Or by hand in IIS Manager** (e.g. site and pool `9000-MailConnector`, path `D:\API\Mail`, https 9000,
certificate `*.glcpaints.com`), then:

1. *Application Pools → the pool → Advanced Settings*: **.NET CLR Version** = *No Managed Code*,
   **Start Mode** = *AlwaysRunning*, **Idle Time-out (minutes)** = *0*,
   **Regular Time Interval (minutes)** (under Recycling) = *0*.
2. *Sites → the site → Advanced Settings*: **Preload Enabled** = *True*.
3. Secrets file readable only by Administrators, SYSTEM and the pool (elevated PowerShell):
   ```powershell
   icacls "D:\API\Mail\appsettings.Exchange.local.json" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "IIS AppPool\9000-MailConnector:R"
   ```
4. Recycle the pool.

## Step 6 — Check it

On the server, open **https://localhost:9000/health** (a certificate-name warning for `localhost` is
expected). Expected:

```json
{"success":true,"service":"Sila Mail Connector API","exchangeConfigured":true,"databaseOk":true,...}
```

- `databaseOk: false` → the connection string / SQL password in step 4.
- A 500 page → Event Viewer → Windows Logs → Application (source *IIS AspNetCore Module V2* or
  *Sila.MailConnector*).

## Step 7 — First sync on the server

Tell Claude first, so the test copy on the Mac is stopped (two copies would take turns on the same
mailbox). Then, on the server:

```powershell
curl.exe -k -X POST "https://localhost:9000/connector/v1/mailboxes/4/sync?folder=all"
curl.exe -k "https://localhost:9000/connector/v1/mailboxes/4"
```

The sync continues from where the Mac stopped (the checkpoints are in InternalMail).

## Step 8 — Mail Monitor

The Mail Monitor is served by the **Sila Mail API** (MailProject/MailApi/DEPLOY.md). Inside the
office its internal copy reads InternalMail directly and asks this API (on this server) for
"Sync now" / "Add mailbox" — `10.1.245.2` is in `Access:AllowedNetworks` for that. For users outside,
this API pushes its figures to the external copy (`Monitor:PushUrl` =
`https://sila.glcpaints.com:9001/mail/v1/monitor/push`, `Monitor:PushKey` = the external copy's
`Connector:PushKey`). Until the external copy is up, the Event Log shows *"Mail Monitor push
failed"* about once a minute — harmless.

## Attachments folder (once)

Attachment files are fetched from Exchange the first time someone opens one and
kept in `Attachments:Root` (`D:\MailData\Attachments` in
`appsettings.Production.json`): outside the site folder, so IIS never serves it.
Create it and let only the app pool (and admins) use it:

```powershell
New-Item -ItemType Directory -Force "D:\MailData\Attachments"
icacls "D:\MailData\Attachments" /inheritance:r /grant "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "IIS AppPool\9000-MailConnector:(OI)(CI)M"
```

Limits (optional, in the local json): `MaxBytes` (default 50 MB; larger files
say "Open it in Outlook"), `TimeoutSeconds` (300), `Parallel` (4 Exchange
downloads at once). Nothing is ever deleted from the folder yet.

## Updating later

1. Stop the pool: `Stop-WebAppPool SilaMailConnector`
2. Copy the new files over the site folder — **keep `appsettings.Exchange.local.json`**.
3. Start the pool: `Start-WebAppPool SilaMailConnector`
