USE [InternalMail]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/*
  Sila Mail -- INTERNAL database (MailPlan "SilaMail"), schema [mail].
  Database: [InternalMail] on silamail.glcpaints.com,7020 (inside the company).

  The master copy for Sila, written by the Mail Connector API (API 1) only
  after Exchange has confirmed a change; read by API 2 for internal users,
  who only add queued actions (MailAction). The external [Mail] database is
  a copy of this one, fed through the change log (MailChange).

  - IDs are made HERE (IDENTITY) and copied as-is to the external database.
    MessageID is the stable Sila ID: it never changes, even when the Exchange
    ItemId does (move, rebuild), so Mail -> Ticket links survive (MailPlan 7.5).
  - Transactional outbox (MailPlan 7.2): every change to a copied table writes
    its MailChange row in the same transaction. The publisher sends MailChange
    in Seq order and moves MailPublishState only after API 3 confirms.
  - Exchange SyncStates (checkpoints) live only here, and move only in the
    same transaction as the rows they cover (MailPlan 7.5).
  - Exchange IDs are base64 and case-sensitive: stored in a BIN2 collation.
  - Message -> Folder has no foreign key: during a folder rebuild a message
    may briefly point at a folder being replaced; API 1 checks it.

  Idempotent: safe to run again. Run in SSMS on the internal server.
*/

IF SCHEMA_ID(N'mail') IS NULL EXEC(N'CREATE SCHEMA [mail] AUTHORIZATION [dbo]');
GO

/* ======================================================================
   Mail copy (same shape as the external database, plus Exchange state)
   ====================================================================== */

-- One row per Sila user with a mailbox.
IF OBJECT_ID(N'[mail].[MailUser]', N'U') IS NULL
CREATE TABLE [mail].[MailUser]
(
    [UserID]                  INT            NOT NULL,     -- Sila UserID
    [SmtpAddress]             NVARCHAR(320)  NOT NULL,
    [DisplayName]             NVARCHAR(256)  NULL,
    [IsEnabled]               BIT            NOT NULL CONSTRAINT [DF_MailUser_IsEnabled] DEFAULT (1),
    [SyncStatus]              VARCHAR(10)    NOT NULL CONSTRAINT [DF_MailUser_SyncStatus] DEFAULT ('OK'),
    [SubscriptionStatus]      VARCHAR(12)    NOT NULL CONSTRAINT [DF_MailUser_SubscriptionStatus] DEFAULT ('Down'),
    [LastSyncAt]              DATETIME2(3)   NULL,         -- last successful sync
    [LastSyncAttemptAt]       DATETIME2(3)   NULL,
    [ConsecutiveFailures]     INT            NOT NULL CONSTRAINT [DF_MailUser_Failures] DEFAULT (0),
    [LastNotificationAt]      DATETIME2(3)   NULL,
    [SubscriptionDownSince]   DATETIME2(3)   NULL,
    [ExchangeItemCount]       INT            NULL,
    [ExchangeUnreadCount]     INT            NULL,
    [HierarchySyncState]      VARCHAR(MAX)   COLLATE Latin1_General_BIN2 NULL,   -- SyncFolderHierarchy checkpoint
    [LastErrorKind]           VARCHAR(20)    NULL,
    [LastErrorCode]           VARCHAR(100)   NULL,
    [LastErrorAt]             DATETIME2(3)   NULL,
    [CreatedAt]               DATETIME2(3)   NOT NULL CONSTRAINT [DF_MailUser_CreatedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_MailUser] PRIMARY KEY CLUSTERED ([UserID]),
    CONSTRAINT [UQ_MailUser_SmtpAddress] UNIQUE ([SmtpAddress]),
    CONSTRAINT [CK_MailUser_SyncStatus] CHECK ([SyncStatus] IN ('OK', 'Behind', 'Error', 'Disabled')),
    CONSTRAINT [CK_MailUser_SubscriptionStatus] CHECK ([SubscriptionStatus] IN ('Connected', 'Reconnecting', 'Down'))
);
GO

IF OBJECT_ID(N'[mail].[MailFolder]', N'U') IS NULL
CREATE TABLE [mail].[MailFolder]
(
    [FolderID]            BIGINT         IDENTITY(1, 1) NOT NULL,
    [UserID]              INT            NOT NULL,
    [ParentFolderID]      BIGINT         NULL,
    [ExchangeFolderId]    VARCHAR(512)   COLLATE Latin1_General_BIN2 NOT NULL,
    [ExchangeChangeKey]   VARCHAR(128)   COLLATE Latin1_General_BIN2 NULL,
    [DisplayName]         NVARCHAR(255)  NOT NULL,
    [FolderType]          VARCHAR(20)    NOT NULL,
    [TotalCount]          INT            NOT NULL CONSTRAINT [DF_MailFolder_TotalCount] DEFAULT (0),   -- as Exchange reports it
    [UnreadCount]         INT            NOT NULL CONSTRAINT [DF_MailFolder_UnreadCount] DEFAULT (0),
    [IsSynced]            BIT            NOT NULL CONSTRAINT [DF_MailFolder_IsSynced] DEFAULT (1),     -- 0 = listed, items not copied
    [SyncState]           VARCHAR(MAX)   COLLATE Latin1_General_BIN2 NULL,   -- SyncFolderItems checkpoint
    [FolderSyncStatus]    VARCHAR(12)    NOT NULL CONSTRAINT [DF_MailFolder_SyncStatus] DEFAULT ('New'),
    [LastSyncAt]          DATETIME2(3)   NULL,
    [SyncStateUpdatedAt]  DATETIME2(3)   NULL,
    CONSTRAINT [PK_MailFolder] PRIMARY KEY CLUSTERED ([FolderID]),
    CONSTRAINT [FK_MailFolder_MailUser] FOREIGN KEY ([UserID]) REFERENCES [mail].[MailUser] ([UserID]),
    CONSTRAINT [CK_MailFolder_FolderType] CHECK ([FolderType] IN
        ('Root', 'Inbox', 'SentItems', 'Drafts', 'DeletedItems', 'JunkEmail', 'Outbox', 'Archive', 'Custom')),
    CONSTRAINT [CK_MailFolder_SyncStatus] CHECK ([FolderSyncStatus] IN ('New', 'Syncing', 'OK', 'Rebuilding', 'Error'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailFolder_User' AND object_id = OBJECT_ID(N'[mail].[MailFolder]'))
    CREATE UNIQUE NONCLUSTERED INDEX [IX_MailFolder_User] ON [mail].[MailFolder] ([UserID], [ExchangeFolderId]);
GO

IF OBJECT_ID(N'[mail].[MailMessage]', N'U') IS NULL
CREATE TABLE [mail].[MailMessage]
(
    [MessageID]          BIGINT          IDENTITY(1, 1) NOT NULL,
    [UserID]             INT             NOT NULL,
    [FolderID]           BIGINT          NOT NULL,
    [ExchangeItemId]     VARCHAR(512)    COLLATE Latin1_General_BIN2 NOT NULL,
    [ChangeKey]          VARCHAR(128)    COLLATE Latin1_General_BIN2 NOT NULL,
    [InternetMessageId]  NVARCHAR(500)   NULL,
    [ConversationId]     VARCHAR(512)    COLLATE Latin1_General_BIN2 NULL,
    [Subject]            NVARCHAR(1000)  NULL,
    [FromName]           NVARCHAR(320)   NULL,
    [FromAddress]        NVARCHAR(320)   NULL,
    [SentAt]             DATETIME2(3)    NULL,
    [ReceivedAt]         DATETIME2(3)    NOT NULL,
    [IsRead]             BIT             NOT NULL CONSTRAINT [DF_MailMessage_IsRead] DEFAULT (0),
    [FlagStatus]         TINYINT         NOT NULL CONSTRAINT [DF_MailMessage_FlagStatus] DEFAULT (0),  -- 0 none, 1 flagged, 2 complete
    [Importance]         TINYINT         NOT NULL CONSTRAINT [DF_MailMessage_Importance] DEFAULT (1),  -- 0 low, 1 normal, 2 high
    [HasAttachments]     BIT             NOT NULL CONSTRAINT [DF_MailMessage_HasAttachments] DEFAULT (0),
    [IsDraft]            BIT             NOT NULL CONSTRAINT [DF_MailMessage_IsDraft] DEFAULT (0),
    [Preview]            NVARCHAR(400)   NULL,
    [SyncedAt]           DATETIME2(3)    NOT NULL CONSTRAINT [DF_MailMessage_SyncedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_MailMessage] PRIMARY KEY CLUSTERED ([MessageID]),
    CONSTRAINT [FK_MailMessage_MailUser] FOREIGN KEY ([UserID]) REFERENCES [mail].[MailUser] ([UserID]),
    CONSTRAINT [CK_MailMessage_FlagStatus] CHECK ([FlagStatus] IN (0, 1, 2)),
    CONSTRAINT [CK_MailMessage_Importance] CHECK ([Importance] IN (0, 1, 2))
);
GO
-- The inbox list: one user's folder, newest first.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailMessage_Folder' AND object_id = OBJECT_ID(N'[mail].[MailMessage]'))
    CREATE NONCLUSTERED INDEX [IX_MailMessage_Folder] ON [mail].[MailMessage] ([UserID], [FolderID], [ReceivedAt] DESC)
        INCLUDE ([Subject], [FromName], [FromAddress], [IsRead], [FlagStatus], [Importance], [HasAttachments], [Preview]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailMessage_Conversation' AND object_id = OBJECT_ID(N'[mail].[MailMessage]'))
    CREATE NONCLUSTERED INDEX [IX_MailMessage_Conversation] ON [mail].[MailMessage] ([UserID], [ConversationId], [ReceivedAt]);
GO
-- Sync: find a row by its Exchange ItemId.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailMessage_ItemId' AND object_id = OBJECT_ID(N'[mail].[MailMessage]'))
    CREATE UNIQUE NONCLUSTERED INDEX [IX_MailMessage_ItemId] ON [mail].[MailMessage] ([UserID], [ExchangeItemId]);
GO
-- Rebuild: match by InternetMessageId + received time when the ItemId changed (MailPlan 7.5).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailMessage_InternetId' AND object_id = OBJECT_ID(N'[mail].[MailMessage]'))
    CREATE NONCLUSTERED INDEX [IX_MailMessage_InternetId] ON [mail].[MailMessage] ([UserID], [InternetMessageId], [ReceivedAt]);
GO

IF OBJECT_ID(N'[mail].[MailMessageBody]', N'U') IS NULL
CREATE TABLE [mail].[MailMessageBody]
(
    [MessageID]   BIGINT         NOT NULL,
    [BodyHtml]    NVARCHAR(MAX)  NULL,     -- sanitized by API 1 before it is stored
    [BodyText]    NVARCHAR(MAX)  NULL,     -- plain text, for search
    CONSTRAINT [PK_MailMessageBody] PRIMARY KEY CLUSTERED ([MessageID]),
    CONSTRAINT [FK_MailMessageBody_MailMessage] FOREIGN KEY ([MessageID]) REFERENCES [mail].[MailMessage] ([MessageID]) ON DELETE CASCADE
);
GO

IF OBJECT_ID(N'[mail].[MailRecipient]', N'U') IS NULL
CREATE TABLE [mail].[MailRecipient]
(
    [MessageID]      BIGINT         NOT NULL,
    [RecipientType]  TINYINT        NOT NULL,   -- 1 To, 2 Cc, 3 Bcc
    [Position]       SMALLINT       NOT NULL,
    [Name]           NVARCHAR(320)  NULL,
    [Address]        NVARCHAR(320)  NULL,
    CONSTRAINT [PK_MailRecipient] PRIMARY KEY CLUSTERED ([MessageID], [RecipientType], [Position]),
    CONSTRAINT [FK_MailRecipient_MailMessage] FOREIGN KEY ([MessageID]) REFERENCES [mail].[MailMessage] ([MessageID]) ON DELETE CASCADE,
    CONSTRAINT [CK_MailRecipient_Type] CHECK ([RecipientType] IN (1, 2, 3))
);
GO

-- The file is fetched from Exchange the first time someone opens it, then
-- kept on the internal file server (StoredPath, relative to its root).
IF OBJECT_ID(N'[mail].[MailAttachment]', N'U') IS NULL
CREATE TABLE [mail].[MailAttachment]
(
    [AttachmentID]          BIGINT         IDENTITY(1, 1) NOT NULL,
    [MessageID]             BIGINT         NOT NULL,
    [ExchangeAttachmentId]  VARCHAR(512)   COLLATE Latin1_General_BIN2 NOT NULL,
    [Name]                  NVARCHAR(255)  NOT NULL,
    [ContentType]           VARCHAR(255)   NULL,
    [Size]                  BIGINT         NULL,
    [IsInline]              BIT            NOT NULL CONSTRAINT [DF_MailAttachment_IsInline] DEFAULT (0),
    [ContentId]             NVARCHAR(255)  NULL,
    [StoredPath]            VARCHAR(400)   NULL,
    [StoredAt]              DATETIME2(3)   NULL,
    CONSTRAINT [PK_MailAttachment] PRIMARY KEY CLUSTERED ([AttachmentID]),
    CONSTRAINT [FK_MailAttachment_MailMessage] FOREIGN KEY ([MessageID]) REFERENCES [mail].[MailMessage] ([MessageID]) ON DELETE CASCADE
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailAttachment_Message' AND object_id = OBJECT_ID(N'[mail].[MailAttachment]'))
    CREATE NONCLUSTERED INDEX [IX_MailAttachment_Message] ON [mail].[MailAttachment] ([MessageID]);
GO

IF OBJECT_ID(N'[mail].[MailTicketLink]', N'U') IS NULL
CREATE TABLE [mail].[MailTicketLink]
(
    [MessageID]   BIGINT        NOT NULL,
    [TicketID]    INT           NOT NULL,
    [LinkedBy]    INT           NOT NULL,
    [LinkedAt]    DATETIME2(3)  NOT NULL CONSTRAINT [DF_MailTicketLink_LinkedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_MailTicketLink] PRIMARY KEY CLUSTERED ([MessageID], [TicketID])
);
GO

/* ======================================================================
   Actions (MailPlan 2.3, 7.1, 7.4)
   ====================================================================== */

-- Every user action, internal (queued by API 2) or external (pulled from
-- API 3 and checked again by API 1 before it is added here). Send / Reply /
-- ReplyAll / Forward are worked only by the Send worker, one at a time.
-- States: Waiting -> Processing -> Submitted -> Confirmed, plus Failed / Unknown;
-- an Unknown send is settled by finding its ActionID in Sent Items, never resent.
IF OBJECT_ID(N'[mail].[MailAction]', N'U') IS NULL
CREATE TABLE [mail].[MailAction]
(
    [ActionID]        UNIQUEIDENTIFIER  NOT NULL,     -- made by the app; a repeat is refused by the key
    [Source]          VARCHAR(8)        NOT NULL,     -- Internal (API 2) / External (API 3)
    [UserID]          INT               NOT NULL,     -- external: taken from the verified token
    [ActionType]      VARCHAR(20)       NOT NULL,
    [MessageID]       BIGINT            NULL,
    [TargetFolderID]  BIGINT            NULL,
    [Payload]         NVARCHAR(MAX)     NULL,         -- JSON: recipients, subject, body, attachment refs
    [State]           VARCHAR(12)       NOT NULL CONSTRAINT [DF_MailAction_State] DEFAULT ('Waiting'),
    [AttemptCount]    INT               NOT NULL CONSTRAINT [DF_MailAction_Attempts] DEFAULT (0),
    [NextAttemptAt]   DATETIME2(3)      NULL,         -- backoff for read / flag / move / delete
    [CreatedAt]       DATETIME2(3)      NOT NULL CONSTRAINT [DF_MailAction_CreatedAt] DEFAULT (SYSDATETIME()),
    [StartedAt]       DATETIME2(3)      NULL,
    [SubmittedAt]     DATETIME2(3)      NULL,
    [CompletedAt]     DATETIME2(3)      NULL,
    [ResultMessage]   NVARCHAR(1000)    NULL,
    [SentItemId]      VARCHAR(512)      COLLATE Latin1_General_BIN2 NULL,   -- the copy in Sent Items, once confirmed
    CONSTRAINT [PK_MailAction] PRIMARY KEY CLUSTERED ([ActionID]),
    CONSTRAINT [FK_MailAction_MailUser] FOREIGN KEY ([UserID]) REFERENCES [mail].[MailUser] ([UserID]),
    CONSTRAINT [CK_MailAction_Source] CHECK ([Source] IN ('Internal', 'External')),
    CONSTRAINT [CK_MailAction_Type] CHECK ([ActionType] IN
        ('Send', 'Reply', 'ReplyAll', 'Forward', 'MarkRead', 'MarkUnread', 'Flag', 'Unflag', 'Move', 'Delete',
         'FetchAttachment', 'SyncMailbox')),
    CONSTRAINT [CK_MailAction_State] CHECK ([State] IN ('Waiting', 'Processing', 'Submitted', 'Confirmed', 'Failed', 'Unknown')),
    CONSTRAINT [CK_MailAction_Payload] CHECK ([Payload] IS NULL OR ISJSON([Payload]) = 1)
);
GO
-- The work queues: not finished, oldest first.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailAction_Open' AND object_id = OBJECT_ID(N'[mail].[MailAction]'))
    CREATE NONCLUSTERED INDEX [IX_MailAction_Open] ON [mail].[MailAction] ([State], [CreatedAt])
        INCLUDE ([ActionType], [UserID], [NextAttemptAt])
        WHERE [State] IN ('Waiting', 'Processing', 'Submitted', 'Unknown');
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailAction_User' AND object_id = OBJECT_ID(N'[mail].[MailAction]'))
    CREATE NONCLUSTERED INDEX [IX_MailAction_User] ON [mail].[MailAction] ([UserID], [CreatedAt] DESC);
GO

-- Every try of an action: which worker, when, what Exchange answered.
IF OBJECT_ID(N'[mail].[MailActionAttempt]', N'U') IS NULL
CREATE TABLE [mail].[MailActionAttempt]
(
    [AttemptID]      BIGINT            IDENTITY(1, 1) NOT NULL,
    [ActionID]       UNIQUEIDENTIFIER  NOT NULL,
    [Worker]         VARCHAR(20)       NOT NULL,
    [Instance]       VARCHAR(100)      NOT NULL,
    [StartedAt]      DATETIME2(3)      NOT NULL CONSTRAINT [DF_MailActionAttempt_StartedAt] DEFAULT (SYSDATETIME()),
    [EndedAt]        DATETIME2(3)      NULL,
    [Outcome]        VARCHAR(12)       NULL,     -- Submitted / Confirmed / Failed / Unknown / Retry
    [ExchangeCode]   VARCHAR(100)      NULL,
    [Error]          NVARCHAR(1000)    NULL,
    CONSTRAINT [PK_MailActionAttempt] PRIMARY KEY CLUSTERED ([AttemptID]),
    CONSTRAINT [FK_MailActionAttempt_MailAction] FOREIGN KEY ([ActionID]) REFERENCES [mail].[MailAction] ([ActionID])
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailActionAttempt_Action' AND object_id = OBJECT_ID(N'[mail].[MailActionAttempt]'))
    CREATE NONCLUSTERED INDEX [IX_MailActionAttempt_Action] ON [mail].[MailActionAttempt] ([ActionID], [StartedAt]);
GO

-- Which worker instance owns which job until when (MailPlan 7.3). JobKey e.g.
-- 'Send' (the single send lease), 'Publish', 'Mailbox:1234'. An expired lease
-- may be taken over.
IF OBJECT_ID(N'[mail].[MailJobLease]', N'U') IS NULL
CREATE TABLE [mail].[MailJobLease]
(
    [JobKey]       VARCHAR(100)  NOT NULL,
    [Owner]        VARCHAR(100)  NOT NULL,     -- machine + process + worker
    [LeaseUntil]   DATETIME2(3)  NOT NULL,
    [AcquiredAt]   DATETIME2(3)  NOT NULL,
    [RenewedAt]    DATETIME2(3)  NOT NULL,
    CONSTRAINT [PK_MailJobLease] PRIMARY KEY CLUSTERED ([JobKey])
);
GO

/* ======================================================================
   Copy to the external database (MailPlan 2.2, 7.2)
   ====================================================================== */

-- The transactional outbox: one row per changed row, written in the same
-- transaction as the change. The publisher sends the row's CURRENT state (or
-- a delete) in Seq order. RowKey: the row's key as text ("123", "123|1|2").
IF OBJECT_ID(N'[mail].[MailChange]', N'U') IS NULL
CREATE TABLE [mail].[MailChange]
(
    [Seq]        BIGINT        IDENTITY(1, 1) NOT NULL,
    [TableName]  VARCHAR(30)   NOT NULL,
    [RowKey]     VARCHAR(100)  NOT NULL,
    [Operation]  CHAR(1)       NOT NULL,     -- U upsert, D delete
    [UserID]     INT           NULL,         -- per-account lag and re-publish
    [ChangedAt]  DATETIME2(3)  NOT NULL CONSTRAINT [DF_MailChange_ChangedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_MailChange] PRIMARY KEY CLUSTERED ([Seq]),
    CONSTRAINT [CK_MailChange_Table] CHECK ([TableName] IN
        ('MailUser', 'MailFolder', 'MailMessage', 'MailMessageBody', 'MailRecipient', 'MailAttachment',
         'MailTicketLink', 'MailAction', 'MailUserPermission')),
    CONSTRAINT [CK_MailChange_Operation] CHECK ([Operation] IN ('U', 'D'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailChange_User' AND object_id = OBJECT_ID(N'[mail].[MailChange]'))
    CREATE NONCLUSTERED INDEX [IX_MailChange_User] ON [mail].[MailChange] ([UserID], [Seq]);
GO

-- Where the copy to [Mail] stands. One row.
IF OBJECT_ID(N'[mail].[MailPublishState]', N'U') IS NULL
CREATE TABLE [mail].[MailPublishState]
(
    [StateID]           TINYINT         NOT NULL CONSTRAINT [DF_MailPublishState_StateID] DEFAULT (1),
    [LastPublishedSeq]  BIGINT          NOT NULL CONSTRAINT [DF_MailPublishState_Seq] DEFAULT (0),   -- confirmed by API 3
    [LastPublishedAt]   DATETIME2(3)    NULL,
    [LastAttemptAt]     DATETIME2(3)    NULL,
    [LinkStatus]        VARCHAR(4)      NOT NULL CONSTRAINT [DF_MailPublishState_Link] DEFAULT ('Down'),
    [LastResponseMs]    INT             NULL,
    [LastError]         NVARCHAR(1000)  NULL,
    [LastErrorAt]       DATETIME2(3)    NULL,
    CONSTRAINT [PK_MailPublishState] PRIMARY KEY CLUSTERED ([StateID]),
    CONSTRAINT [CK_MailPublishState_One] CHECK ([StateID] = 1),
    CONSTRAINT [CK_MailPublishState_Link] CHECK ([LinkStatus] IN ('Up', 'Down'))
);
GO
IF NOT EXISTS (SELECT 1 FROM [mail].[MailPublishState])
    INSERT INTO [mail].[MailPublishState] ([StateID], [LastPublishedSeq]) VALUES (1, 0);
GO

/* ======================================================================
   Sync log, errors, rebuild work area (MailPlan 6.2, 6.3, 7.5)
   ====================================================================== */

IF OBJECT_ID(N'[mail].[MailSyncLog]', N'U') IS NULL
CREATE TABLE [mail].[MailSyncLog]
(
    [SyncLogID]     BIGINT          IDENTITY(1, 1) NOT NULL,
    [UserID]        INT             NOT NULL,
    [FolderID]      BIGINT          NULL,       -- NULL: the folder hierarchy / whole mailbox
    [Kind]          VARCHAR(12)     NOT NULL,
    [Reason]        VARCHAR(30)     NULL,       -- Notification, Safety, OnOpen, Admin, InvalidSyncState ...
    [Worker]        VARCHAR(20)     NOT NULL,
    [StartedAt]     DATETIME2(3)    NOT NULL CONSTRAINT [DF_MailSyncLog_StartedAt] DEFAULT (SYSDATETIME()),
    [EndedAt]       DATETIME2(3)    NULL,
    [Pages]         INT             NOT NULL CONSTRAINT [DF_MailSyncLog_Pages] DEFAULT (0),
    [Added]         INT             NOT NULL CONSTRAINT [DF_MailSyncLog_Added] DEFAULT (0),
    [Changed]       INT             NOT NULL CONSTRAINT [DF_MailSyncLog_Changed] DEFAULT (0),
    [Deleted]       INT             NOT NULL CONSTRAINT [DF_MailSyncLog_Deleted] DEFAULT (0),
    [Matched]       INT             NOT NULL CONSTRAINT [DF_MailSyncLog_Matched] DEFAULT (0),   -- rebuild only
    [Succeeded]     BIT             NULL,       -- NULL while running
    [ErrorKind]     VARCHAR(20)     NULL,
    [ErrorCode]     VARCHAR(100)    NULL,
    [ErrorMessage]  NVARCHAR(1000)  NULL,
    CONSTRAINT [PK_MailSyncLog] PRIMARY KEY CLUSTERED ([SyncLogID]),
    CONSTRAINT [CK_MailSyncLog_Kind] CHECK ([Kind] IN ('Hierarchy', 'Folder', 'Rebuild', 'Count'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailSyncLog_User' AND object_id = OBJECT_ID(N'[mail].[MailSyncLog]'))
    CREATE NONCLUSTERED INDEX [IX_MailSyncLog_User] ON [mail].[MailSyncLog] ([UserID], [StartedAt] DESC);
GO

-- Errors grouped for the Monitor's Errors tab: one open row per
-- type + account + folder + code, counted up while it repeats.
IF OBJECT_ID(N'[mail].[MailSyncError]', N'U') IS NULL
CREATE TABLE [mail].[MailSyncError]
(
    [ErrorID]      BIGINT          IDENTITY(1, 1) NOT NULL,
    [ErrorType]    VARCHAR(20)     NOT NULL,
    [UserID]       INT             NULL,
    [FolderID]     BIGINT          NULL,
    [Code]         VARCHAR(100)    NOT NULL,
    [Message]      NVARCHAR(1000)  NULL,
    [Count]        INT             NOT NULL CONSTRAINT [DF_MailSyncError_Count] DEFAULT (1),
    [FirstSeenAt]  DATETIME2(3)    NOT NULL CONSTRAINT [DF_MailSyncError_FirstSeen] DEFAULT (SYSDATETIME()),
    [LastSeenAt]   DATETIME2(3)    NOT NULL CONSTRAINT [DF_MailSyncError_LastSeen] DEFAULT (SYSDATETIME()),
    [ResolvedAt]   DATETIME2(3)    NULL,
    [ResolvedBy]   INT             NULL,
    CONSTRAINT [PK_MailSyncError] PRIMARY KEY CLUSTERED ([ErrorID]),
    CONSTRAINT [CK_MailSyncError_Type] CHECK ([ErrorType] IN
        ('Authentication', 'Permission', 'Throttling', 'Connection', 'BadItem', 'Database', 'Publish',
         'ActionFailed', 'ActionUnknown', 'SyncStateRebuilt', 'RefusedExternal', 'Other'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailSyncError_Open' AND object_id = OBJECT_ID(N'[mail].[MailSyncError]'))
    CREATE UNIQUE NONCLUSTERED INDEX [IX_MailSyncError_Open] ON [mail].[MailSyncError] ([ErrorType], [UserID], [FolderID], [Code])
        WHERE [ResolvedAt] IS NULL;
GO

-- Work area of a controlled folder rebuild (MailPlan 7.5): the folder is
-- re-read from Exchange into here, then matched against MailMessage.
-- RebuildID = the MailSyncLog row of that rebuild.
IF OBJECT_ID(N'[mail].[MailRebuildItem]', N'U') IS NULL
CREATE TABLE [mail].[MailRebuildItem]
(
    [RebuildID]          BIGINT         NOT NULL,
    [ExchangeItemId]     VARCHAR(512)   COLLATE Latin1_General_BIN2 NOT NULL,
    [ChangeKey]          VARCHAR(128)   COLLATE Latin1_General_BIN2 NOT NULL,
    [InternetMessageId]  NVARCHAR(500)  NULL,
    [ReceivedAt]         DATETIME2(3)   NULL,
    CONSTRAINT [PK_MailRebuildItem] PRIMARY KEY CLUSTERED ([RebuildID], [ExchangeItemId]),
    CONSTRAINT [FK_MailRebuildItem_MailSyncLog] FOREIGN KEY ([RebuildID]) REFERENCES [mail].[MailSyncLog] ([SyncLogID]) ON DELETE CASCADE
);
GO

/* ======================================================================
   Differences checks (MailPlan 6.4)
   ====================================================================== */

IF OBJECT_ID(N'[mail].[MailReconcileRun]', N'U') IS NULL
CREATE TABLE [mail].[MailReconcileRun]
(
    [RunID]            BIGINT        IDENTITY(1, 1) NOT NULL,
    [CheckType]        VARCHAR(20)   NOT NULL,     -- ExchangeInternal / InternalExternal
    [Depth]            VARCHAR(8)    NOT NULL,     -- Quick / Full
    [UserID]           INT           NULL,         -- NULL: all accounts
    [StartedAt]        DATETIME2(3)  NOT NULL CONSTRAINT [DF_MailReconcileRun_StartedAt] DEFAULT (SYSDATETIME()),
    [EndedAt]          DATETIME2(3)  NULL,
    [AccountsChecked]  INT           NOT NULL CONSTRAINT [DF_MailReconcileRun_Accounts] DEFAULT (0),
    [MismatchesFound]  INT           NOT NULL CONSTRAINT [DF_MailReconcileRun_Found] DEFAULT (0),
    [MismatchesFixed]  INT           NOT NULL CONSTRAINT [DF_MailReconcileRun_Fixed] DEFAULT (0),
    [StartedBy]        INT           NULL,         -- NULL: scheduled
    CONSTRAINT [PK_MailReconcileRun] PRIMARY KEY CLUSTERED ([RunID]),
    CONSTRAINT [CK_MailReconcileRun_Type] CHECK ([CheckType] IN ('ExchangeInternal', 'InternalExternal')),
    CONSTRAINT [CK_MailReconcileRun_Depth] CHECK ([Depth] IN ('Quick', 'Full'))
);
GO

IF OBJECT_ID(N'[mail].[MailReconcileItem]', N'U') IS NULL
CREATE TABLE [mail].[MailReconcileItem]
(
    [ItemID]          BIGINT         IDENTITY(1, 1) NOT NULL,
    [RunID]           BIGINT         NOT NULL,
    [UserID]          INT            NOT NULL,
    [FolderID]        BIGINT         NULL,
    [MessageID]       BIGINT         NULL,
    [ExchangeItemId]  VARCHAR(512)   COLLATE Latin1_General_BIN2 NULL,
    [Kind]            VARCHAR(16)    NOT NULL,
    [Detail]          NVARCHAR(400)  NULL,     -- subject / date, or the two counts
    [State]           VARCHAR(8)     NOT NULL CONSTRAINT [DF_MailReconcileItem_State] DEFAULT ('Open'),
    CONSTRAINT [PK_MailReconcileItem] PRIMARY KEY CLUSTERED ([ItemID]),
    CONSTRAINT [FK_MailReconcileItem_Run] FOREIGN KEY ([RunID]) REFERENCES [mail].[MailReconcileRun] ([RunID]) ON DELETE CASCADE,
    CONSTRAINT [CK_MailReconcileItem_Kind] CHECK ([Kind] IN ('MissingInDB', 'ExtraInDB', 'Changed', 'CountMismatch')),
    CONSTRAINT [CK_MailReconcileItem_State] CHECK ([State] IN ('Open', 'Fixed', 'Failed'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailReconcileItem_Run' AND object_id = OBJECT_ID(N'[mail].[MailReconcileItem]'))
    CREATE NONCLUSTERED INDEX [IX_MailReconcileItem_Run] ON [mail].[MailReconcileItem] ([RunID], [UserID]);
GO

/* ======================================================================
   Health, security, settings (MailPlan 6.1, 6.6, 7.4)
   ====================================================================== */

-- One row per API / worker instance, refreshed every few seconds.
IF OBJECT_ID(N'[mail].[MailServiceHeartbeat]', N'U') IS NULL
CREATE TABLE [mail].[MailServiceHeartbeat]
(
    [Component]    VARCHAR(20)     NOT NULL,
    [Instance]     VARCHAR(100)    NOT NULL,
    [StartedAt]    DATETIME2(3)    NOT NULL,
    [LastBeatAt]   DATETIME2(3)    NOT NULL,
    [Metrics]      NVARCHAR(4000)  NULL,     -- JSON: subscriptions, syncs/min, Exchange ms, lag, queue sizes
    [LastError]    NVARCHAR(1000)  NULL,
    [LastErrorAt]  DATETIME2(3)    NULL,
    CONSTRAINT [PK_MailServiceHeartbeat] PRIMARY KEY CLUSTERED ([Component], [Instance]),
    CONSTRAINT [CK_MailServiceHeartbeat_Component] CHECK ([Component] IN
        ('Connector', 'InternalApi', 'ExternalApi', 'ExchangeSync', 'Send', 'Action', 'Publisher', 'Reconciliation')),
    CONSTRAINT [CK_MailServiceHeartbeat_Metrics] CHECK ([Metrics] IS NULL OR ISJSON([Metrics]) = 1)
);
GO

-- Security-sensitive events: refused external actions, token checks, every
-- send / delete, admin repairs.
IF OBJECT_ID(N'[mail].[MailSecurityLog]', N'U') IS NULL
CREATE TABLE [mail].[MailSecurityLog]
(
    [LogID]       BIGINT            IDENTITY(1, 1) NOT NULL,
    [At]          DATETIME2(3)      NOT NULL CONSTRAINT [DF_MailSecurityLog_At] DEFAULT (SYSDATETIME()),
    [EventType]   VARCHAR(30)       NOT NULL,
    [Source]      VARCHAR(8)        NOT NULL,     -- Internal / External / Admin
    [UserID]      INT               NULL,
    [ActionID]    UNIQUEIDENTIFIER  NULL,
    [Detail]      NVARCHAR(2000)    NULL,
    CONSTRAINT [PK_MailSecurityLog] PRIMARY KEY CLUSTERED ([LogID]),
    CONSTRAINT [CK_MailSecurityLog_Source] CHECK ([Source] IN ('Internal', 'External', 'Admin'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailSecurityLog_User' AND object_id = OBJECT_ID(N'[mail].[MailSecurityLog]'))
    CREATE NONCLUSTERED INDEX [IX_MailSecurityLog_User] ON [mail].[MailSecurityLog] ([UserID], [At] DESC);
GO

-- Thresholds and schedules the Monitor and the workers read (MailPlan 6.5, 6.6).
IF OBJECT_ID(N'[mail].[MailSettings]', N'U') IS NULL
CREATE TABLE [mail].[MailSettings]
(
    [SettingKey]   VARCHAR(50)    NOT NULL,
    [Value]        NVARCHAR(200)  NOT NULL,
    [Description]  NVARCHAR(400)  NULL,
    [UpdatedAt]    DATETIME2(3)   NOT NULL CONSTRAINT [DF_MailSettings_UpdatedAt] DEFAULT (SYSDATETIME()),
    [UpdatedBy]    INT            NULL,
    CONSTRAINT [PK_MailSettings] PRIMARY KEY CLUSTERED ([SettingKey])
);
GO
-- Defaults; an existing value is never overwritten.
INSERT INTO [mail].[MailSettings] ([SettingKey], [Value], [Description])
SELECT s.[SettingKey], s.[Value], s.[Description]
FROM (VALUES
    ('BehindMinutes',            N'10',  N'Behind: last successful sync older than this'),
    ('SubscriptionDownMinutes',  N'5',   N'Behind: subscription down longer than this'),
    ('ErrorAfterFailures',       N'3',   N'Error: this many sync attempts failed in a row'),
    ('SafetySyncMinutes',        N'3',   N'Every mailbox syncs at least this often'),
    ('SyncPageSize',             N'200', N'Items per SyncFolderItems page (one commit each)'),
    ('ExternalLagSeconds',       N'60',  N'External behind: change not in [Mail] after this'),
    ('PublishLagAlertMinutes',   N'5',   N'Alert: publish lag over this'),
    ('ActionWaitAlertMinutes',   N'2',   N'Alert: actions waiting longer than this'),
    ('AccountErrorAlertMinutes', N'15',  N'Alert: an account in Error longer than this'),
    ('BehindPercentAlert',       N'5',   N'Alert: more than this % of accounts Behind'),
    ('RepairFullResyncPercent',  N'5',   N'Repair: more than this % mismatched means a full resync'),
    ('SendLeaseSeconds',         N'30',  N'The single Send lease expires after this'),
    ('SendCheckWindowMinutes',   N'10',  N'Unknown send: search Sent Items this long before Failed')
) AS s ([SettingKey], [Value], [Description])
WHERE NOT EXISTS (SELECT 1 FROM [mail].[MailSettings] x WHERE x.[SettingKey] = s.[SettingKey]);
GO
