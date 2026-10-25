# Sila Mail — on-premises Exchange plan

Sila shows each user's company mailbox. Exchange stays the master copy. Three
new APIs keep a copy of every mailbox in two Sila mail databases and serve it
to Sila users. No user, browser or phone ever talks to Exchange or reads the
Exchange database.

| # | API | Where it runs | Talks to | Used by |
|---|---|---|---|---|
| 1 | **Mail Connector API** | Internal network only | Exchange (EWS) + both mail databases | Nobody but the other Sila servers |
| 2 | **Sila Mail API — Internal** | Internal network | **SilaMail** (internal database) | Sila users inside the company |
| 3 | **Sila Mail API — External** | **External site** (hosted outside the company, another location) | **SilaMailExt** (external database, on the same external site) | Sila users outside the company |

**DNS switches users between API 2 and API 3.** Web and mobile always call one
name (for example `mail.sila.glcpaints.com`). The internal DNS answers with
API 2, the public DNS answers with API 3 (split DNS). The two APIs have the same
endpoints, the same answers and the same login, so the app never knows which
one it reached. The same switch is the fallback: if one of them is down, its
DNS record can point at the other.

**Known so far:** Exchange Server **2019**, **550 mailboxes**, largest mailbox
**120 GB**. Sizing and what follows from these numbers: section 1.1.

Mockups: design canvas boards *Mail — Exchange inbox*, *New mail / reply*,
*Mail to ticket*, *Connect to Exchange* (copies in `design/mockups`).

---

## 1. Architecture

```
                         Exchange Server (on-prem)
                               ▲  EWS, service account with impersonation
                               │
  ┌──────────── company network (on-prem) ─────────────────────────────┐
  │                                                                    │
  │   (1) Mail Connector API  (:7600, not reachable by users)          │
  │     ├─ Exchange Sync worker: keeps SilaMail equal to Exchange      │
  │     ├─ Send worker: the ONLY part that sends mail (one at a time)  │
  │     ├─ Action worker: read / flag / move / delete on Exchange      │
  │     ├─ Publisher worker: sends every change to the external site   │
  │     ├─ Reconciliation worker: finds and repairs differences        │
  │     └─ Admin endpoints: health, errors, differences, repair        │
  │          │ writes                         │ HTTPS, opened from     │
  │          ▼                                │ inside only (mutual    │
  │      SilaMail (internal DB)               │ TLS or site-to-site    │
  │          ▲ reads, queues actions          │ VPN)                   │
  │   (2) Sila Mail API — Internal            │                        │
  │          ▲                                │                        │
  │   internal users ─ DNS mail.sila…         │                        │
  └───────────────────────────────────────────┼────────────────────────┘
                                   internet   │
                                              ▼
  ┌──────────── external site (other location / hosting) ─────────────┐
  │   (3) Sila Mail API — External                                    │
  │     ├─ User endpoints (same as API 2)                             │
  │     └─ Sync endpoints, only for API 1: apply changes,             │
  │        hand over queued actions, store attachments                │
  │          │                                                        │
  │      SilaMailExt (external DB) + attachment storage               │
  │          ▲                                                        │
  │   external users ─ DNS mail.sila… (public)                        │
  └───────────────────────────────────────────────────────────────────┘
```

- **Protocol: EWS.** Microsoft Graph does not work with on-premises Exchange
  (only with a hybrid setup). EWS is fully supported on Exchange 2016, 2019
  and Subscription Edition.
- **Login to Exchange: one service account with the ApplicationImpersonation
  role**, limited by a management scope to Sila users. Only API 1 holds it.
  User passwords are never stored.
- **Only API 1 talks to Exchange.** APIs 2 and 3 only read their own database
  and queue actions in it.
- **API 1 is one service with five independent workers** (Exchange Sync,
  Send, Action, Publisher, Reconciliation). One worker failing does not stop
  the others; see 7.3.
- **Only the Send worker sends mail.** Send, reply and forward from every user,
  inside or outside, end up in one queue worked by one sender. No other API,
  worker or code path can send (7.1).
- **The external site never connects into the company.** API 1 opens every
  connection: it pushes changes to API 3's sync endpoints and pulls the
  actions external users queued. No port is opened inward on the company
  firewall. If the external site is broken into, the attacker cannot reach
  Exchange, the internal database or API 1.
- **API 1 talks to API 3 over HTTPS, not to SilaMailExt directly.** A database
  connection over the internet is slow and risky; API 3 writes its own
  database. The link is protected by mutual TLS (client certificate) plus an
  allow-list of the company's public IP, or by a site-to-site VPN.
- **If the internet link drops,** internal users carry on normally. External
  users still read their mail (up to the last publish) and see a "behind"
  warning; their actions wait in the queue. When the link returns, API 1 sends
  everything it missed, in order.
- **Every change goes to Exchange first.** Send, mark read, flag, move, delete:
  API 2 or 3 queues the action, API 1 runs it on Exchange, then updates
  SilaMail, then SilaMailExt. The databases never disagree with Exchange about
  a user action.

### 1.1 Our Exchange: version and size

**Exchange Server 2019.**
- EWS, streaming notifications, `SyncFolderItems` and ApplicationImpersonation
  all work on Exchange 2019 on-premises. Nothing in this plan changes.
- **Exchange 2019 went out of Microsoft support on 14 Oct 2025**: no more
  security updates. Sila Mail will be one more system reaching it, so IT
  should plan the in-place upgrade to **Exchange Server Subscription Edition**
  (from 2019 CU14 / CU15). The plan works the same on SE; the EWS URL stays.
- Needed CU: at least CU14 (check with IT; question 9.1).

**550 mailboxes.**
- Streaming subscriptions: about 3 connection groups of up to 200 mailboxes
  each, one EWS connection per group.
- The service account's **throttling policy must be raised**: the default
  (for example `EWSMaxSubscriptions` = 20, concurrency limits) blocks 550
  mailboxes. IT sets a custom policy with these limits raised or unlimited.
- Safety sync (layer 3) every 5 minutes = about 2 mailbox syncs per second —
  light for Exchange.
- **Full differences check (layer 4) runs as a rolling check**: each night a
  share of the mailboxes (for example 1/7), so every mailbox is fully checked
  once a week. The quick count check still covers all 550 every cycle.

**Largest mailbox 120 GB.**
- Most of that size is usually attachments. SilaMail stores **message text and
  attachment details only**; the files are fetched when someone opens them
  (question 9.4). The database copy of a 120 GB mailbox is therefore far
  smaller (rough estimate 10–30 GB of text), but it still holds hundreds of
  thousands of items.
- **First sync speed:** EWS gives roughly 20–50 items a second per mailbox, so
  a mailbox with 500 000 items takes about 3–7 hours on its own. Large
  mailboxes sync newest first (Inbox and Sent first, last months first), so the
  user can work while older mail is still coming in.
- **Initial load plan:** sync the last 12 months for everyone first, then older
  mail in the background, a few mailboxes at a time, outside working hours.
  (Final choice: question 9.3.)
- **External copy:** loaded from a SilaMail backup (2.2), never over the
  internet item by item. Limiting it to recent months (question 9.6) keeps it
  small.
- **Database sizing:** to be measured in the proof of concept on the largest
  mailbox and two average ones, then multiplied out. IT should give the total
  size of the Exchange databases and the average mailbox size.

### Who talks to whom

| From → To | Allowed | How |
|---|---|---|
| API 1 → Exchange | Yes | EWS over HTTPS |
| API 1 → SilaMail | Yes | SQL, read / write |
| API 1 → API 3 (sync endpoints) | Yes | HTTPS over the internet, mutual TLS / VPN, opened from inside |
| API 1 → 7400 | Yes | Webhook for new mail (live update + push) |
| API 2 → SilaMail | Yes | SQL, read + action queue |
| API 3 → SilaMailExt | Yes | SQL on the external site, read / write |
| External site → company network | **No** | No inbound port opened |
| Users → API 1 | **No** | Not published |

---

## 2. How the copies are kept up to date

### 2.1 Exchange → SilaMail (API 1)

| Layer | What it does | Catches |
|---|---|---|
| **1. Streaming notifications** | One EWS streaming subscription per mailbox (grouped per connection). Exchange signals a folder change within about a second. | New mail, changes made in Outlook or on the phone |
| **2. SyncFolderItems** | Every notification triggers a sync of that folder from its saved sync state. The sync state, not the notification, is the source of truth, so a lost notification loses nothing. | Adds, edits and deletes, exactly |
| **3. Safety sync** | Every 2–5 minutes, every mailbox syncs anyway, and the folder counts are compared (quick differences check). | Dropped subscriptions, service or Exchange restarts |
| **4. Nightly differences check** | Message IDs + ChangeKeys from Exchange compared with SilaMail; mismatches repaired. Rolling: a share of the mailboxes each night, every mailbox once a week (1.1). | Silent drift, bugs |
| **5. Sync on open** | When a user opens Mail and their last sync is older than N seconds, API 2 or 3 asks API 1 for a sync of that mailbox (through the request queue for API 3) and shows the answer when it arrives. | Anything still stale |

- Streaming subscriptions last at most 30 minutes; API 1 renews them, and every
  reconnect runs layer 2.
- An Exchange admin creates a **custom throttling policy** for the service
  account; the default EWS limits block a service that syncs many mailboxes.

### 2.2 SilaMail → SilaMailExt (API 1, publisher)

- Every change API 1 writes to SilaMail also goes into a **change log**
  (`MailChange`: sequence number, table, row key, operation) **in the same SQL
  transaction** (transactional outbox, 7.2).
- The publisher reads the change log in order and sends it to API 3's sync
  endpoint in batches (compressed); API 3 applies each batch to SilaMailExt in
  one transaction and answers with the last sequence number it applied.
  Normally within 1–3 seconds, depending on the internet link. It saves the last sequence number it
  applied (`MailPublishState`), so after an outage it carries on where it
  stopped; nothing is lost.
- **Nightly internal ↔ external check:** per mailbox and folder, counts and
  a checksum of IDs + ChangeKeys in SilaMail vs SilaMailExt; any difference is
  re-published.
- **Lag** = newest change in SilaMail minus the last change applied to
  SilaMailExt. Shown in the Monitor.
- **First load:** copying every mailbox over the internet can take long. For the
  first load (and any rebuild) a backup of SilaMail can be restored on the
  external site, and the publisher then continues from that backup's sequence
  number.
- Alternative: SQL Server transactional replication over a site-to-site VPN.
  Less code, but it needs a database connection across sites and is harder to
  filter and monitor. Decide in the proof of concept.

### 2.3 Actions (send, read, flag, move, delete)

- API 2 or 3 writes the action into `MailAction` in its own database
  (UserID, mailbox, item, action, data, state = Waiting) and answers the app at
  once ("Sending…").
- API 1 picks up actions from SilaMail (pushed at once by API 2) and from
  API 3 (API 1 asks every 1–2 seconds; nothing calls inward). **Send, reply
  and forward go to the Send worker**; read, flag, move and delete go to the
  Action worker. Each runs them on Exchange and marks them Done or Failed with
  the error. The app shows the result over
  the live hub.
- Each action has an ID made by the app, and goes through the state machine in
  7.1, so a crash or retry never sends a mail twice.
- Actions from API 3 are untrusted until API 1 has checked them (7.4).

### 2.4 Freshness shown to the user

Each mailbox has `LastSyncAt`, `LastNotificationAt` and `SyncStatus`
(OK / Behind / Error). SilaMailExt also stores when each row was last
published. The user sees "Synced 10 s ago" (for external users: the older of
the Exchange sync and the publish time), or a warning when their mailbox is
behind.

---

## 3. Databases

**SilaMail** (internal, master copy for Sila) and **SilaMailExt** (external site) have
the same mail tables, so APIs 2 and 3 share one code base and one set of
queries.

| Table | In | Contents |
|---|---|---|
| `MailUser` | both | Sila UserID ↔ SMTP address, enabled, `LastSyncAt`, `LastNotificationAt`, `SyncStatus`, Exchange item / unread counts |
| `MailFolder` | both | Exchange FolderId, parent, name, type (Inbox, Sent…), counts, last sync. **SyncState (checkpoint) only in SilaMail.** |
| `MailMessage` | both | **Stable Sila MessageID** (never changes, used by tickets and links), Exchange ItemId + ChangeKey, InternetMessageId, ConversationId, subject, from, sent / received dates, read, flag, importance, has attachments, preview text, body (HTML) |
| `MailRecipient` | both | To / Cc / Bcc rows |
| `MailAttachment` | both | Name, size, type, Exchange AttachmentId. The file is fetched the first time someone opens it (through API 1), then cached on the internal file server. For an external user, API 3 queues the request, API 1 fetches the file and uploads it to the external site's storage. |
| `MailTicketLink` | both | Sila MessageID ↔ ticket ("create a ticket from this mail"); never the Exchange ItemId |
| `MailAction` | both | Queued user actions: ActionID, state (7.1), result |
| `MailActionAttempt` | SilaMail | Every try of an action: worker, start / end, Exchange answer, error |
| `MailJobLease` | SilaMail | Which worker instance owns which job (mailbox, batch, the single `Send` lease) until when |
| `MailSecurityLog` | SilaMail | Security-sensitive events: refused external actions, token checks, admin repairs |
| `MailChange` | SilaMail | Change log the publisher sends to SilaMailExt |
| `MailPublishState` | SilaMail | Last change applied to SilaMailExt, lag, last error |
| `MailSyncLog` | SilaMail | Every sync run: mailbox, folder, added / changed / deleted, duration, error |
| `MailSyncError` | SilaMail | Grouped errors: type, account, folder, message, count, first / last seen, resolved |
| `MailReconcileRun` / `MailReconcileItem` | SilaMail | Differences check runs (Exchange ↔ SilaMail and SilaMail ↔ SilaMailExt) and their mismatch rows |
| `MailServiceHeartbeat` | SilaMail | Heartbeat of each API and worker, subscriptions connected, syncs per minute, Exchange response time, publish lag |
| `MailSettings` | SilaMail | Thresholds (Behind time, Error rule, lag limit), alert rules, check schedule |

- Indexes: (UserID, FolderId, ReceivedAt DESC); full-text search on subject,
  from and body, in both databases.
- Both databases hold copies of company mail: encrypt them at rest (TDE), back
  them up, and restrict access like any other sensitive database. SilaMailExt
  is outside the company, so it needs the strictest rules (see 4).

---

## 4. Security (same rules as the rest of Sila)

- **Users only ever see their own mailbox.** APIs 2 and 3 take the UserID from
  the validated Sila login token, never a mailbox address from the client, and
  filter every query by it.
- **Same login as 7400.** APIs 2 and 3 accept the Sila login token and check it
  the same way 7400 does. They check the mail operation permissions on the
  server; API 3 reads them from a copy that API 1 publishes to SilaMailExt, so
  it never calls inward. That copy is only trusted for reading: API 1 checks
  every external action again against the internal data (7.4).
- **API 1** has no public endpoint and accepts calls only from the Sila servers
  (IP restriction + client certificate).
- **API 3 / SilaMailExt (external site):** HTTPS only, rate limits, login
  lock-out. Its sync endpoints accept only API 1's client certificate from the
  company's public IP. It holds no Exchange credentials and cannot reach
  Exchange or anything inside the company.
- Company mail stored outside the company's premises needs approval from
  management / IT security, and a hosting contract that covers encryption,
  backups and who can access the server.
- Mail admin screens and actions are checked on the server; showing the menu
  item grants nothing.
- Shared mailboxes come later, as an explicit `MailUser` ↔ mailbox grant table.

---

## 5. Sila changes

- **App:** Mail calls `mail.sila…` (one base URL for web and mobile). DNS picks
  API 2 or 3.
- **7400 operations** (added to `V1ApiOperationPermission`), checked by APIs 2
  and 3: `Mail folders`, `Mail list`, `Mail read`, `Mail send`, `Mail action`,
  `Mail attachment`, `Mail to ticket`.
- **Admin operations:** `Mail admin overview`, `Mail admin accounts`,
  `Mail admin errors`, `Mail admin differences`, `Mail admin action`
  (sync, resync, reconnect, check, repair, re-publish, resolve,
  enable / disable).
- **Live updates:** when API 1 finds new mail or finishes an action, it calls a
  7400 webhook. 7400 sends `mail.new` / `mail.action` over LiveHub to the user
  (inbox updates, toast) and a phone push through PushSender. For an external
  user, 7400 waits until the change has been published to SilaMailExt (or sends
  the sequence number so the app reloads once it is there).

---

## 6. Mail Sync Monitor (admin screen in System Settings)

Answers four questions: what is failing, which accounts are behind, where
SilaMail differs from Exchange, and whether SilaMailExt is keeping up with
SilaMail.

### 6.1 Overview tab
- **Account cards:** Total mailboxes · OK · Behind · Error · Disabled.
- **Service health, one card per API:** API 1 (last heartbeat, subscriptions
  connected e.g. 212 / 215, syncs per minute, Exchange response time),
  API 2 and API 3 (up / down, requests per minute, errors).
- **External site:** link up / down, response time from API 1, publish lag
  (e.g. 1.4 s), changes waiting, last publish error, last internal ↔ external
  check.
- **Workers:** one card each for Exchange Sync, Send, Action, Publisher and
  Reconciliation (heartbeat, instance, jobs leased, last error). The Send card
  also shows the active instance, mails waiting, sent in the last hour and
  unknown sends.
- **Action queue:** waiting / failed / **unknown** actions, oldest waiting
  action. Unknown sends are listed for an admin to check.
- **Oldest sync:** the account longest without a successful sync, with a link.
- **Last differences check:** time, mismatches found and fixed.
- A red banner when any API has stopped (no heartbeat for 2 minutes) or the
  publish lag is over its limit.

### 6.2 Accounts tab (one row per mailbox)

| Column | Example |
|---|---|
| User · email address | Mona Hassan · mona@… |
| Status | OK / Behind / Error / Disabled |
| Last successful sync | 40 s ago |
| Subscription | Connected / Reconnecting / Down |
| Items (Exchange / Internal / External) | 18,402 / 18,402 / 18,402 ✓ |
| Unread (Exchange / Internal / External) | 12 / 11 / 11 ⚠ |
| Published to external | 2 s ago |
| Last error | Throttled (ErrorServerBusy) |

- **Filters:** Behind only · Errors only · Differences only · search.
- **Row actions:** Sync now · Check differences · Full resync (in-app confirm
  dialog) · Re-publish to external · Reconnect subscription · Disable / Enable.
- **Account drawer:** folders (Exchange vs DB counts, last sync), the last 50
  sync runs as a timeline, recent errors.

### 6.3 Errors tab
- Grouped by **type**: Authentication · Permission / impersonation ·
  Throttling · Connection / timeout · Bad item (one message failed) · Database ·
  Publish (external copy) · Action failed · Action unknown · Sync state
  rebuilt · Refused external action (security).
- Row: type, account, folder, message, count, first seen, last seen,
  open / resolved.
- Actions: Retry · Mark resolved · Open account.
- Filters: date range, type, account, open / resolved.

### 6.4 Differences tab
- Two checks, chosen at the top: **Exchange ↔ Internal** and
  **Internal ↔ External**.
- List of check runs: time, accounts checked, mismatches found, fixed, duration.
- Opening a run shows each mismatch: account · folder · kind · subject / date · state.

| Kind | Meaning |
|---|---|
| Missing in DB | In Exchange (or SilaMail), not in SilaMail (or SilaMailExt) |
| Extra in DB | Deleted at the source, still in the copy |
| Changed | Same message, different read state, flag or folder (ChangeKey differs) |
| Count mismatch | Folder totals differ |

- Actions: Repair this account · Repair all · Run check now (one account or all).

### 6.5 How the states are measured
- **Behind:** last successful sync older than the threshold (default 10
  minutes, editable), or subscription down for more than 5 minutes.
- **Error:** the last 3 sync attempts failed.
- **External behind:** the account's newest change in SilaMail is not in
  SilaMailExt after the lag limit (default 1 minute).
- **Differences check depths:**
  1. *Quick* (every safety cycle): folder total and unread counts, Exchange vs DB.
  2. *Full* (nightly, rolling — every mailbox once a week — and on demand):
     IDs + ChangeKeys per folder, no bodies downloaded; finds every
     Missing / Extra / Changed message.
  3. *Repair:* re-sync only the mismatched items; more than 5% mismatched
     means a full resync of that account.

### 6.6 Alerts
A push and a Sila message go to the mail admins when:
- any of the three APIs stops;
- the link to the external site is down, or the publish lag is over 5 minutes;
- no Send worker holds the send lease for more than 1 minute, or a send is
  `Unknown`;
- actions have been waiting for more than 2 minutes;
- an account has been in Error for more than 15 minutes;
- more than 5% of accounts are Behind;
- the nightly check finds mismatches it could not repair.

---

## 7. Reliability and safety rules

These five rules keep the three-API design above; they make it safe for
production. Each one must be in place before the feature it protects is
switched on (see 7.6).

### 7.1 Never send a mail twice (P0)

An ActionID alone is not enough: if Exchange sends the mail and API 1 crashes
before it saves the result, a plain retry sends it again.

**One sender.** The Send worker inside API 1 is the only part of Sila that
sends mail:

- Send, reply and forward from API 2 and API 3 all land in one queue
  (`MailAction`, send types) that only the Send worker reads.
- **Exactly one Send worker is active at a time**, across all API 1 instances.
  It holds a single lease (`MailJobLease`, job = `Send`) and renews it every
  few seconds. A standby takes over only after the lease has expired.
- **Before sending anything new, a Send worker that has just started (or taken
  over) first settles every send left in `Processing`, `Submitted` or
  `Unknown`** by checking Sent Items for its ActionID (below). Only then does it
  take new work.
- It sends one mail at a time, in queue order, so two tries of the same mail
  can never run side by side. One send takes about 0.5–1 s, so this covers a
  few thousand mails an hour. If that is ever too slow, the same worker can
  send for several mailboxes in parallel (one mail per mailbox at a time),
  still as one active sender.
- The other workers and APIs 2 / 3 have no send code at all: the shared EWS
  client they use has no send method, so a bug elsewhere cannot send a mail.

- **Action states:** `Waiting → Processing → Submitted → Confirmed`, plus
  `Failed` and `Unknown`. The state is saved in `MailAction` before every step.
- Every user action has its own **ActionID**, made by the app. API 2 / 3 refuse
  a second action with the same ID.
- Every try is a row in `MailActionAttempt` (worker, times, Exchange answer).
- **The ActionID travels with the mail.** API 1 writes it into the message as a
  hidden extended property before sending. Exchange keeps it on the copy in
  Sent Items.
- **When the result is not known** (crash, timeout, link drop after the send
  call), the action becomes `Unknown`. API 1 then searches Sent Items for that
  ActionID:
  - found → `Confirmed`, nothing is sent again;
  - not found after the check window → `Failed`, and the user decides to send
    again (in-app prompt).
- **Never resend automatically** while the outcome of an earlier try is
  unknown. Read / flag / move / delete are safe to repeat and are retried with
  backoff.

### 7.2 Consistent databases and correct order (P0)

Exchange, SilaMail and SilaMailExt can drift when changes happen at the same
time (read in Outlook while Sila deletes the same message) or when the copy to
the external site stops halfway.

- **Exchange is the only source of truth.** The databases only ever hold what
  Exchange has confirmed.
- **Transactional outbox:** a change to SilaMail and its `MailChange` row are
  written in the same SQL transaction. A change can never be saved without
  being published, or published without being saved.
- **Ordered, durable sequence numbers** on `MailChange`. The publisher sends in
  order and only moves `MailPublishState` forward after API 3 confirms.
- **Idempotent apply on the external site:** API 3 skips a batch whose
  sequence number it has already applied, and a row is only overwritten by a
  newer version (sequence / ChangeKey). Sending the same batch twice changes
  nothing.
- **Check before acting:** before a conflicting action (move, delete, flag) API 1
  reads the message's current state from Exchange. If it is gone or has
  changed, the action is `Failed` with a clear reason ("This message was
  deleted in Outlook"), not run on a stale picture.
- After every action, API 1 writes **Exchange's confirmed state** to SilaMail;
  the outbox carries it to SilaMailExt.

### 7.3 API 1 is not a single point of failure (P1)

API 1 stays one service (no new public API), but its work is split into five
independent workers:

| Worker | Job | If it stops |
|---|---|---|
| **Exchange Sync** | Layers 1–5 (2.1) | Mail stops updating; actions and publishing go on |
| **Send** | Send, reply, forward; the only sender (7.1). One active instance, standby takes over after the lease expires | Outgoing mail waits in the queue; everything else goes on |
| **Action** | Read, flag, move, delete (2.3) | These actions wait in the queue; reading and sending still work |
| **Publisher** | SilaMail → SilaMailExt (2.2) | External copy falls behind; internal sync and actions go on |
| **Reconciliation** | Differences checks and repair (6.4) | Checks are late; nothing else is affected |

- Each worker restarts and recovers on its own, from saved state (sync
  checkpoint, action state, publish sequence).
- **Durable queues** in SilaMail (`MailAction`, `MailChange`), with retries and
  exponential backoff (for example 2 s, 4 s, 8 s … up to 5 min).
- Several instances of API 1 can run. **Job leasing** (`MailJobLease`: owner,
  lease until) makes sure a mailbox, an action or a batch is worked by only one
  instance; an expired lease is taken over. Sending has one lease for the
  whole service, so only one Send worker is ever active.
- Each worker has its own heartbeat in `MailServiceHeartbeat` and its own card
  in the Monitor.

### 7.4 The external action queue is untrusted (P0)

The external site cannot open connections inward, but anyone who takes over
API 3 or SilaMailExt could write fake actions into its queue.

- **Every action pulled from API 3 is untrusted.** API 1 checks it again before
  it touches Exchange.
- **Signed proof from the user.** Each external action carries the user's Sila
  login token as received from the app. The token is signed by 7400 with a key
  the external site does not have (API 3 can only verify it). API 1 checks the
  signature and the expiry and takes the UserID from the token.
- **API 1 ignores** UserID, mailbox address and permission fields written by the
  external site. The mailbox comes from SilaMail's `MailUser` for that UserID,
  and permissions are read again from the internal Sila database.
- **Ownership check:** the message, folder or attachment in the action must
  belong to that user's mailbox in SilaMail.
- **Strict limits:** known action types only, size limits (body, attachments,
  recipients), and per-user rate limits (for example sends per minute / per
  hour). Anything outside them is refused and logged.
- Short-lived tokens, so a stolen token cannot be replayed for long.
- API 1 ↔ API 3 over mutual TLS or a site-to-site VPN (1).
- Everything refused, and every send / delete, goes to `MailSecurityLog` and
  shows in the Monitor.
- The Exchange service account has only the impersonation role, scoped to Sila
  users (least privilege).

### 7.5 Safe recovery of the Exchange sync state (P0)

EWS sync depends on a saved SyncState per folder. If it is lost or no longer
accepted, a careless rebuild duplicates or loses messages and breaks Mail →
Ticket links.

- The **SyncState is stored per mailbox folder** (`MailFolder`).
- **The checkpoint moves only after the changes are committed:** SilaMail rows,
  `MailChange` rows and the new SyncState are saved in one transaction.
- `SyncFolderItems` is read **page by page** (for example 200 items); each page
  is committed with its own checkpoint, so a crash resumes from the last page.
- **Invalid or expired SyncState is detected** (EWS error) and the folder goes
  to `Rebuilding` instead of failing over and over.
- **Controlled folder rebuild:** sync the folder from empty into a work area,
  then match it against the existing rows by ItemId, then InternetMessageId +
  received time. Matching rows are updated in place, new ones added, and only
  rows Exchange really no longer has are removed.
- **The Sila MessageID never changes**, even if the Exchange ItemId does (move,
  rebuild). `MailTicketLink` and the external copy use the Sila MessageID, so
  Mail → Ticket links survive any recovery.
- Every rebuild and recovery is logged (`MailSyncLog`, reason, items matched /
  added / removed) and shown in the Monitor.

### 7.6 When each rule is needed

| Priority | Rule | Must be done before |
|---|---|---|
| P0 | 7.1 One Send worker, never send a mail twice | Send / reply / forward is switched on |
| P0 | 7.2 Transactional outbox and ordered, idempotent copy | The external copy starts |
| P0 | 7.4 External action queue is untrusted | External users can do actions |
| P0 | 7.5 Safe sync-state recovery | Real mailboxes are synced (production) |
| P1 | 7.3 Independent workers and recovery | Production go-live |

---

## 8. Phases

1. **Proof of concept (about 1 week).** Service account, impersonation,
   throttling policy, sync of one test mailbox into SilaMail. Measure speed and
   time to first sync on the 120 GB mailbox and two average ones, and the
   database size per GB of mailbox. Try the publisher vs SQL replication to SilaMailExt.
   Prove the ActionID extended property can be found in Sent Items (7.1) and
   force an invalid SyncState to test the rebuild (7.5).
2. **Read-only Mail, internal.** API 1 (sync layers 1–5 with checkpoints and
   rebuild, 7.5; the workers, 7.3), SilaMail with the outbox, API 2,
   the web Inbox from the mockup, the freshness indicator, and the Monitor's
   **Overview, Accounts and Errors** tabs with the quick count check — so it is
   visible from day one that the copy is up to date.
3. **External.** The external site (server, SilaMailExt, storage), API 3 with
   its sync endpoints, the publisher (ordered, idempotent, 7.2), the first
   load, split DNS, the lag cards and the internal ↔ external check.
4. **Actions + Differences.** The action queue and the external action checks
   (7.4): read / flag / move / delete, then the Send worker with its state
   machine (7.1) for send / reply / forward with attachments. The full
   differences checks, repair, the **Differences** tab and alerts.
5. **Sila integration.** Mail → ticket, mail files attached to tickets, new
   mail on Home, push notifications.
6. **Hardening.** Retention rules, performance tuning, mobile app.

---

## 9. Open questions (before Phase 1)

1. **Exchange version:** ~~2016, 2019 or SE?~~ **Answered: Exchange 2019.**
   Still open: which CU, is EWS enabled, what is its internal URL, and when
   will IT upgrade to Subscription Edition (2019 is out of support)?
2. **Mailboxes:** ~~how many, how large?~~ **Answered: 550 mailboxes, largest
   120 GB.** Still open: total size of the Exchange databases and the average
   mailbox size (for database sizing).
3. **History depth:** first sync of the whole mailbox, or the last 6–12 months?
   Decides database size and first-sync time.
4. **Attachments:** fetch on first open (recommended) or copy all up front?
5. **External site:** which provider / location, and how fast is the company's
   internet link? Mutual TLS over the internet, or a site-to-site VPN? Who
   owns the split DNS records?
6. **External copy scope:** should SilaMailExt hold the full history, or only
   the last N months (older mail then only readable inside the company)?
   A smaller external copy means less exposed if the external site is broken
   into, and a faster first load.
7. **DNS switch:** is the switch split DNS (inside → API 2, outside → API 3), or
   one public name that IT points at API 2 or API 3 by hand (fail-over)?
   The plan assumes split DNS, with the hand switch as the fallback.
8. **Sila login token:** is it signed so the external site can verify it but
   not create it (for example an RS256 / ES256 key pair kept only on 7400)?
   7.4 depends on this. If not, 7400 needs that change first.
9. **Approval:** can IT create the impersonation service account and the
   throttling policy? Keeping a copy of everyone's mail outside Exchange should
   be signed off by management / IT security.
