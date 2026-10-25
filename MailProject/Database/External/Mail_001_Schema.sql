USE [Mail]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/*
  Sila Mail -- EXTERNAL database (MailPlan "SilaMailExt"), schema [mail].
  Database: [Mail] on the Sila server (beside SILA101 / :7400).

  A copy of the internal SilaMail, written only by API 3 when it applies a
  batch the Mail Connector API (API 1) published. Read by API 3 for external
  users; the only rows external users create are queued actions (MailAction).

  - Keys (UserID, FolderID, MessageID, AttachmentID) are the INTERNAL ones,
    copied as-is: no IDENTITY here, so both databases name a row the same way.
  - Every copied row carries PublishSeq (the MailChange sequence that last
    wrote it) and PublishedAt: a row is only overwritten by a newer sequence,
    so applying the same batch twice changes nothing (MailPlan 7.2).
  - No Exchange SyncState here -- it stays in the internal database only.
  - Exchange IDs are base64 and case-sensitive: stored in a BIN2 collation.
  - Message -> Folder has no foreign key on purpose: a move or a folder
    rebuild may arrive in either order; API 3 checks it when applying.

  Idempotent: safe to run again. Run in SSMS (deploy.sh only reaches SILA101).
*/

IF SCHEMA_ID(N'mail') IS NULL EXEC(N'CREATE SCHEMA [mail] AUTHORIZATION [dbo]');
GO

-- One row per Sila user with a mailbox. SmtpAddress comes from internal MailUser.
IF OBJECT_ID(N'[mail].[MailUser]', N'U') IS NULL
CREATE TABLE [mail].[MailUser]
(
    [UserID]              INT            NOT NULL,
    [SmtpAddress]         NVARCHAR(320)  NOT NULL,
    [DisplayName]         NVARCHAR(256)  NULL,
    [IsEnabled]           BIT            NOT NULL CONSTRAINT [DF_MailUser_IsEnabled] DEFAULT (1),
    [SyncStatus]          VARCHAR(10)    NOT NULL CONSTRAINT [DF_MailUser_SyncStatus] DEFAULT ('OK'),
    [LastSyncAt]          DATETIME2(3)   NULL,     -- last successful Exchange sync (internal)
    [LastNotificationAt]  DATETIME2(3)   NULL,
    [ExchangeItemCount]   INT            NULL,
    [ExchangeUnreadCount] INT            NULL,
    [PublishSeq]          BIGINT         NOT NULL,
    [PublishedAt]         DATETIME2(3)   NOT NULL CONSTRAINT [DF_MailUser_PublishedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_MailUser] PRIMARY KEY CLUSTERED ([UserID]),
    CONSTRAINT [UQ_MailUser_SmtpAddress] UNIQUE ([SmtpAddress]),
    CONSTRAINT [CK_MailUser_SyncStatus] CHECK ([SyncStatus] IN ('OK', 'Behind', 'Error', 'Disabled'))
);
GO

IF OBJECT_ID(N'[mail].[MailFolder]', N'U') IS NULL
CREATE TABLE [mail].[MailFolder]
(
    [FolderID]         BIGINT         NOT NULL,
    [UserID]           INT            NOT NULL,
    [ParentFolderID]   BIGINT         NULL,
    [ExchangeFolderId] VARCHAR(512)   COLLATE Latin1_General_BIN2 NOT NULL,
    [DisplayName]      NVARCHAR(255)  NOT NULL,
    [FolderType]       VARCHAR(20)    NOT NULL,
    [TotalCount]       INT            NOT NULL CONSTRAINT [DF_MailFolder_TotalCount] DEFAULT (0),
    [UnreadCount]      INT            NOT NULL CONSTRAINT [DF_MailFolder_UnreadCount] DEFAULT (0),
    [LastSyncAt]       DATETIME2(3)   NULL,
    [PublishSeq]       BIGINT         NOT NULL,
    [PublishedAt]      DATETIME2(3)   NOT NULL CONSTRAINT [DF_MailFolder_PublishedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_MailFolder] PRIMARY KEY CLUSTERED ([FolderID]),
    CONSTRAINT [FK_MailFolder_MailUser] FOREIGN KEY ([UserID]) REFERENCES [mail].[MailUser] ([UserID]) ON DELETE CASCADE,
    CONSTRAINT [CK_MailFolder_FolderType] CHECK ([FolderType] IN
        ('Root', 'Inbox', 'SentItems', 'Drafts', 'DeletedItems', 'JunkEmail', 'Outbox', 'Archive', 'Custom'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailFolder_User' AND object_id = OBJECT_ID(N'[mail].[MailFolder]'))
    CREATE UNIQUE NONCLUSTERED INDEX [IX_MailFolder_User] ON [mail].[MailFolder] ([UserID], [ExchangeFolderId]);
GO

-- MessageID is the stable Sila ID (tickets and links use it; it survives
-- Exchange ItemId changes). The body is in MailMessageBody, so list queries
-- never read it.
IF OBJECT_ID(N'[mail].[MailMessage]', N'U') IS NULL
CREATE TABLE [mail].[MailMessage]
(
    [MessageID]          BIGINT          NOT NULL,
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
    [PublishSeq]         BIGINT          NOT NULL,
    [PublishedAt]        DATETIME2(3)    NOT NULL CONSTRAINT [DF_MailMessage_PublishedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_MailMessage] PRIMARY KEY CLUSTERED ([MessageID]),
    CONSTRAINT [FK_MailMessage_MailUser] FOREIGN KEY ([UserID]) REFERENCES [mail].[MailUser] ([UserID]) ON DELETE CASCADE,
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
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailMessage_ItemId' AND object_id = OBJECT_ID(N'[mail].[MailMessage]'))
    CREATE UNIQUE NONCLUSTERED INDEX [IX_MailMessage_ItemId] ON [mail].[MailMessage] ([UserID], [ExchangeItemId]);
GO

IF OBJECT_ID(N'[mail].[MailMessageBody]', N'U') IS NULL
CREATE TABLE [mail].[MailMessageBody]
(
    [MessageID]   BIGINT         NOT NULL,
    [BodyHtml]    NVARCHAR(MAX)  NULL,     -- sanitized by API 1 before it is stored
    [BodyText]    NVARCHAR(MAX)  NULL,     -- plain text, for search
    [PublishSeq]  BIGINT         NOT NULL,
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

-- The file is fetched from Exchange the first time someone opens it; for an
-- external user API 1 uploads it to this site's storage and sets StoredName.
IF OBJECT_ID(N'[mail].[MailAttachment]', N'U') IS NULL
CREATE TABLE [mail].[MailAttachment]
(
    [AttachmentID]          BIGINT         NOT NULL,
    [MessageID]             BIGINT         NOT NULL,
    [ExchangeAttachmentId]  VARCHAR(512)   COLLATE Latin1_General_BIN2 NOT NULL,
    [Name]                  NVARCHAR(255)  NOT NULL,
    [ContentType]           VARCHAR(255)   NULL,
    [Size]                  BIGINT         NULL,
    [IsInline]              BIT            NOT NULL CONSTRAINT [DF_MailAttachment_IsInline] DEFAULT (0),
    [ContentId]             NVARCHAR(255)  NULL,
    [StoredName]            VARCHAR(100)   NULL,   -- file name in this site's storage, once fetched
    [StoredAt]              DATETIME2(3)   NULL,
    [PublishSeq]            BIGINT         NOT NULL,
    CONSTRAINT [PK_MailAttachment] PRIMARY KEY CLUSTERED ([AttachmentID]),
    CONSTRAINT [FK_MailAttachment_MailMessage] FOREIGN KEY ([MessageID]) REFERENCES [mail].[MailMessage] ([MessageID]) ON DELETE CASCADE
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailAttachment_Message' AND object_id = OBJECT_ID(N'[mail].[MailAttachment]'))
    CREATE NONCLUSTERED INDEX [IX_MailAttachment_Message] ON [mail].[MailAttachment] ([MessageID]);
GO

-- "Create a ticket from this mail": always the Sila MessageID, never the Exchange ItemId.
IF OBJECT_ID(N'[mail].[MailTicketLink]', N'U') IS NULL
CREATE TABLE [mail].[MailTicketLink]
(
    [MessageID]   BIGINT        NOT NULL,
    [TicketID]    INT           NOT NULL,
    [LinkedBy]    INT           NOT NULL,
    [LinkedAt]    DATETIME2(3)  NOT NULL,
    [PublishSeq]  BIGINT        NOT NULL,
    CONSTRAINT [PK_MailTicketLink] PRIMARY KEY CLUSTERED ([MessageID], [TicketID])
);
GO

-- Actions external users queue (send, read, flag, move, delete, ...). API 1
-- pulls them from inside and treats them as untrusted (MailPlan 7.4): it checks
-- AuthToken's signature and takes the user from it, not from UserID here.
-- ActionID is made by the app, so a repeated request is refused by the key.
IF OBJECT_ID(N'[mail].[MailAction]', N'U') IS NULL
CREATE TABLE [mail].[MailAction]
(
    [ActionID]        UNIQUEIDENTIFIER  NOT NULL,
    [UserID]          INT               NOT NULL,
    [ActionType]      VARCHAR(20)       NOT NULL,
    [MessageID]       BIGINT            NULL,
    [TargetFolderID]  BIGINT            NULL,
    [Payload]         NVARCHAR(MAX)     NULL,     -- JSON: recipients, subject, body, attachment refs
    [AuthToken]       VARCHAR(4000)     NULL,     -- the user's Sila token; cleared once API 1 has taken the action
    [State]           VARCHAR(12)       NOT NULL CONSTRAINT [DF_MailAction_State] DEFAULT ('Waiting'),
    [CreatedAt]       DATETIME2(3)      NOT NULL CONSTRAINT [DF_MailAction_CreatedAt] DEFAULT (SYSDATETIME()),
    [PickedUpAt]      DATETIME2(3)      NULL,
    [CompletedAt]     DATETIME2(3)      NULL,
    [ResultMessage]   NVARCHAR(1000)    NULL,
    CONSTRAINT [PK_MailAction] PRIMARY KEY CLUSTERED ([ActionID]),
    CONSTRAINT [CK_MailAction_Type] CHECK ([ActionType] IN
        ('Send', 'Reply', 'ReplyAll', 'Forward', 'MarkRead', 'MarkUnread', 'Flag', 'Unflag', 'Move', 'Delete',
         'FetchAttachment', 'SyncMailbox')),
    CONSTRAINT [CK_MailAction_State] CHECK ([State] IN ('Waiting', 'Processing', 'Submitted', 'Confirmed', 'Failed', 'Unknown')),
    CONSTRAINT [CK_MailAction_Payload] CHECK ([Payload] IS NULL OR ISJSON([Payload]) = 1)
);
GO
-- What API 1 pulls: waiting actions, oldest first.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailAction_Waiting' AND object_id = OBJECT_ID(N'[mail].[MailAction]'))
    CREATE NONCLUSTERED INDEX [IX_MailAction_Waiting] ON [mail].[MailAction] ([CreatedAt]) WHERE [State] = 'Waiting';
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailAction_User' AND object_id = OBJECT_ID(N'[mail].[MailAction]'))
    CREATE NONCLUSTERED INDEX [IX_MailAction_User] ON [mail].[MailAction] ([UserID], [CreatedAt] DESC);
GO

-- The mail operations each user may use (Mail list, Mail send, ...), published
-- by API 1 from the internal Sila data. Trusted for reading only: API 1 checks
-- every action again against the internal data.
IF OBJECT_ID(N'[mail].[MailUserPermission]', N'U') IS NULL
CREATE TABLE [mail].[MailUserPermission]
(
    [UserID]      INT           NOT NULL,
    [Operation]   VARCHAR(50)   NOT NULL,
    [PublishSeq]  BIGINT        NOT NULL,
    CONSTRAINT [PK_MailUserPermission] PRIMARY KEY CLUSTERED ([UserID], [Operation])
);
GO

-- Where the copy stands: the last MailChange sequence applied. One row.
IF OBJECT_ID(N'[mail].[MailApplyState]', N'U') IS NULL
CREATE TABLE [mail].[MailApplyState]
(
    [StateID]         TINYINT         NOT NULL CONSTRAINT [DF_MailApplyState_StateID] DEFAULT (1),
    [LastAppliedSeq]  BIGINT          NOT NULL CONSTRAINT [DF_MailApplyState_Seq] DEFAULT (0),
    [LastAppliedAt]   DATETIME2(3)    NULL,
    [LastBatchSize]   INT             NULL,
    [LastError]       NVARCHAR(1000)  NULL,
    [LastErrorAt]     DATETIME2(3)    NULL,
    CONSTRAINT [PK_MailApplyState] PRIMARY KEY CLUSTERED ([StateID]),
    CONSTRAINT [CK_MailApplyState_One] CHECK ([StateID] = 1)
);
GO
IF NOT EXISTS (SELECT 1 FROM [mail].[MailApplyState])
    INSERT INTO [mail].[MailApplyState] ([StateID], [LastAppliedSeq]) VALUES (1, 0);
GO
