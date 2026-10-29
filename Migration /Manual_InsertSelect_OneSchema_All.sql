-- ============================================================================
-- Manual INSERT...SELECT migration: Quick -> Sila101, full One schema
-- (one-to-one chat). Run this ON Sila101 in SSMS (it reads the [Quick]
-- database on the same instance; for a linked server replace [Quick] below
-- with its path, e.g. [QUICKSERVER].[Quick].[ONE].[OneChatSession]).
--
-- FULL RELOAD (standing decision): every run deletes all One-schema data on
-- Sila and copies it again from Quick.
--
-- PREREQUISITE: dbo.UserMaster migrated first (step 2 looks up CreatedBy in
-- it), and dbo.AttachmentHistory (messages carry AttachmentIDs).
--
--   1) OneChatSession        -> One.OneChatSession
--   2) OneChatUnreadHistory  -> One.OneToOneUnreadChat
--   3) OneChatHistory        -> One.OneToOneChatHistory (~637k rows), then in
--      the same transaction: OneChatSession's LastChatID/LastMessage/
--      LastMaintDate recomputed from the copied messages, SilaHistory 'O'
--      regenerated, sequence dbo.ChatOneToOne moved past every copied ChatID.
--
-- Triggers: every table's triggers are switched off BEFORE its DELETE and back
-- on after the copy (DISABLE/ENABLE TRIGGER ALL). They maintain unread rows,
-- SilaHistory and OneChatSession row by row and corrupt them on a bulk delete
-- or insert (a real incident in the first run of this migration).
--
-- SilaHistory 'O' is NOT copied from Quick's QuickHistory: it is a summary
-- table, so it is rebuilt from Sila's just-copied data, the way
-- [One].[TriggerOneChatHistoryAfterInsert] builds it. Only RecordType='O' is
-- touched. Manual_Regenerate_SilaHistory_O.sql does the same on its own.
--
-- Stops at the first failure: a failed step records itself in #OneFailed (a
-- session temp table, so it outlives GO), and every later step checks it and
-- does nothing. Check the result grids; fix and run the whole file again.
-- ============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF OBJECT_ID(N'tempdb..#OneFailed') IS NOT NULL DROP TABLE #OneFailed;
CREATE TABLE #OneFailed (Step NVARCHAR(100) NOT NULL);
GO

-- ----------------------------------------------------------------------------
-- 1) OneChatSession (Quick.ONE.OneChatSession -> One.OneChatSession), ~7k rows.
--    LastMintBy (Quick's spelling) -> LastMaintBy. TotalMessages dropped.
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #OneFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON One.OneChatSession;
    DELETE FROM One.OneChatSession;

    SET IDENTITY_INSERT One.OneChatSession ON;

    INSERT INTO One.OneChatSession (
        SessionID, UserID1, UserID2, CreatedBy, CreatedDate,
        LastMaintBy, LastMaintDate, LastChatID, LastMessage,
        UserName1, UserName2
    )
    SELECT
        SessionID, UserID1, UserID2, CreatedBy, CreatedDate,
        LastMintBy AS LastMaintBy, LastMaintDate, LastChatID, LastMessage,
        UserName1, UserName2
    FROM [Quick].[ONE].[OneChatSession];

    SET IDENTITY_INSERT One.OneChatSession OFF;

    DECLARE @MaxSessionID INT = (SELECT ISNULL(MAX(SessionID), 0) FROM One.OneChatSession);
    DBCC CHECKIDENT('One.OneChatSession', RESEED, @MaxSessionID) WITH NO_INFOMSGS;

    ENABLE TRIGGER ALL ON One.OneChatSession;
    COMMIT TRANSACTION;

    SELECT 'OneChatSession' AS TableName, COUNT(*) AS [RowCount] FROM One.OneChatSession;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    -- SET IDENTITY_INSERT is a session setting that ROLLBACK does not undo;
    -- left ON it blocks IDENTITY_INSERT on every other table in this session.
    BEGIN TRY SET IDENTITY_INSERT One.OneChatSession OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #OneFailed (Step) VALUES (N'OneChatSession');
    SELECT 'OneChatSession' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ----------------------------------------------------------------------------
-- 2) OneChatUnreadHistory (Quick.ONE.OneChatUnreadHistory -> One.OneToOneUnreadChat).
--    CreatedBy = the sender's Username (dbo.UserMaster). IsSend/SendDate ->
--    IsSent/SentDate. [One].[TrgOneChatHistoryafterDelete] (AFTER DELETE) would
--    update OneToOneChatHistory on the bulk delete -- off before it.
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #OneFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON One.OneToOneUnreadChat;
    DELETE FROM One.OneToOneUnreadChat;

    SET IDENTITY_INSERT One.OneToOneUnreadChat ON;

    INSERT INTO One.OneToOneUnreadChat (
        ID, ChatID, SessionID, UserID, Text, TextStyle, AttachmentID,
        CreatedBy, CreatedDate, FromUserID, IsSent, SentDate, SendingAttempt
    )
    SELECT
        q.ID, q.ChatID, q.SessionID, q.UserID, q.Text, q.TextStyle, q.AttachmentID,
        ISNULL(um.Username, CAST(q.FromUserID AS NVARCHAR(50))) AS CreatedBy,
        q.CreatedDate, q.FromUserID, q.IsSend AS IsSent, q.SendDate AS SentDate,
        q.SendingAttempt
    FROM [Quick].[ONE].[OneChatUnreadHistory] q
    LEFT JOIN dbo.UserMaster um ON um.UserID = q.FromUserID;

    SET IDENTITY_INSERT One.OneToOneUnreadChat OFF;

    DECLARE @MaxUnreadID INT = (SELECT ISNULL(MAX(ID), 0) FROM One.OneToOneUnreadChat);
    DBCC CHECKIDENT('One.OneToOneUnreadChat', RESEED, @MaxUnreadID) WITH NO_INFOMSGS;

    ENABLE TRIGGER ALL ON One.OneToOneUnreadChat;
    COMMIT TRANSACTION;

    SELECT 'OneToOneUnreadChat' AS TableName, COUNT(*) AS [RowCount] FROM One.OneToOneUnreadChat;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT One.OneToOneUnreadChat OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #OneFailed (Step) VALUES (N'OneToOneUnreadChat');
    SELECT 'OneToOneUnreadChat' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ----------------------------------------------------------------------------
-- 3) OneChatHistory (Quick.ONE.OneChatHistory -> One.OneToOneChatHistory),
--    ~637k rows. CreatedBy = FromUserName. LastMaintDate NULL on Quick
--    (~247k rows) -> '1900-01-01' (NOT NULL on Sila).
--    [One].[TriggerOneChatHistoryAfterInsert] maintains unread rows,
--    SilaHistory and OneChatSession per message -- off for the whole copy.
--    A ChatID Quick has twice (a double-sent message) is copied once: the
--    earliest row (lowest ID); the count dropped is shown.
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #OneFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON One.OneToOneChatHistory;
    DELETE FROM One.OneToOneChatHistory;

    SET IDENTITY_INSERT One.OneToOneChatHistory ON;

    ;WITH Deduped AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY ChatID ORDER BY ID) AS rn
        FROM [Quick].[ONE].[OneChatHistory]
    )
    INSERT INTO One.OneToOneChatHistory (
        ID, ChatID, SessionID, FromUserID, ToUserID, FromUserName,
        ToUserName, Text, TextStyle, AttachmentID, ReplayMsgID,
        CreatedBy, CreatedDate, LastMaintBy, LastMaintDate,
        LocalChatID, IsEdited, IsDeleted, OrginalChatID, IsSeen, SeenDate
    )
    SELECT
        ID, ChatID, SessionID, FromUserID, ToUserID, FromUserName,
        ToUserName, Text, TextStyle, AttachmentID, ReplayMsgID,
        FromUserName AS CreatedBy, CreatedDate, LastMaintBy,
        ISNULL(LastMaintDate, '1900-01-01') AS LastMaintDate,
        LocalChatID, IsEdited, IsDeleted, OrginalChatID, IsSeen, SeenDate
    FROM Deduped
    WHERE rn = 1;

    DECLARE @Copied INT = @@ROWCOUNT;

    SET IDENTITY_INSERT One.OneToOneChatHistory OFF;

    -- OneChatSession's last message from the copied messages (newest ChatID
    -- per session), not Quick's own snapshot -- what the trigger would have set.
    ;WITH LatestChat AS (
        SELECT SessionID, ChatID, Text, CreatedDate,
               ROW_NUMBER() OVER (PARTITION BY SessionID ORDER BY ChatID DESC) AS rn
        FROM One.OneToOneChatHistory
    )
    UPDATE ocs
    SET ocs.LastChatID    = lc.ChatID,
        ocs.LastMessage   = lc.Text,
        ocs.LastMaintDate = lc.CreatedDate
    FROM One.OneChatSession ocs
    INNER JOIN LatestChat lc ON lc.SessionID = ocs.SessionID AND lc.rn = 1;

    -- SilaHistory 'O': one row per (session, participant), as the trigger makes
    -- it; UnreadMessage counted from OneToOneUnreadChat (step 2). Other columns
    -- take SilaHistory's defaults (SynSequence = NEXT VALUE FOR dbo.SynSeq).
    -- [dbo].[TrgSilaHistoryafterUpdate] fires on UPDATE only.
    DELETE FROM dbo.SilaHistory WHERE RecordType = 'O';

    INSERT INTO dbo.SilaHistory (
        RecordType, SessionID, UserID, LastChatID, LastMessage,
        LastMaintDate, OtherUserID, UnreadMessage
    )
    SELECT
        'O' AS RecordType,
        sh.SessionID,
        sh.UserID,
        sh.LastChatID,
        sh.LastMessage,
        ISNULL(sh.LastMaintDate, '1900-01-01') AS LastMaintDate,  -- nullable on OneChatSession, NOT NULL on SilaHistory
        sh.OtherUserID,
        (SELECT COUNT(*) FROM One.OneToOneUnreadChat u
         WHERE u.SessionID = sh.SessionID AND u.UserID = sh.UserID) AS UnreadMessage
    FROM (
        -- CK_SilaHistory_UserID_NotZero: a session with a 0 participant
        -- (legacy data) gets no row for that side.
        SELECT SessionID, UserID1 AS UserID, UserID2 AS OtherUserID,
               LastChatID, LastMessage, LastMaintDate
        FROM One.OneChatSession
        WHERE UserID1 <> 0

        UNION ALL

        -- UserID1 <> UserID2: a self-chat session gets one row, not two.
        SELECT SessionID, UserID2 AS UserID, UserID1 AS OtherUserID,
               LastChatID, LastMessage, LastMaintDate
        FROM One.OneChatSession
        WHERE UserID2 <> 0 AND UserID1 <> UserID2
    ) sh;

    DECLARE @MaxHistoryID INT = (SELECT ISNULL(MAX(ID), 0) FROM One.OneToOneChatHistory);
    DBCC CHECKIDENT('One.OneToOneChatHistory', RESEED, @MaxHistoryID) WITH NO_INFOMSGS;

    -- ChatID comes from NEXT VALUE FOR dbo.ChatOneToOne (a SEQUENCE): past every
    -- copied ChatID -- messages and unread rows -- or the next new message on
    -- Sila collides with a copied one.
    DECLARE @MaxChatID INT = (SELECT MAX(v) FROM (
        SELECT ISNULL(MAX(ChatID), 0) AS v FROM One.OneToOneChatHistory
        UNION ALL SELECT ISNULL(MAX(ChatID), 0) FROM One.OneToOneUnreadChat) x);
    DECLARE @RestartSeqSql NVARCHAR(200) =
        N'ALTER SEQUENCE dbo.ChatOneToOne RESTART WITH ' + CAST(@MaxChatID + 1 AS NVARCHAR(20));
    EXEC sp_executesql @RestartSeqSql;

    ENABLE TRIGGER ALL ON One.OneToOneChatHistory;
    COMMIT TRANSACTION;

    SELECT 'OneToOneChatHistory' AS TableName, @Copied AS [RowCount],
           (SELECT COUNT(*) FROM [Quick].[ONE].[OneChatHistory]) - @Copied AS DuplicateChatIDsDropped,
           @MaxChatID + 1 AS ChatOneToOneSequenceRestartedAt;
    SELECT 'SilaHistory (O)' AS TableName, COUNT(*) AS [RowCount] FROM dbo.SilaHistory WHERE RecordType = 'O';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT One.OneToOneChatHistory OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #OneFailed (Step) VALUES (N'OneToOneChatHistory / SilaHistory');
    SELECT 'OneToOneChatHistory / SilaHistory' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- Which step stopped the run, if any.
SELECT CASE WHEN EXISTS (SELECT 1 FROM #OneFailed) THEN N'STOPPED at: ' + (SELECT TOP (1) Step FROM #OneFailed)
            ELSE N'One schema: all steps OK' END AS Result;
DROP TABLE #OneFailed;
GO
