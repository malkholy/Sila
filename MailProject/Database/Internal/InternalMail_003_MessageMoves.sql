USE [InternalMail]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/*
  003 -- moved messages keep their Sila MessageID (MailPlan 7.5).

  Exchange gives a message a new ItemId when it moves to another folder: the
  sync sees a Delete in one folder and a Create in the other, in either order.
  - A Delete now only marks the row (DeletedAt); the external copy is told at
    once (MailChange 'D').
  - At the end of each mailbox run, a marked row whose message shows up again
    (same InternetMessageId + ReceivedAt, a newer live row) takes over that
    row's Exchange ID, folder and attachments: same MessageID, links survive.
  - Marked rows with no match are removed after MoveGraceMinutes.
  Lists and counts read only rows WHERE DeletedAt IS NULL.

  Stop the Mail Connector API before running; start the new version after.
  Idempotent: safe to run again. Run in SSMS.
*/

IF COL_LENGTH(N'mail.MailMessage', N'DeletedAt') IS NULL
    ALTER TABLE [mail].[MailMessage] ADD [DeletedAt] DATETIME2(3) NULL;
GO

-- Marked rows of a mailbox: the end-of-run merge and the purge.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MailMessage_Deleted' AND object_id = OBJECT_ID(N'[mail].[MailMessage]'))
    CREATE NONCLUSTERED INDEX [IX_MailMessage_Deleted] ON [mail].[MailMessage] ([UserID], [DeletedAt])
        INCLUDE ([InternetMessageId], [ReceivedAt])
        WHERE [DeletedAt] IS NOT NULL;
GO

-- The inbox list index carries DeletedAt so "live rows only" needs no extra lookup.
IF NOT EXISTS (SELECT 1 FROM sys.index_columns ic
               JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
               WHERE i.name = N'IX_MailMessage_Folder' AND i.object_id = OBJECT_ID(N'[mail].[MailMessage]') AND c.name = N'DeletedAt')
    CREATE NONCLUSTERED INDEX [IX_MailMessage_Folder] ON [mail].[MailMessage] ([UserID], [FolderID], [ReceivedAt] DESC)
        INCLUDE ([Subject], [FromName], [FromAddress], [IsRead], [FlagStatus], [Importance], [HasAttachments], [Preview], [DeletedAt])
        WITH (DROP_EXISTING = ON);
GO

-- Sync log: a 'Moves' run records merges (Matched) and purges (Deleted).
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'CK_MailSyncLog_Kind' AND definition LIKE N'%Moves%')
BEGIN
    IF OBJECT_ID(N'[mail].[CK_MailSyncLog_Kind]', N'C') IS NOT NULL
        ALTER TABLE [mail].[MailSyncLog] DROP CONSTRAINT [CK_MailSyncLog_Kind];
    ALTER TABLE [mail].[MailSyncLog] ADD CONSTRAINT [CK_MailSyncLog_Kind]
        CHECK ([Kind] IN ('Hierarchy', 'Folder', 'Rebuild', 'Count', 'Moves'));
END
GO

INSERT INTO [mail].[MailSettings] ([SettingKey], [Value], [Description])
SELECT s.[SettingKey], s.[Value], s.[Description]
FROM (VALUES
    ('MoveGraceMinutes', N'30', N'A deleted message is kept this long in case it shows up in another folder (a move)'),
    ('BodyBatchSize',    N'20', N'Messages per Exchange call in the body pass')
) AS s ([SettingKey], [Value], [Description])
WHERE NOT EXISTS (SELECT 1 FROM [mail].[MailSettings] x WHERE x.[SettingKey] = s.[SettingKey]);
GO
