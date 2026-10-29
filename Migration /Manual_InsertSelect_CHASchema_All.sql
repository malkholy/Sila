-- ============================================================================
-- Manual INSERT...SELECT migration - CHA schema (channels + tickets)
--   Quick.CHA.*  ->  Sila101 CHA.*
-- Run this ON Sila101 in SSMS (it reads the [Quick] database on the same
-- instance; for a linked server replace [Quick] below with its path). Run it
-- after Manual_InsertSelect_UserMaster.sql.
--
-- FULL RELOAD (standing decision): every run deletes all CHA data on Sila and
-- copies it again from Quick. Tickets, channels and messages that exist only
-- on Sila are wiped.
--
-- The Sila-only tables that point at tickets / channels are emptied too
-- (decision 2026-10-28: Quick has no copy of them, and after a reload the same
-- TicketID / ChannelID can be a different ticket or channel):
-- dbo.SilaTicketAssignment, dbo.SilaTicketFlag, dbo.SilaChannelSla,
-- dbo.SilaChannelPurpose; a dbo.SilaReminder linked to a ticket keeps its text
-- and loses the link. Channel SLA and purposes must be entered again after a
-- reload (System Settings > Channels).
--
-- Standing procedure per table: disable triggers -> delete -> copy -> fix
-- identity -> enable triggers, one transaction per table, separated by GO.
-- Stops at the first failure: a failed step records itself in #ChaFailed (a
-- session temp table, so it outlives GO), and every later step checks it and
-- does nothing. Check the result grids; fix and run the whole file again.
--
-- Table mapping:
--   ChannelCategory      -> ChannelCategory      (ID surrogate dropped; ChannelCategoryID identity kept)
--   ChannelMaster        -> ChannelMaster        (Name NULL -> ''; LastTransactionDate/TypeNeeded dropped)
--   ChannelMembers       -> ChannelMembers       (TypeNeeded dropped)
--   ChannelUserFav       -> ChannelUserFavorite  (CreatedDate dropped)
--   TicketHistory        -> TicketHistory        (Type1/Type2/FirstResponseTime/SynSeq dropped;
--                                                 StartDate NULL, StartBy '', TempTicketID 0;
--                                                 RowVer is a rowversion, set by SQL Server)
--   TicketHistoryForward -> TicketHistoryForward (same shape as TicketHistory; RowVer NULL)
--   TicketUnreadChat     -> TicketUnreadChat     (IsSend/SendDate -> IsSent/SentDate; FromUserID and
--                                                 CreatedBy looked up from Quick TicketChatHistory by
--                                                 ChatID; TextStyle '')
--   TicketChatHistory    -> TicketChatHistory    (CreatedBy = FromUserName; LastMaintDate NULL -> 1900-01-01;
--                                                 OrginalChatID/IsEdited etc. copied)
--   TicketMembers        -> TicketMembers        (TotalUnread -> UnreadCount, then recomputed)
--   TicketStateMaster    -> TicketState          SKIPPED: both hold the same 8 rows already.
--
-- NOT migrated (no equivalent table on Sila101): ChannelType, ChannelMuted,
-- ChannelTeamMaster, ChannelUserPermission, TicketFormHistory (empty).
--
-- Known data notes:
--   * Quick TicketMembers has ~27k duplicate (TicketID,UserID) rows and
--     TicketChatHistory has duplicate ChatIDs. Sila has no unique index on
--     them, so they are copied as-is; SilaHistory 'C' is de-duplicated.
--   * TicketHistory's LastChatID / LastMessage are Quick's own (not
--     recomputed): Quick is the live system and keeps them.
--   * Step 10 regenerates SilaHistory RecordType='C' from the migrated data
--     and restarts sequences dbo.ChatTicket and dbo.TicketID past every
--     copied number (TicketHistoryForward and unread rows included).
-- ============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF OBJECT_ID(N'tempdb..#ChaFailed') IS NOT NULL DROP TABLE #ChaFailed;
CREATE TABLE #ChaFailed (Step NVARCHAR(100) NOT NULL);
GO

-- ============================================================================
-- 1) ChannelCategory
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.ChannelCategory DISABLE TRIGGER ALL;
    DELETE FROM CHA.ChannelCategory;
    SET IDENTITY_INSERT CHA.ChannelCategory ON;
    INSERT INTO CHA.ChannelCategory (ChannelCategoryID, CategoryDescription, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate)
    SELECT ChannelCategoryID, CategoryDescription, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate
    FROM [Quick].[CHA].[ChannelCategory];
    SET IDENTITY_INSERT CHA.ChannelCategory OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ChannelCategoryID),0) FROM CHA.ChannelCategory);
    DBCC CHECKIDENT('CHA.ChannelCategory', RESEED, @m) WITH NO_INFOMSGS;
    ALTER TABLE CHA.ChannelCategory ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.ChannelCategory' AS TableName, COUNT(*) AS [RowCount] FROM CHA.ChannelCategory;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    -- SET IDENTITY_INSERT is a session setting that ROLLBACK does not undo
    BEGIN TRY SET IDENTITY_INSERT CHA.ChannelCategory OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'1 ChannelCategory');
    SELECT '1 ChannelCategory' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 2) ChannelMaster
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.ChannelMaster DISABLE TRIGGER ALL;
    DELETE FROM CHA.ChannelMaster;
    SET IDENTITY_INSERT CHA.ChannelMaster ON;
    INSERT INTO CHA.ChannelMaster (ChannelID, Name, CategoryID, InActive, IsPrivate, CreatedDate, CreatedBy, LastMaintDate, LastMaintBy)
    SELECT ChannelID, ISNULL(Name, ''), CategoryID, InActive, IsPrivate, CreatedDate, CreatedBy, LastMaintDate, LastMaintBy
    FROM [Quick].[CHA].[ChannelMaster];
    SET IDENTITY_INSERT CHA.ChannelMaster OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ChannelID),0) FROM CHA.ChannelMaster);
    DBCC CHECKIDENT('CHA.ChannelMaster', RESEED, @m) WITH NO_INFOMSGS;
    ALTER TABLE CHA.ChannelMaster ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.ChannelMaster' AS TableName, COUNT(*) AS [RowCount] FROM CHA.ChannelMaster;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT CHA.ChannelMaster OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'2 ChannelMaster');
    SELECT '2 ChannelMaster' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 3) ChannelMembers (bumps ApplicationTableVersion 4 so the mobile app re-syncs)
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.ChannelMembers DISABLE TRIGGER ALL;
    DELETE FROM CHA.ChannelMembers;
    SET IDENTITY_INSERT CHA.ChannelMembers ON;
    INSERT INTO CHA.ChannelMembers (ID, ChannelID, UserID, IsTeamLeader, IsAdmin, CreatedDate)
    SELECT ID, ChannelID, UserID, IsTeamLeader, IsAdmin, CreatedDate
    FROM [Quick].[CHA].[ChannelMembers];
    SET IDENTITY_INSERT CHA.ChannelMembers OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ID),0) FROM CHA.ChannelMembers);
    DBCC CHECKIDENT('CHA.ChannelMembers', RESEED, @m) WITH NO_INFOMSGS;
    UPDATE dbo.ApplicationTableVersion SET VersionNo = VersionNo + 1 WHERE TableID = 4;
    ALTER TABLE CHA.ChannelMembers ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.ChannelMembers' AS TableName, COUNT(*) AS [RowCount] FROM CHA.ChannelMembers;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT CHA.ChannelMembers OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'3 ChannelMembers');
    SELECT '3 ChannelMembers' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 4) ChannelUserFav -> ChannelUserFavorite
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.ChannelUserFavorite DISABLE TRIGGER ALL;
    DELETE FROM CHA.ChannelUserFavorite;
    SET IDENTITY_INSERT CHA.ChannelUserFavorite ON;
    INSERT INTO CHA.ChannelUserFavorite (ID, ChannelID, UserID)
    SELECT ID, ChannelID, UserID
    FROM [Quick].[CHA].[ChannelUserFav];
    SET IDENTITY_INSERT CHA.ChannelUserFavorite OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ID),0) FROM CHA.ChannelUserFavorite);
    DBCC CHECKIDENT('CHA.ChannelUserFavorite', RESEED, @m) WITH NO_INFOMSGS;
    ALTER TABLE CHA.ChannelUserFavorite ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.ChannelUserFavorite' AS TableName, COUNT(*) AS [RowCount] FROM CHA.ChannelUserFavorite;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT CHA.ChannelUserFavorite OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'4 ChannelUserFavorite');
    SELECT '4 ChannelUserFavorite' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 5) TicketHistory (RowVer is a rowversion: not in the column list)
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.TicketHistory DISABLE TRIGGER ALL;
    DELETE FROM CHA.TicketHistory;
    SET IDENTITY_INSERT CHA.TicketHistory ON;
    INSERT INTO CHA.TicketHistory (ID, TicketID, TicketSubject, TicketChannelID, CreatedDate, CreatedByUser, TicketState, LastMaintDate, LastMaintByUser, EndedDate, EndedBy, HoldBy, HoldDate, ClosedDate, ClosedBy, LastChatID, LastMessage, ForwardDate, ForwardBy, OrginalTicketID, OrginalChannelID, Members, StartDate, StartBy, TempTicketID)
    SELECT ID, TicketID, TicketSubject, TicketChannelID, CreatedDate, CreatedByUser, TicketState, LastMaintDate, LastMaintByUser, EndedDate, EndedBy, HoldBy, HoldDate, ClosedDate, ClosedBy, LastChatID, LastMessage, ForwardDate, ForwardBy, OrginalTicketID, OrginalChannelID, Members, NULL, '', 0
    FROM [Quick].[CHA].[TicketHistory];
    SET IDENTITY_INSERT CHA.TicketHistory OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ID),0) FROM CHA.TicketHistory);
    DBCC CHECKIDENT('CHA.TicketHistory', RESEED, @m) WITH NO_INFOMSGS;
    ALTER TABLE CHA.TicketHistory ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.TicketHistory' AS TableName, COUNT(*) AS [RowCount] FROM CHA.TicketHistory;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT CHA.TicketHistory OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'5 TicketHistory');
    SELECT '5 TicketHistory' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 6) TicketHistoryForward (no identity; RowVer binary(8) left NULL)
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.TicketHistoryForward DISABLE TRIGGER ALL;
    DELETE FROM CHA.TicketHistoryForward;
    INSERT INTO CHA.TicketHistoryForward (ID, TicketID, TicketSubject, TicketChannelID, CreatedDate, CreatedByUser, TicketState, LastMaintDate, LastMaintByUser, EndedDate, EndedBy, HoldBy, HoldDate, ClosedDate, ClosedBy, LastChatID, LastMessage, ForwardDate, ForwardBy, OrginalTicketID, OrginalChannelID, Members, StartDate, StartBy, TempTicketID)
    SELECT ID, TicketID, TicketSubject, TicketChannelID, CreatedDate, CreatedByUser, TicketState, LastMaintDate, LastMaintByUser, EndedDate, EndedBy, HoldBy, HoldDate, ClosedDate, ClosedBy, LastChatID, LastMessage, ForwardDate, ForwardBy, OrginalTicketID, OrginalChannelID, Members, NULL, '', 0
    FROM [Quick].[CHA].[TicketHistoryForward];
    ALTER TABLE CHA.TicketHistoryForward ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.TicketHistoryForward' AS TableName, COUNT(*) AS [RowCount] FROM CHA.TicketHistoryForward;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    INSERT INTO #ChaFailed (Step) VALUES (N'6 TicketHistoryForward');
    SELECT '6 TicketHistoryForward' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 7) TicketUnreadChat
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.TicketUnreadChat DISABLE TRIGGER ALL;
    DELETE FROM CHA.TicketUnreadChat;
    SET IDENTITY_INSERT CHA.TicketUnreadChat ON;
    ;WITH Chat AS (
        SELECT ChatID, FromUserID, FromUserName,
               ROW_NUMBER() OVER (PARTITION BY ChatID ORDER BY ID) AS rn
        FROM [Quick].[CHA].[TicketChatHistory]
    )
    INSERT INTO CHA.TicketUnreadChat (ID, ChatID, ChannelID, TicketID, UserID, Text, TextStyle, AttachmentID, CreatedBy, CreatedDate, FromUserID, IsSent, SentDate, SendingAttempt)
    SELECT u.ID, u.ChatID, u.ChannelID, u.TicketID, u.UserID, u.Text, '', u.AttachmentID,
           ISNULL(c.FromUserName, ''), u.CreatedDate, ISNULL(c.FromUserID, 0), u.IsSend, u.SendDate, u.SendingAttempt
    FROM [Quick].[CHA].[TicketUnreadChat] u
    LEFT JOIN Chat c ON c.ChatID = u.ChatID AND c.rn = 1;
    SET IDENTITY_INSERT CHA.TicketUnreadChat OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ID),0) FROM CHA.TicketUnreadChat);
    DBCC CHECKIDENT('CHA.TicketUnreadChat', RESEED, @m) WITH NO_INFOMSGS;
    ALTER TABLE CHA.TicketUnreadChat ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.TicketUnreadChat' AS TableName, COUNT(*) AS [RowCount] FROM CHA.TicketUnreadChat;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT CHA.TicketUnreadChat OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'7 TicketUnreadChat');
    SELECT '7 TicketUnreadChat' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 8) TicketChatHistory (~1.5M rows)
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.TicketChatHistory DISABLE TRIGGER ALL;
    DELETE FROM CHA.TicketChatHistory;
    SET IDENTITY_INSERT CHA.TicketChatHistory ON;
    INSERT INTO CHA.TicketChatHistory (ID, ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, AttachmentID, ReplayMsgID, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, IsEdited, IsDeleted, OrginalChatID, IsSystem, IsAdmin)
    SELECT ID, ChatID, ChannelID, ISNULL(TicketID, 0), FromUserID, FromUserName, Text, TextStyle, AttachmentID, ReplayMsgID, FromUserName, CreatedDate, LastMaintBy, ISNULL(LastMaintDate, '1900-01-01'), LocalChatID, IsEdited, IsDeleted, OrginalChatID, IsSystem, IsAdmin
    FROM [Quick].[CHA].[TicketChatHistory];
    SET IDENTITY_INSERT CHA.TicketChatHistory OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ID),0) FROM CHA.TicketChatHistory);
    DBCC CHECKIDENT('CHA.TicketChatHistory', RESEED, @m) WITH NO_INFOMSGS;
    ALTER TABLE CHA.TicketChatHistory ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.TicketChatHistory' AS TableName, COUNT(*) AS [RowCount] FROM CHA.TicketChatHistory;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT CHA.TicketChatHistory OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'8 TicketChatHistory');
    SELECT '8 TicketChatHistory' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 9) TicketMembers (RowVer is a rowversion: not in the column list)
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.TicketMembers DISABLE TRIGGER ALL;
    DELETE FROM CHA.TicketMembers;
    SET IDENTITY_INSERT CHA.TicketMembers ON;
    INSERT INTO CHA.TicketMembers (ID, TicketID, ChannelID, UserID, IsCreatedBy, IsTeamLeader, IsAdmin, IsCC, IsInvited, IsLeft, UnreadCount, IsMuted)
    SELECT ID, TicketID, ChannelID, UserID, IsCreatedBy, IsTeamLeader, IsAdmin, IsCC, IsInvited, IsLeft, TotalUnread, IsMuted
    FROM [Quick].[CHA].[TicketMembers];
    SET IDENTITY_INSERT CHA.TicketMembers OFF;
    DECLARE @m INT = (SELECT ISNULL(MAX(ID),0) FROM CHA.TicketMembers);
    DBCC CHECKIDENT('CHA.TicketMembers', RESEED, @m) WITH NO_INFOMSGS;
    ALTER TABLE CHA.TicketMembers ENABLE TRIGGER ALL;
    COMMIT TRANSACTION;
    SELECT 'CHA.TicketMembers' AS TableName, COUNT(*) AS [RowCount] FROM CHA.TicketMembers;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT CHA.TicketMembers OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #ChaFailed (Step) VALUES (N'9 TicketMembers');
    SELECT '9 TicketMembers' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 10) Recompute TicketMembers.UnreadCount from the migrated unread rows,
-- regenerate SilaHistory RecordType='C' (one row per ticket member that has
-- not left; UserID<>0; de-duplicated; Closed/Archieved tickets, TicketState
-- 50/100, are excluded), restart the sequences past every copied number.
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;
    ALTER TABLE CHA.TicketMembers DISABLE TRIGGER ALL;

    UPDATE m
    SET m.UnreadCount = ISNULL((SELECT COUNT(*) FROM CHA.TicketUnreadChat u
                                WHERE u.TicketID = m.TicketID AND u.UserID = m.UserID), 0)
    FROM CHA.TicketMembers m;

    ALTER TABLE CHA.TicketMembers ENABLE TRIGGER ALL;

    DELETE FROM dbo.SilaHistory WHERE RecordType = 'C';

    INSERT INTO dbo.SilaHistory (RecordType, UserID, TicketID, ChannelID, LastChatID, LastMessage, LastMaintDate, TicketState, UnreadMessage, TicketSubject)
    SELECT 'C', g.UserID, g.TicketID, h.TicketChannelID, h.LastChatID, h.LastMessage,
           ISNULL(h.LastMaintDate, '1900-01-01'), h.TicketState, g.UnreadMessage, h.TicketSubject
    FROM (
        SELECT TicketID, UserID, MAX(UnreadCount) AS UnreadMessage
        FROM CHA.TicketMembers
        WHERE UserID <> 0 AND IsLeft = 0
        GROUP BY TicketID, UserID
    ) g
    JOIN CHA.TicketHistory h ON h.TicketID = g.TicketID
    WHERE h.TicketState NOT IN (50, 100);

    -- ChatID from NEXT VALUE FOR dbo.ChatTicket, TicketID from dbo.TicketID
    -- (SEQUENCEs): past every copied number, or the next new message / ticket
    -- collides with a copied one.
    DECLARE @MaxChat INT = (SELECT MAX(v) FROM (
        SELECT ISNULL(MAX(ChatID),0) AS v FROM CHA.TicketChatHistory
        UNION ALL SELECT ISNULL(MAX(ChatID),0) FROM CHA.TicketUnreadChat) x);
    DECLARE @MaxTicket INT = (SELECT MAX(v) FROM (
        SELECT ISNULL(MAX(TicketID),0) AS v FROM CHA.TicketHistory
        UNION ALL SELECT ISNULL(MAX(TicketID),0) FROM CHA.TicketHistoryForward) x);
    DECLARE @sql NVARCHAR(200);
    SET @sql = N'ALTER SEQUENCE dbo.ChatTicket RESTART WITH ' + CAST(@MaxChat + 1 AS NVARCHAR(20));
    EXEC sp_executesql @sql;
    SET @sql = N'ALTER SEQUENCE dbo.TicketID RESTART WITH ' + CAST(@MaxTicket + 1 AS NVARCHAR(20));
    EXEC sp_executesql @sql;

    COMMIT TRANSACTION;

    SELECT (SELECT COUNT(*) FROM dbo.SilaHistory WHERE RecordType = 'C') AS SilaHistory_C,
           @MaxChat + 1 AS ChatTicketRestartedAt, @MaxTicket + 1 AS TicketIDRestartedAt;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    INSERT INTO #ChaFailed (Step) VALUES (N'10 SilaHistory C / sequences');
    SELECT '10 SilaHistory C / sequences' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ============================================================================
-- 11) Sila-only rows that point at tickets / channels: emptied.
-- ============================================================================
IF EXISTS (SELECT 1 FROM #ChaFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @Assignments INT, @Flags INT, @Reminders INT, @Sla INT, @Purpose INT;

    DELETE FROM dbo.SilaTicketAssignment;  SET @Assignments = @@ROWCOUNT;
    DELETE FROM dbo.SilaTicketFlag;        SET @Flags = @@ROWCOUNT;
    DELETE FROM dbo.SilaChannelSla;        SET @Sla = @@ROWCOUNT;
    DELETE FROM dbo.SilaChannelPurpose;    SET @Purpose = @@ROWCOUNT;

    -- a reminder is the user's own note: it stays, without the ticket link
    UPDATE dbo.SilaReminder
    SET LinkKind = NULL, LinkID = NULL, ChatID = NULL, LastMaintDate = GETDATE()
    WHERE LinkKind = 'ticket';
    SET @Reminders = @@ROWCOUNT;

    COMMIT TRANSACTION;

    SELECT '11 Sila-only rows emptied' AS Step, @Assignments AS Assignments, @Flags AS Flags,
           @Reminders AS RemindersUnlinked, @Sla AS ChannelSla, @Purpose AS ChannelPurpose;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    INSERT INTO #ChaFailed (Step) VALUES (N'11 Sila-only rows');
    SELECT '11 Sila-only rows' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- Which step stopped the run, if any.
SELECT CASE WHEN EXISTS (SELECT 1 FROM #ChaFailed) THEN N'STOPPED at: ' + (SELECT TOP (1) Step FROM #ChaFailed)
            ELSE N'CHA schema: all steps OK' END AS Result;
DROP TABLE #ChaFailed;
GO
