---
name: sila-db
description: Read the Sila live SQL Server database (`SILA101`, the ticket/chat DB behind the :9101 gateway) through [CHA].[APISilaOperationV1] — list objects, read SP/view source, columns, parameters, preview rows, or run a read-only query. Use whenever the task needs to "check the DB", "look at the SP", "what's in table X", or discover ticket operations. Every run needs explicit user approval. Read-only; changes are deployed by the user in SSMS.
---

# Sila live DB (read-only)

All reads go through `db.sh`, which calls `[CHA].[APISilaOperationV1]`
(source: `SQLScript/APISilaOperationV1.sql`) on
`https://sila.silasystem.com:9101/General/GeneralAPI` with the same body shape
as `[CHA].[APITicketOperation]`.

## MANDATORY approval rule

**Never run anything against the live DB without the user's explicit approval
in chat, every single time.** Show the exact command (and SQL), say it is a
read, ask for a yes, then run. Re-ask if it changes.

## Commands

```bash
.claude/skills/sila-db/db.sh ping
.claude/skills/sila-db/db.sh objects CHA P              # schema, type, name-search (all optional)
.claude/skills/sila-db/db.sh def '[CHA].[APITicketOperation]'
.claude/skills/sila-db/db.sh cols '[CHA].[Ticket]'
.claude/skills/sila-db/db.sh params '[CHA].[APITicketOperation]'
.claude/skills/sila-db/db.sh preview '[CHA].[Ticket]' 20
.claude/skills/sila-db/db.sh query 'SELECT TOP 10 * FROM [CHA].[Ticket] ORDER BY 1 DESC'
```

`--raw` first skips pretty-printing. `def` prints the source as plain text.

## Key and overrides

The API key comes from `$SILA_DB_KEY` or `~/.config/sila/db.key` — never
commit it. Keys are minted with `SQLScript/SilaApiKeyNew.sql` and revoked with
`UPDATE [dbo].[SilaApiKey] SET IsActive = 0 WHERE KeyID = …`.
Overrides: `SILA_DB_ENDPOINT`, `SILA_DB_SP`, `SILA_DB_USER`.

## What the server enforces

- Every call needs a valid `LineData.ApiKey` (the gateway's `User` is not
  trusted — the browser sets it).
- `RunQuery` / `PreviewRows` run inside `[CHA].[APISilaReaderExec]`
  (`WITH EXECUTE AS 'SilaReader'`: db_datareader + VIEW DEFINITION): no writes,
  no other databases. It re-checks the key, since the gateway lets clients name
  any SP. After any change to it, re-verify live that
  `query "REVERT; SELECT USER_NAME()"` still returns `SilaReader`.
- Errors come back as one `{State, Message}` row; `db.sh` exits non-zero.
- Schema changes are never made from here — write the script, the user
  deploys it in SSMS, then verify with a read.
