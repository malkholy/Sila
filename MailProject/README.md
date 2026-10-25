# Mail Project

Sila Mail on the company's on-premises Exchange. The design is
[docs/MailPlan.md](../docs/MailPlan.md); this folder holds its services.

| Folder | API | Status |
|---|---|---|
| [MailConnectorApi](MailConnectorApi) | 1 — Mail Connector API: the only service that talks to Exchange (EWS), internal network only, :7600 | Step 3 |
| — | 2 — Sila Mail API, Internal | Not started |
| [MailExternalApi](MailExternalApi) | 3 — Sila Mail API, External: sync endpoints (receives publish batches into the `Mail` database), sila.glcpaints.com :7700 | Built, not deployed — [DEPLOY.md](MailExternalApi/DEPLOY.md) |

## Databases

| Database | MailPlan name | Where | Script |
|---|---|---|---|
| `Mail` | SilaMailExt (external copy) | Sila server, beside SILA101 | [Database/External/Mail_001_Schema.sql](Database/External/Mail_001_Schema.sql) — deployed 2026-10-25 |
| `InternalMail` | SilaMail (internal master copy) | silamail.glcpaints.com,7020 | [Database/Internal/InternalMail_001_Schema.sql](Database/Internal/InternalMail_001_Schema.sql) — deployed 2026-10-25 |

Run the scripts in SSMS, in number order (`deploy.sh` only reaches SILA101). They are idempotent.
`002_CompressBodies` (both databases) changes `MailMessageBody.BodyHtml` to `BodyHtmlGz`.

## Mail Connector API — steps

1. **Skeleton + Exchange check** (done): config, network restriction, `/health`,
   `/connector/v1/exchange/check` (service account sign-in, impersonation, one folder).
2. **Databases** (done): `InternalMail` and the external `Mail` (see above).
3. **First sync of one folder** (done 2026-10-25): register a mailbox, sync the folder tree
   (`SyncFolderHierarchy`) and one folder's items (`SyncFolderItems` page by page, list fields via
   `GetItem`), each page committed with its SyncState and its `MailChange` rows. First test:
   m.elkholy Inbox, 18,244 / 18,244 messages, unread 12,781 / 12,781, 92 pages in 4 m 45 s;
   the next run: 1 page, no changes, under a second.
4. **Message bodies and attachment details** (done 2026-10-25): a body pass after each folder
   sync fetches every message without a body (newest first, 20 per call), sanitizes the HTML
   (`Sync/BodySanitizer.cs`, HtmlSanitizer, after Exchange's own filter) and stores it with the
   plain text and the attachment list (no file content yet). First test: 18,244 / 18,244 bodies,
   38,816 attachments (35,998 inline images, 2,818 files), no bad items, 13.5 minutes.
   Bodies took 1.6 GB for one Inbox (HTML 1.2 GB, text 0.45 GB), so **(decided 2026-10-25)**
   the HTML is stored compressed — `BodyHtmlGz`, gzip of the UTF-16 text (the bytes of
   `COMPRESS(nvarchar)`; read with `CAST(DECOMPRESS(BodyHtmlGz) AS NVARCHAR(MAX))`) — and the
   search text `BodyText` is capped at 64K characters. Scripts `*_002_CompressBodies.sql`.
5. **All mail folders, with moves matched** (script `InternalMail_003_MessageMoves.sql`): `folder=all`
   (now the default) syncs every mail folder, Inbox and Sent Items first; one folder failing is
   logged and skipped. A delete only marks the row (`DeletedAt`, external copy told at once); at
   the end of each run a marked row whose message is live again elsewhere (same
   InternetMessageId + ReceivedAt, newer row) takes over that row's Exchange ID, folder, body and
   attachments, so the Sila MessageID survives a move; unclaimed marked rows go after
   `MoveGraceMinutes` (30). Copies are never merged. Logged as `Moves` runs (Matched / Deleted).
   **Done 2026-10-25**, first full mailbox on the server (10.1.245.2:9000): 124 folders,
   186,883 messages, 186,883 bodies, ~186,000 attachment records. Move test: a message moved
   Inbox → A GLC kept MessageID 18245 (the new row 35020 merged into it, outbox `D 35020`, `U 18245`).
   Deleted Items / Drafts show fewer copied than Exchange's total: Exchange counts every item, the
   sync copies mail only (calendar, contact, task items are skipped) — to show separately.
6. **Publisher** (built 2026-10-25, off until `Publish:Url` is set): `Publish/Publisher.cs` reads
   `MailChange` in order from `MailPublishState.LastPublishedSeq`, sends the rows' current state
   (last change per row wins; gone rows and marked messages as deletes) gzip-compressed to the Mail
   External API `/sync/v1/apply` with `Publish:Key`, and moves the pointer only after it confirms.
   The receiver applies a batch in one transaction, deletes before upserts, never overwrites a newer
   row (`PublishSeq`), and refuses a batch that would skip changes (409 → the pointer follows it).
   The batch format is shared: `MailProject/Shared/PublishContract.cs`.
7. Exchange Sync worker: safety sync every few minutes, then streaming notifications.
8. Heartbeat for the Monitor (per worker).

### Mail Monitor (System Settings → Mail Monitor)

SilaApi (7400) is hosted **outside** the company (sila.glcpaints.com = 45.63.120.158) and the company
opens **no inbound port**, so the Mail Connector API pushes out:

```
 inside the company                                   │  internet  │   SilaApi :7400 (outside)
 Mail Connector API ──every 15 s: POST /api/v2/mail/monitor/push ─────▶  keeps the last snapshot (memory)
   (InternalMail)       X-Connector-Key, snapshot =   │            │     answer: wantDetails [userIds],
                        overview, accounts, errors,   │            │             syncs [{userId, requestedBy}]
                        details of wanted mailboxes   │            │
                                                                        ▲  POST /api/v2/mail/admin {action}
                                                                        │  mail admin (MailAdmin:Users),
                                                          web app  ─────┘  from MailAdmin:AllowedNetworks
```

- Web: `src/pages/sila/MailMonitor.jsx` (Overview, Accounts + mailbox drawer, Errors; shows how old the
  figures are, warns after a minute without a push), data `src/shared/mailAdmin.js`.
- SilaApi: `Plus.Api/MailAdmin/MailAdminEndpoints.cs`. `overview` / `accounts` / `errors` come from the last
  snapshot; `account` asks the connector for that mailbox and waits up to 25 s for it; `sync` is handed
  to the connector with its next push (within ~15 s). The snapshot lives in memory: after a restart the
  screen is empty until the next push.
- Mail Connector API: `Monitor/MonitorPusher.cs` (off while `Monitor:PushUrl` is empty).

**Company network only:** SilaApi refuses the Mail Monitor (403) to anyone whose address is not in
`MailAdmin:AllowedNetworks`, even with a valid login; empty = nobody; the refusal shows the address
SilaApi saw. (Sila has no office list in SQL — `PLS.APIPlusAttachmentOperation` answers
`GetOfficeNetworks` with none.) Set to `10.1.0.0/16` and the office's public address
`41.128.171.146/32` (what 7400 sees for office users, 2026-10-25). Because 7400 is outside, office users
normally reach it from the company's **public** address — if the screen refuses with a public address,
add that address.

Configuration (secrets on the servers only, never in git):

| Where | Setting |
|---|---|
| Mail Connector API | `Monitor:PushUrl` = `https://sila.glcpaints.com:7400/api/v2/mail/monitor/push`, `Monitor:PushKey` = a long random key (≥ 32 characters) |
| SilaApi (7400) | `MailAdmin:ConnectorKey` = the same key (e.g. environment variable `MailAdmin__ConnectorKey`), `MailAdmin:Users` = `["mhd"]`, `MailAdmin:AllowedNetworks` = `["10.1.0.0/16"]` (+ the office's public address if needed), optional `MailAdmin:ConnectorNetworks` = the company's public address (only it may push) |

Network (2026-10-25): Exchange `webmail1.glcpaints.com` (10.1.253.3 given; resolves to 10.1.225.3 from
the office), Internal Mail server `silamail.glcpaints.com` 10.1.245.2 (IIS :7020 for the Mail Connector
API, SQL :1433).

Message dates (`SentAt`, `ReceivedAt`) are stored in **UTC**; the service's own timestamps
(`SyncedAt`, logs) are server local time.

### Endpoints so far

| Call | Does |
|---|---|
| `GET /health` | Up, Exchange configured, InternalMail reachable |
| `GET /connector/v1/exchange/check?mailbox=` | Service account + impersonation test on one mailbox |
| `POST /connector/v1/mailboxes` `{userId, smtpAddress, displayName}` | Register a Sila user's mailbox (checked in Exchange first) |
| `POST /connector/v1/mailboxes/{userId}/sync?folder=inbox` | Queue a sync (folder tree + one folder) |
| `GET /connector/v1/mailboxes/{userId}` | Account, folders (Exchange vs DB counts), last 10 sync runs |

## Running it

```
cd MailConnectorApi
dotnet test Sila.MailConnector.slnx
dotnet run --project Sila.MailConnector        # http://localhost:7600
```

Exchange settings go in `Sila.MailConnector/appsettings.Exchange.local.json`
(copy `appsettings.Exchange.local.example.json`; git-ignored, never published).
Then:

```
curl "http://localhost:7600/connector/v1/exchange/check?mailbox=someone@glcpaints.com"
```

returns the mailbox's Inbox total / unread counts, or what failed: `Authentication`
(service account password), `Permission` (impersonation role or its scope),
`Throttling`, `Connection`, `NotFound` (no such mailbox).
