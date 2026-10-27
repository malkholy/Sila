# Mail Project

Sila Mail on the company's on-premises Exchange. The design is
[docs/MailPlan.md](../docs/MailPlan.md); this folder holds its services.

| Folder | API | Status |
|---|---|---|
| [MailConnectorApi](MailConnectorApi) | 1 — Mail Connector API: the only service that talks to Exchange (EWS), 10.1.245.2:9000, answers only on its own server | Deployed 2026-10-25 — [DEPLOY.md](MailConnectorApi/DEPLOY.md) |
| [MailApi](MailApi) | 2 + 3 — Sila Mail API: **one program, two copies, one name** `silamail.glcpaints.com:9001` (split DNS). Internal copy (10.1.245.2, InternalMail) and external copy (sila.glcpaints.com, Mail). Users read their own mailbox; mail admins get the Mail Monitor; the external copy also receives the publisher's batches and the monitor push | Built, not deployed — [DEPLOY.md](MailApi/DEPLOY.md) |

## Databases

| Database | MailPlan name | Where | Script |
|---|---|---|---|
| `Mail` | SilaMailExt (external copy) | Sila server, beside SILA101 | [Database/External/Mail_001_Schema.sql](Database/External/Mail_001_Schema.sql) — deployed 2026-10-25 |
| `InternalMail` | SilaMail (internal master copy) | silamail.glcpaints.com,1433 | [Database/Internal/InternalMail_001_Schema.sql](Database/Internal/InternalMail_001_Schema.sql) — deployed 2026-10-25 |

Run the scripts in SSMS, in number order (`deploy.sh` only reaches SILA101). They are idempotent.
`002_CompressBodies` (both databases) changes `MailMessageBody.BodyHtml` to `BodyHtmlGz`.
`004_Username` (both) adds `MailUser.Username` — the Sila Mail API finds a signed-in user's
mailbox by it. Logins: `InternalMail_005_MailApiLogin.sql` (read-only, the internal Mail API),
`Mail_003_ExternalLogin.sql` (read/write, the external Mail API).

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
7. **Automatic sync** (built 2026-10-26): two lanes — **Initial** (a mailbox's first full copy) and
   **Changes** (already copied: only what changed, seconds) — side by side, each syncing several
   mailboxes at once (`AutoSync:InitialParallel` 2, `AutoSync:ChangesParallel` 4; a mailbox is never
   synced twice at once), so a big first copy never holds up the others' updates. **Safety sync timer**
   (`Sync/SyncScheduler.cs`, `AutoSync:Enabled`): every enabled mailbox at least every
   `MailSettings.SafetySyncMinutes` (3); an unfinished first copy resumes by itself; a failing
   mailbox waits ×2 per failure (at most an hour). A mailbox already queued or running is not queued
   again. Next: EWS streaming notifications (new mail within seconds).
8. Heartbeat for the Monitor (per worker).

### Mail Monitor (System Settings → Mail Monitor)

Served by the **Sila Mail API** (`/mail/v1/admin`), not by 7400 any more (moved 2026-10-26).
Inside the office DNS sends the screen to the internal copy: live figures from InternalMail,
"Sync now" / "Add mailbox" straight to the connector on the same server. Outside, the external
copy serves the snapshot the connector pushes every 15 s (`/mail/v1/monitor/push`) and hands
"Sync now" / "Add mailbox" over with each push. Mail admins only (`MailAdmin:Users`), from
`MailAdmin:AllowedNetworks` or listed in `MailAdmin:AnyNetworkUsers`.

- Web: `src/pages/sila/MailMonitor.jsx` + `src/shared/mailAdmin.js` (`MAIL_BASE`; dev proxy
  `/mail/v1` in vite.config.js).
- **Add mailbox:** pick a Sila user (User Master via `Settings users`) and type the address — Sila
  keeps no email in `UserMaster` / `V_UserMaster_1`. The connector checks it
  (`Sync/MailboxRegistration.cs`: one address in an allowed domain, the user has no other mailbox,
  nobody else has the address or the username, Exchange opens it), saves address + username in
  `MailUser`, and queues the first sync. Adding an existing mailbox again fills in its username.
- The figures' queries are shared: `MailProject/Shared/MonitorQueries.cs` (connector + Mail API).

### Sila Mail API — users (read-only)

`GET /mail/v1/me`, `/folders`, `/folders/{id}/messages?before=&take=` (newest first, keyset
paging), `/messages/{id}` (body decompressed, recipients, attachment list), `/search?q=`
(subject, sender, recipients). Signed in with the Sila login token (checked with 7400's public
key: signature, issuer, audience, type, expiry); the mailbox is the token user's
(`MailUser.Username`), and every query is bound to it.

`GET /mail/v1/attachments/{id}`: the file, only for an attachment of the caller's mailbox.
Inside (Internal role) the Mail API gets it from the connector's
`GET /connector/v1/mailboxes/{userId}/attachments/{id}`, which fetches it from Exchange on
first open (GetAttachment, streamed; an attached message as `.eml`) and keeps it under
`Attachments:Root` (`MailAttachment.StoredPath`). Only pictures and PDF keep their type;
anything else is sent as a plain download. The external copy answers 409 for now.
The Mail screen opens PDFs / pictures in a tab, saves the rest, and fills in a message's
`cid:` pictures.

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
