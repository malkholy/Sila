-- ============================================================================
-- Manual INSERT...SELECT migration:
--   Quick.QUK.AttachmentHistory -> Sila101 dbo.AttachmentHistory
-- Run this ON Sila101 in SSMS (it reads the [Quick] database on the same
-- instance; for a linked server replace [Quick] below with its path, e.g.
-- [QUICKSERVER].[Quick].[QUK].[AttachmentHistory]).
--
-- FULL RELOAD (standing decision): every run deletes all attachment records
-- on Sila and copies them again from Quick (~800k rows), in one transaction.
--
-- RUN IT LAST -- after UserMaster, CHA, GRP and One. Quick is live: a message
-- copied by those scripts can carry an AttachmentID uploaded to Quick after an
-- earlier attachments copy (2026-10-22: 1,369 ticket messages pointed at
-- attachments Sila did not have). Copied last, every AttachmentID the copied
-- messages use is here.
--
-- Sequence dbo.Attachment (NEXT VALUE FOR, used by the mobile 'Get ID' and the
-- web Files API) is moved past EVERY AttachmentID in use on Sila, not just this
-- table's: the chat tables (ticket, group, one-to-one -- messages and unread
-- rows), users' and groups' photos, and PLS.V1FileUpload (web uploads, primary
-- key AttachmentID). Otherwise a new upload is given a number an old message
-- already carries. Never moved backwards.
--
-- IMPORTANT - metadata only (migration decision): Quick's files live on a local
-- file server (quick.glcpaints.com:7007). FileURL points at that server; the
-- files themselves are not copied.
--
-- Column mapping (very different shapes between the two systems):
--   - FileName         = Quick's FileID (Sila's own "<id>.<ext>" naming)
--   - FileExtension    = FileID's suffix after the last '.'
--   - FileSize         = '' (Quick does not track file size in this table)
--   - FileURL          = Quick's FileURL if non-empty, else FileLocalURL
--   - CreatedBy        = Quick's CreatedUser
--   - SessionID/GroupID/TicketID/MailID/TaskID = 0 (Quick's attachments span
--     Chat/Ticket/Visit/Task/mail/Product/GATE/etc with no reliable per-row
--     mapping; Sila finds a message's file by AttachmentID)
--
-- No triggers/FKs on this table on Sila101 (checked); DISABLE TRIGGER ALL is
-- there anyway in case one is added.
-- ============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRY

    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON dbo.AttachmentHistory;
    DELETE FROM dbo.AttachmentHistory;

    SET IDENTITY_INSERT dbo.AttachmentHistory ON;

    INSERT INTO dbo.AttachmentHistory (
        ID, AttachmentID, FileName, FileOrginalName, FileExtension,
        FileSize, SessionID, GroupID, TicketID, MailID, FileURL,
        CreatedBy, CreatedDate, TaskID
    )
    SELECT
        ID, AttachmentID,
        FileID AS FileName,
        FileOrginalName,
        CASE WHEN CHARINDEX('.', FileID) = 0 THEN ''
             ELSE RIGHT(FileID, CHARINDEX('.', REVERSE(FileID)) - 1)
        END AS FileExtension,
        '' AS FileSize,
        0 AS SessionID, 0 AS GroupID, 0 AS TicketID, 0 AS MailID,
        ISNULL(NULLIF(FileURL, ''), FileLocalURL) AS FileURL,
        CreatedUser AS CreatedBy,
        CreatedDate,
        0 AS TaskID
    FROM [Quick].[QUK].[AttachmentHistory];

    DECLARE @Copied INT = @@ROWCOUNT;

    SET IDENTITY_INSERT dbo.AttachmentHistory OFF;

    DECLARE @MaxAttHistoryID INT = (SELECT ISNULL(MAX(ID), 0) FROM dbo.AttachmentHistory);
    DBCC CHECKIDENT('dbo.AttachmentHistory', RESEED, @MaxAttHistoryID) WITH NO_INFOMSGS;

    -- every AttachmentID in use on Sila
    DECLARE @MaxInUse BIGINT = (SELECT MAX(v) FROM (
        SELECT ISNULL(MAX(AttachmentID), 0) AS v FROM dbo.AttachmentHistory
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM CHA.TicketChatHistory
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM CHA.TicketUnreadChat
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM GRP.GroupChatHistory
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM GRP.GroupUnreadChat
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM One.OneToOneChatHistory
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM One.OneToOneUnreadChat
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM dbo.UserMaster
        UNION ALL SELECT ISNULL(MAX(AttachmentID), 0) FROM GRP.GroupMaster) x);
    IF OBJECT_ID(N'PLS.V1FileUpload', N'U') IS NOT NULL
    BEGIN
        DECLARE @MaxUpload BIGINT;
        EXEC sp_executesql N'SELECT @m = ISNULL(MAX(AttachmentID), 0) FROM PLS.V1FileUpload',
             N'@m BIGINT OUTPUT', @m = @MaxUpload OUTPUT;
        IF @MaxUpload > @MaxInUse SET @MaxInUse = @MaxUpload;
    END

    -- only ever forward: a number the sequence already gave out stays given
    DECLARE @SeqNow BIGINT = (SELECT CAST(current_value AS BIGINT) FROM sys.sequences
                              WHERE name = N'Attachment' AND schema_id = SCHEMA_ID(N'dbo'));
    DECLARE @RestartAt BIGINT = CASE WHEN @SeqNow >= @MaxInUse + 1 THEN NULL ELSE @MaxInUse + 1 END;
    IF @RestartAt IS NOT NULL
    BEGIN
        DECLARE @RestartSeqSql NVARCHAR(200) =
            N'ALTER SEQUENCE dbo.Attachment RESTART WITH ' + CAST(@RestartAt AS NVARCHAR(20));
        EXEC sp_executesql @RestartSeqSql;
    END;

    -- (ENABLE / DISABLE TRIGGER must follow a ';' -- after a bare END it does not parse)
    ENABLE TRIGGER ALL ON dbo.AttachmentHistory;
    COMMIT TRANSACTION;

    SELECT
        @Copied AS RowsInAttachmentHistory,
        @MaxInUse AS HighestAttachmentIDInUse,
        ISNULL(@RestartAt, @SeqNow) AS AttachmentSequenceNow,
        CASE WHEN @RestartAt IS NULL THEN 'already past every number in use' ELSE 'moved forward' END AS Sequence;

    -- messages that point at an attachment Sila does not have (should be 0)
    SELECT 'Messages without their attachment' AS [Check], x.Source, COUNT(*) AS Messages
    FROM (
        SELECT 'Ticket' AS Source, AttachmentID FROM CHA.TicketChatHistory WHERE AttachmentID <> 0
        UNION ALL SELECT 'Group', AttachmentID FROM GRP.GroupChatHistory WHERE AttachmentID <> 0
        UNION ALL SELECT 'One-to-one', AttachmentID FROM One.OneToOneChatHistory WHERE AttachmentID <> 0
    ) x
    WHERE NOT EXISTS (SELECT 1 FROM dbo.AttachmentHistory a WHERE a.AttachmentID = x.AttachmentID)
    GROUP BY x.Source;

END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    -- SET IDENTITY_INSERT is a session setting that ROLLBACK does not undo
    BEGIN TRY SET IDENTITY_INSERT dbo.AttachmentHistory OFF; END TRY BEGIN CATCH END CATCH;
    SELECT ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
