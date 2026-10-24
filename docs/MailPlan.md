# Sila Mail — on-premises Exchange plan

Sila shows each user's company mailbox. A new **SilaMail API** keeps a copy of
every mailbox in a new database **SilaMail**. Sila reads that copy; it never
reads the Exchange database and never talks to Exchange from 7400 or the
browser. Exchange stays the master copy, and the sync design below keeps the
SilaMail database equal to it.

Mockups: design canvas boards *Mail — Exchange inbox*, *New mail / reply*,
*Mail to ticket*, *Connect to Exchange* (copies in `design/mockups`).

---

## 1. Architecture

```
Exchange Server (on-prem)
      ▲  EWS (SOAP over HTTPS), one service account with impersonation
      │
SilaMail API  (new, e.g. :7600, inside the network, not public)
  ├─ Sync worker: keeps the database equal to Exchange
  ├─ Action endpoints: send / reply / read / flag / move / delete
  ├─ Admin endpoints: health, errors, differences, repair
  └─ owns database SilaMail
      │  internal REST + shared key / client certificate (only 7400 may call it)
      ▼
SilaApi :7400 (checks the user, permissions, live hub, push)
      ▼
Web / mobile
```

- **Protocol: EWS.** Microsoft Graph does not work with on-premises Exchange
  (only with a hybrid setup). EWS is fully supported on Exchange 2016, 2019
  and Subscription Edition.
- **Login: one service account with the ApplicationImpersonation role**,
  limited by a management scope to Sila users. User passwords are never stored.
- **Reads come from SilaMail. Every change goes to Exchange first** (send, mark
  read, flag, move, delete), and only then updates SilaMail. The two can
  therefore never disagree about a user action.

---

## 2. How SilaMail is kept up to date

| Layer | What it does | Catches |
|---|---|---|
| **1. Streaming notifications** | One EWS streaming subscription per mailbox (grouped per connection). Exchange signals a folder change within about a second. | New mail, changes made in Outlook or on the phone |
| **2. SyncFolderItems** | Every notification triggers a sync of that folder from its saved sync state. The sync state, not the notification, is the source of truth, so a lost notification loses nothing. | Adds, edits and deletes, exactly |
| **3. Safety sync** | Every 2–5 minutes, every mailbox syncs anyway, and the folder counts are compared (quick differences check). | Dropped subscriptions, service or Exchange restarts |
| **4. Nightly differences check** | Message IDs + ChangeKeys from Exchange compared with SilaMail; mismatches repaired. | Silent drift, bugs |
| **5. Sync on open** | When a user opens Mail and their last sync is older than N seconds, that mailbox syncs before the answer. | Anything still stale |

**Freshness is stored and shown.** Each mailbox has `LastSyncAt`,
`LastNotificationAt` and `SyncStatus` (OK / Behind / Error). The user sees
"Synced 10 s ago", or a warning when their mailbox is behind.

Details:
- Streaming subscriptions last at most 30 minutes; the worker renews them, and
  every reconnect runs layer 2.
- An Exchange admin creates a **custom throttling policy** for the service
  account; the default EWS limits block a service that syncs many mailboxes.

---

## 3. Database SilaMail

| Table | Contents |
|---|---|
| `MailUser` | Sila UserID ↔ SMTP address, enabled, `LastSyncAt`, `LastNotificationAt`, `SyncStatus`, subscription state, Exchange item / unread counts, last differences check, last error |
| `MailFolder` | Exchange FolderId, parent, name, type (Inbox, Sent…), **SyncState**, counts in Exchange and in DB, last sync |
| `MailMessage` | Exchange ItemId + ChangeKey, ConversationId, subject, from, sent / received dates, read, flag, importance, has attachments, preview text, body (HTML) |
| `MailRecipient` | To / Cc / Bcc rows |
| `MailAttachment` | Name, size, type, Exchange AttachmentId. The file is fetched the first time someone opens it, then cached on the :7500 file server. |
| `MailTicketLink` | Mail ↔ ticket ("create a ticket from this mail") |
| `MailSyncLog` | Every sync run: mailbox, folder, added / changed / deleted, duration, error |
| `MailSyncError` | Grouped errors: type, account, folder, message, count, first / last seen, resolved |
| `MailReconcileRun` / `MailReconcileItem` | Differences check runs and their mismatch rows |
| `MailServiceHeartbeat` | Worker heartbeat, subscriptions connected, syncs per minute, Exchange response time |
| `MailSettings` | Thresholds (Behind time, Error rule), alert rules, check schedule |

- Indexes: (UserID, FolderId, ReceivedAt DESC); full-text search on subject,
  from and body.
- SilaMail holds copies of company mail: encrypt it at rest (TDE), back it up,
  and restrict access like any other sensitive database.

---

## 4. Security (same rules as the rest of Sila)

- **Users only ever see their own mailbox.** 7400 sends the logged-in UserID,
  never a mailbox address from the client; SilaMail filters every query by it.
- The SilaMail API accepts calls only from the 7400 server (IP restriction +
  shared key or client certificate). It has no public endpoint.
- Mail admin screens and actions are checked on the server; showing the menu
  item grants nothing.
- Shared mailboxes come later, as an explicit `MailUser` ↔ mailbox grant table.

---

## 5. 7400 changes

- **User operations** (added to `V1ApiOperationPermission`):
  `Mail folders`, `Mail list`, `Mail read`, `Mail send`, `Mail action`,
  `Mail attachment`, `Mail to ticket`.
- **Admin operations:** `Mail admin overview`, `Mail admin accounts`,
  `Mail admin errors`, `Mail admin differences`, `Mail admin action`
  (sync, resync, reconnect, check, repair, resolve, enable / disable).
- **Live updates:** when the sync finds new mail, SilaMail calls a 7400
  webhook. 7400 sends `mail.new` over LiveHub to the user (inbox updates, toast)
  and a phone push through PushSender.

---

## 6. Mail Sync Monitor (admin screen in System Settings)

Answers three questions: what is failing, which accounts are behind, and where
SilaMail differs from Exchange.

### 6.1 Overview tab
- **Account cards:** Total mailboxes · OK · Behind · Error · Disabled.
- **Service health:** worker's last heartbeat, live subscriptions connected
  (e.g. 212 / 215), syncs per minute, Exchange response time.
- **Oldest sync:** the account longest without a successful sync, with a link.
- **Last differences check:** time, mismatches found and fixed.
- A red banner when the worker has stopped (no heartbeat for 2 minutes).

### 6.2 Accounts tab (one row per mailbox)

| Column | Example |
|---|---|
| User · email address | Mona Hassan · mona@… |
| Status | OK / Behind / Error / Disabled |
| Last successful sync | 40 s ago |
| Subscription | Connected / Reconnecting / Down |
| Items (Exchange / DB) | 18,402 / 18,402 ✓ |
| Unread (Exchange / DB) | 12 / 11 ⚠ |
| Last error | Throttled (ErrorServerBusy) |

- **Filters:** Behind only · Errors only · Differences only · search.
- **Row actions:** Sync now · Check differences · Full resync (in-app confirm
  dialog) · Reconnect subscription · Disable / Enable.
- **Account drawer:** folders (Exchange vs DB counts, last sync), the last 50
  sync runs as a timeline, recent errors.

### 6.3 Errors tab
- Grouped by **type**: Authentication · Permission / impersonation ·
  Throttling · Connection / timeout · Bad item (one message failed) · Database.
- Row: type, account, folder, message, count, first seen, last seen,
  open / resolved.
- Actions: Retry · Mark resolved · Open account.
- Filters: date range, type, account, open / resolved.

### 6.4 Differences tab
- List of check runs: time, accounts checked, mismatches found, fixed, duration.
- Opening a run shows each mismatch: account · folder · kind · subject / date · state.

| Kind | Meaning |
|---|---|
| Missing in DB | In Exchange, not in SilaMail |
| Extra in DB | Deleted in Exchange, still in SilaMail |
| Changed | Same message, different read state, flag or folder (ChangeKey differs) |
| Count mismatch | Folder totals differ |

- Actions: Repair this account · Repair all · Run check now (one account or all).

### 6.5 How the states are measured
- **Behind:** last successful sync older than the threshold (default 10
  minutes, editable), or subscription down for more than 5 minutes.
- **Error:** the last 3 sync attempts failed.
- **Differences check depths:**
  1. *Quick* (every safety cycle): folder total and unread counts, Exchange vs DB.
  2. *Full* (nightly and on demand): IDs + ChangeKeys per folder, no bodies
     downloaded; finds every Missing / Extra / Changed message.
  3. *Repair:* re-sync only the mismatched items; more than 5% mismatched
     means a full resync of that account.

### 6.6 Alerts
A push and a Sila message go to the mail admins when:
- the worker stops;
- an account has been in Error for more than 15 minutes;
- more than 5% of accounts are Behind;
- the nightly check finds mismatches it could not repair.

---

## 7. Phases

1. **Proof of concept (about 1 week).** Service account, impersonation,
   throttling policy, sync of one test mailbox. Measure speed and time to
   first sync.
2. **Read-only Mail.** SilaMail database, sync worker (layers 1–5), 7400 read
   operations, the web Inbox from the mockup, the freshness indicator, and the
   Monitor's **Overview, Accounts and Errors** tabs with the quick count check —
   so it is visible from day one that the copy is up to date.
3. **Actions + Differences.** Read / flag / move / delete, then send / reply /
   forward with attachments, all through Exchange. The full differences check,
   repair, the **Differences** tab and alerts.
4. **Sila integration.** Mail → ticket, mail files attached to tickets, new
   mail on Home, push notifications.
5. **Hardening.** Retention rules, performance tuning, mobile app.

---

## 8. Open questions (before Phase 1)

1. **Exchange version:** 2016, 2019 or Subscription Edition? Is EWS enabled,
   and what is its internal URL?
2. **Mailboxes:** how many to start with, and how large are the biggest?
3. **History depth:** first sync of the whole mailbox, or the last 6–12 months?
   Decides database size and first-sync time.
4. **Attachments:** fetch on first open (recommended) or copy all up front?
5. **Approval:** can IT create the impersonation service account and the
   throttling policy? Keeping a copy of everyone's mail outside Exchange should
   be signed off by management / IT security.
