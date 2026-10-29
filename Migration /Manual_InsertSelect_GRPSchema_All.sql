-- ============================================================================
-- Manual INSERT...SELECT migration: Quick -> Sila101, full GRP schema
-- (group chat). Run this ON Sila101 in SSMS (it reads the [Quick] database on
-- the same instance; for a linked server replace [Quick] below with its path,
-- e.g. [QUICKSERVER].[Quick].[GRP].[GroupMaster]). Run it after
-- Manual_InsertSelect_UserMaster.sql.
--
-- FULL RELOAD (standing decision): every run deletes all GRP data on Sila and
-- copies it again from Quick. ONE exception, Sila's broadcast groups:
--
--   A broadcast group (dbo.SilaGroupType) made in Sila does not exist in
--   Quick -- e.g. 590 'GLC Public' (2026-10-23). Step 0 saves it (group,
--   members, messages, unread rows) before anything is deleted, and step 4
--   puts it back after Quick's data is in. If Quick now uses its GroupID or
--   its ChatIDs, it gets new numbers above Quick's (its messages keep their
--   order; replies / edits inside it follow; dbo.SilaGroupType follows the
--   GroupID). A Quick group made a broadcast group in Sila comes back from
--   Quick with its own GroupID, so its SilaGroupType row simply still works.
--   At the end dbo.SilaSyncBroadcastGroup makes every broadcast group's
--   members = the active users again.
--
--   0) save Sila's own broadcast groups      (#Keep* temp tables)
--   1) GroupMaster      ~400 rows
--   2) GroupMembers     ~2.7k rows
--   3) GroupUnreadChat  ~14k rows
--   4) GroupChatHistory ~128k rows, then in the same transaction: the kept
--      broadcast groups put back; GroupMaster LastChatID/LastMessage/
--      LastMaintDate and GroupMembers.UnreadCount recomputed from the copied
--      data; SilaHistory 'G' regenerated; sequence dbo.ChatGroup moved past
--      every ChatID.
--   5) dbo.SilaSyncBroadcastGroup
--
-- Triggers: every table's triggers are switched off BEFORE its DELETE and
-- back on after the copy (DISABLE/ENABLE TRIGGER ALL -- GroupUnreadChat's
-- delete trigger is stored with a trailing space in its name, so it is never
-- named). GroupChatHistory: TrgGroupChatHistoryafterInsertUpdate;
-- GroupMembers: TrgGroupMemoryAfterInsert / AfterDelete (SilaHistory 'G');
-- GroupUnreadChat: TrgGroupUnreadChatafterDelete. Left on, they rewrite
-- unread rows, GroupMaster, GroupMembers and SilaHistory row by row.
--
-- SilaHistory 'G' is NOT copied from Quick: it is a summary table, rebuilt
-- from Sila's just-copied data. Only RecordType='G' is touched.
--
-- Mapping notes:
--   - GroupMaster: GroupID is the identity (no separate ID). Sila-only
--     AttachmentID (group photo) = 0.
--   - GroupChatHistory: CreatedBy = FromUserName. LastMaintDate NULL on Quick
--     -> '1900-01-01'. A ChatID Quick has twice (a double-sent message; 25
--     ChatIDs / 41 rows seen) is copied once, the earliest row: Sila's ChatID
--     has a unique index.
--   - GroupUnreadChat: Quick has no sender column; FromUserID / CreatedBy come
--     from Quick's GroupChatHistory by ChatID. TextStyle = ''. IsSend/SendDate
--     -> IsSent/SentDate.
--
-- Stops at the first failure: a failed step records itself in #GrpFailed (a
-- session temp table, so it outlives GO), and every later step checks it and
-- does nothing. Check the result grids; fix and run the whole file again.
-- ============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF OBJECT_ID(N'tempdb..#GrpFailed') IS NOT NULL DROP TABLE #GrpFailed;
CREATE TABLE #GrpFailed (Step NVARCHAR(100) NOT NULL);
GO

-- ----------------------------------------------------------------------------
-- 0) Sila's own broadcast groups: a SilaGroupType group that Quick does not
--    have (no Quick group with the same GroupID and CreatedDate).
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #GrpFailed) RETURN;
BEGIN TRY
    IF OBJECT_ID(N'tempdb..#KeepGroup')   IS NOT NULL DROP TABLE #KeepGroup;
    IF OBJECT_ID(N'tempdb..#KeepMembers') IS NOT NULL DROP TABLE #KeepMembers;
    IF OBJECT_ID(N'tempdb..#KeepUnread')  IS NOT NULL DROP TABLE #KeepUnread;
    IF OBJECT_ID(N'tempdb..#KeepHistory') IS NOT NULL DROP TABLE #KeepHistory;

    SELECT g.GroupID, g.Name, g.Inactive, g.ChatIsLocked, g.LastChatID, g.LastMessage, g.TotalMessages,
           g.CreatedBy, g.CreatedDate, g.LastMaintBy, g.LastMaintDate, g.AttachmentID
    INTO #KeepGroup
    FROM GRP.GroupMaster g
    JOIN dbo.SilaGroupType t ON t.GroupID = g.GroupID
    WHERE NOT EXISTS (SELECT 1 FROM [Quick].[GRP].[GroupMaster] q
                      WHERE q.GroupID = g.GroupID AND q.CreatedDate = g.CreatedDate);

    SELECT m.GroupID, m.UserID, m.IsAdmin, m.CreatedDate, m.UnreadCount, m.IsCreated
    INTO #KeepMembers
    FROM GRP.GroupMembers m WHERE m.GroupID IN (SELECT GroupID FROM #KeepGroup);

    SELECT u.ChatID, u.GroupID, u.UserID, u.Text, u.TextStyle, u.AttachmentID, u.CreatedBy, u.CreatedDate,
           u.FromUserID, u.IsSent, u.SentDate, u.SendingAttempt
    INTO #KeepUnread
    FROM GRP.GroupUnreadChat u WHERE u.GroupID IN (SELECT GroupID FROM #KeepGroup);

    SELECT h.ID, h.ChatID, h.GroupID, h.FromUserID, h.FromUserName, h.Text, h.TextStyle, h.AttachmentID,
           h.ReplayMsgID, h.CreatedBy, h.CreatedDate, h.LastMaintBy, h.LastMaintDate, h.LocalChatID,
           h.IsEdited, h.IsDeleted, h.OrginalChatID, h.IsSystem
    INTO #KeepHistory
    FROM GRP.GroupChatHistory h WHERE h.GroupID IN (SELECT GroupID FROM #KeepGroup);

    SELECT 'Kept broadcast groups' AS Step, g.GroupID, g.Name,
           (SELECT COUNT(*) FROM #KeepMembers m WHERE m.GroupID = g.GroupID) AS Members,
           (SELECT COUNT(*) FROM #KeepHistory h WHERE h.GroupID = g.GroupID) AS Messages,
           (SELECT COUNT(*) FROM #KeepUnread u WHERE u.GroupID = g.GroupID) AS Unread
    FROM #KeepGroup g;
END TRY
BEGIN CATCH
    INSERT INTO #GrpFailed (Step) VALUES (N'Save broadcast groups');
    SELECT 'Save broadcast groups' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ----------------------------------------------------------------------------
-- 1) GroupMaster (Quick.GRP.GroupMaster -> GRP.GroupMaster). No triggers.
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #GrpFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON GRP.GroupMaster;
    DELETE FROM GRP.GroupMaster;

    SET IDENTITY_INSERT GRP.GroupMaster ON;

    INSERT INTO GRP.GroupMaster (
        GroupID, Name, Inactive, ChatIsLocked, LastChatID, LastMessage,
        TotalMessages, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate,
        AttachmentID
    )
    SELECT
        GroupID, Name, Inactive, ChatIsLocked, LastChatID, LastMessage,
        TotalMessages, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate,
        0 AS AttachmentID
    FROM [Quick].[GRP].[GroupMaster];

    SET IDENTITY_INSERT GRP.GroupMaster OFF;

    DECLARE @MaxGroupID INT = (SELECT ISNULL(MAX(GroupID), 0) FROM GRP.GroupMaster);
    DBCC CHECKIDENT('GRP.GroupMaster', RESEED, @MaxGroupID) WITH NO_INFOMSGS;

    ENABLE TRIGGER ALL ON GRP.GroupMaster;
    COMMIT TRANSACTION;

    SELECT 'GroupMaster' AS TableName, COUNT(*) AS [RowCount] FROM GRP.GroupMaster;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    -- SET IDENTITY_INSERT is a session setting that ROLLBACK does not undo;
    -- left ON it blocks IDENTITY_INSERT on every other table in this session.
    BEGIN TRY SET IDENTITY_INSERT GRP.GroupMaster OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #GrpFailed (Step) VALUES (N'GroupMaster');
    SELECT 'GroupMaster' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ----------------------------------------------------------------------------
-- 2) GroupMembers (Quick.GRP.GroupMembers -> GRP.GroupMembers). Same columns.
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #GrpFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON GRP.GroupMembers;
    DELETE FROM GRP.GroupMembers;

    SET IDENTITY_INSERT GRP.GroupMembers ON;

    INSERT INTO GRP.GroupMembers (
        ID, GroupID, UserID, IsAdmin, CreatedDate, UnreadCount, IsCreated
    )
    SELECT
        ID, GroupID, UserID, IsAdmin, CreatedDate, UnreadCount, IsCreated
    FROM [Quick].[GRP].[GroupMembers];

    SET IDENTITY_INSERT GRP.GroupMembers OFF;

    DECLARE @MaxMemberID INT = (SELECT ISNULL(MAX(ID), 0) FROM GRP.GroupMembers);
    DBCC CHECKIDENT('GRP.GroupMembers', RESEED, @MaxMemberID) WITH NO_INFOMSGS;

    ENABLE TRIGGER ALL ON GRP.GroupMembers;
    COMMIT TRANSACTION;

    SELECT 'GroupMembers' AS TableName, COUNT(*) AS [RowCount] FROM GRP.GroupMembers;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT GRP.GroupMembers OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #GrpFailed (Step) VALUES (N'GroupMembers');
    SELECT 'GroupMembers' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ----------------------------------------------------------------------------
-- 3) GroupUnreadChat (Quick.GRP.GroupUnreadChat -> GRP.GroupUnreadChat).
--    FromUserID / CreatedBy = the sender in Quick's GroupChatHistory (by
--    ChatID, earliest row of a doubled ChatID so the join cannot fan out).
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #GrpFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON GRP.GroupUnreadChat;
    DELETE FROM GRP.GroupUnreadChat;

    SET IDENTITY_INSERT GRP.GroupUnreadChat ON;

    INSERT INTO GRP.GroupUnreadChat (
        ID, ChatID, GroupID, UserID, Text, TextStyle, AttachmentID,
        CreatedBy, CreatedDate, FromUserID, IsSent, SentDate, SendingAttempt
    )
    SELECT
        q.ID, q.ChatID, q.GroupID, q.UserID, q.Text, '' AS TextStyle, q.AttachmentID,
        ISNULL(gch.FromUserName, '') AS CreatedBy, q.CreatedDate,
        ISNULL(gch.FromUserID, 0) AS FromUserID,
        q.IsSend AS IsSent, q.SendDate AS SentDate, q.SendingAttempt
    FROM [Quick].[GRP].[GroupUnreadChat] q
    LEFT JOIN (
        SELECT ChatID, FromUserID, FromUserName,
               ROW_NUMBER() OVER (PARTITION BY ChatID ORDER BY ID) AS rn
        FROM [Quick].[GRP].[GroupChatHistory]
    ) gch ON gch.ChatID = q.ChatID AND gch.rn = 1;

    SET IDENTITY_INSERT GRP.GroupUnreadChat OFF;

    DECLARE @MaxUnreadID INT = (SELECT ISNULL(MAX(ID), 0) FROM GRP.GroupUnreadChat);
    DBCC CHECKIDENT('GRP.GroupUnreadChat', RESEED, @MaxUnreadID) WITH NO_INFOMSGS;

    ENABLE TRIGGER ALL ON GRP.GroupUnreadChat;
    COMMIT TRANSACTION;

    SELECT 'GroupUnreadChat' AS TableName, COUNT(*) AS [RowCount] FROM GRP.GroupUnreadChat;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT GRP.GroupUnreadChat OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #GrpFailed (Step) VALUES (N'GroupUnreadChat');
    SELECT 'GroupUnreadChat' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ----------------------------------------------------------------------------
-- 4) GroupChatHistory (Quick.GRP.GroupChatHistory -> GRP.GroupChatHistory),
--    then the kept broadcast groups, the recomputed totals, SilaHistory 'G'
--    and the ChatGroup sequence -- one transaction, triggers off throughout.
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #GrpFailed) RETURN;
BEGIN TRY
    BEGIN TRANSACTION;

    DISABLE TRIGGER ALL ON GRP.GroupChatHistory;
    DISABLE TRIGGER ALL ON GRP.GroupMembers;
    DISABLE TRIGGER ALL ON GRP.GroupUnreadChat;
    DELETE FROM GRP.GroupChatHistory;

    SET IDENTITY_INSERT GRP.GroupChatHistory ON;

    ;WITH DedupedHistory AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY ChatID ORDER BY ID) AS rn
        FROM [Quick].[GRP].[GroupChatHistory]
    )
    INSERT INTO GRP.GroupChatHistory (
        ID, ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle,
        AttachmentID, ReplayMsgID, CreatedBy, CreatedDate, LastMaintBy,
        LastMaintDate, LocalChatID, IsEdited, IsDeleted, OrginalChatID, IsSystem
    )
    SELECT
        ID, ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle,
        AttachmentID, ReplayMsgID, FromUserName AS CreatedBy, CreatedDate,
        LastMaintBy, ISNULL(LastMaintDate, '1900-01-01') AS LastMaintDate,
        LocalChatID, IsEdited, IsDeleted, OrginalChatID, IsSystem
    FROM DedupedHistory
    WHERE rn = 1;

    DECLARE @Copied INT = @@ROWCOUNT;

    SET IDENTITY_INSERT GRP.GroupChatHistory OFF;

    -- ---- the kept broadcast groups back ------------------------------------
    -- GroupID: its own, unless Quick now uses it -> next free above everything.
    DECLARE @GroupBase INT = (SELECT MAX(v) FROM (
        SELECT ISNULL(MAX(GroupID), 0) AS v FROM GRP.GroupMaster
        UNION ALL SELECT ISNULL(MAX(GroupID), 0) FROM #KeepGroup) x);
    DECLARE @GMap TABLE (OldID INT PRIMARY KEY, NewID INT NOT NULL);
    INSERT INTO @GMap (OldID, NewID)
    SELECT k.GroupID,
           CASE WHEN EXISTS (SELECT 1 FROM GRP.GroupMaster g WHERE g.GroupID = k.GroupID)
                THEN @GroupBase + ROW_NUMBER() OVER (ORDER BY k.GroupID) ELSE k.GroupID END
    FROM #KeepGroup k;

    -- ChatIDs: their own, unless one is now used by Quick -> all of them
    -- renumbered above everything, in their original order.
    DECLARE @ChatBase INT = (SELECT MAX(v) FROM (
        SELECT ISNULL(MAX(ChatID), 0) AS v FROM GRP.GroupChatHistory
        UNION ALL SELECT ISNULL(MAX(ChatID), 0) FROM GRP.GroupUnreadChat
        UNION ALL SELECT ISNULL(MAX(ChatID), 0) FROM #KeepHistory) x);
    DECLARE @Renumber BIT = CASE WHEN EXISTS (
        SELECT 1 FROM #KeepHistory k
        WHERE EXISTS (SELECT 1 FROM GRP.GroupChatHistory h WHERE h.ChatID = k.ChatID)
           OR EXISTS (SELECT 1 FROM GRP.GroupUnreadChat u WHERE u.ChatID = k.ChatID)) THEN 1 ELSE 0 END;
    DECLARE @CMap TABLE (OldID INT PRIMARY KEY, NewID INT NOT NULL);
    INSERT INTO @CMap (OldID, NewID)
    SELECT c.ChatID, CASE WHEN @Renumber = 1 THEN @ChatBase + ROW_NUMBER() OVER (ORDER BY c.ChatID) ELSE c.ChatID END
    FROM (SELECT DISTINCT ChatID FROM #KeepHistory) c;

    SET IDENTITY_INSERT GRP.GroupMaster ON;
    INSERT INTO GRP.GroupMaster (
        GroupID, Name, Inactive, ChatIsLocked, LastChatID, LastMessage,
        TotalMessages, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, AttachmentID
    )
    SELECT gm.NewID, k.Name, k.Inactive, k.ChatIsLocked, ISNULL(cm.NewID, k.LastChatID), k.LastMessage,
           k.TotalMessages, k.CreatedBy, k.CreatedDate, k.LastMaintBy, k.LastMaintDate, k.AttachmentID
    FROM #KeepGroup k
    JOIN @GMap gm ON gm.OldID = k.GroupID
    LEFT JOIN @CMap cm ON cm.OldID = k.LastChatID;
    SET IDENTITY_INSERT GRP.GroupMaster OFF;

    -- new row IDs (identity); members only for users still in Sila
    INSERT INTO GRP.GroupMembers (GroupID, UserID, IsAdmin, CreatedDate, UnreadCount, IsCreated)
    SELECT gm.NewID, m.UserID, m.IsAdmin, m.CreatedDate, m.UnreadCount, m.IsCreated
    FROM #KeepMembers m
    JOIN @GMap gm ON gm.OldID = m.GroupID
    WHERE EXISTS (SELECT 1 FROM dbo.UserMaster u WHERE u.UserID = m.UserID);

    INSERT INTO GRP.GroupChatHistory (
        ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle,
        AttachmentID, ReplayMsgID, CreatedBy, CreatedDate, LastMaintBy,
        LastMaintDate, LocalChatID, IsEdited, IsDeleted, OrginalChatID, IsSystem
    )
    SELECT cm.NewID, gm.NewID, h.FromUserID, h.FromUserName, h.Text, h.TextStyle,
           h.AttachmentID, ISNULL(rp.NewID, h.ReplayMsgID), h.CreatedBy, h.CreatedDate, h.LastMaintBy,
           h.LastMaintDate, h.LocalChatID, h.IsEdited, h.IsDeleted, ISNULL(og.NewID, h.OrginalChatID), h.IsSystem
    FROM #KeepHistory h
    JOIN @GMap gm ON gm.OldID = h.GroupID
    JOIN @CMap cm ON cm.OldID = h.ChatID
    LEFT JOIN @CMap rp ON rp.OldID = h.ReplayMsgID
    LEFT JOIN @CMap og ON og.OldID = h.OrginalChatID
    ORDER BY h.ID;

    INSERT INTO GRP.GroupUnreadChat (
        ChatID, GroupID, UserID, Text, TextStyle, AttachmentID,
        CreatedBy, CreatedDate, FromUserID, IsSent, SentDate, SendingAttempt
    )
    SELECT ISNULL(cm.NewID, u.ChatID), gm.NewID, u.UserID, u.Text, u.TextStyle, u.AttachmentID,
           u.CreatedBy, u.CreatedDate, u.FromUserID, u.IsSent, u.SentDate, u.SendingAttempt
    FROM #KeepUnread u
    JOIN @GMap gm ON gm.OldID = u.GroupID
    LEFT JOIN @CMap cm ON cm.OldID = u.ChatID
    WHERE EXISTS (SELECT 1 FROM dbo.UserMaster x WHERE x.UserID = u.UserID);

    UPDATE t SET t.GroupID = gm.NewID
    FROM dbo.SilaGroupType t
    JOIN @GMap gm ON gm.OldID = t.GroupID
    WHERE gm.NewID <> gm.OldID;

    -- ---- totals from the copied data ---------------------------------------
    -- GroupMaster's last message = the newest ChatID per group.
    ;WITH LatestChat AS (
        SELECT GroupID, ChatID, Text, CreatedDate,
               ROW_NUMBER() OVER (PARTITION BY GroupID ORDER BY ChatID DESC) AS rn
        FROM GRP.GroupChatHistory
    )
    UPDATE gm
    SET gm.LastChatID    = lc.ChatID,
        gm.LastMessage   = lc.Text,
        gm.LastMaintDate = lc.CreatedDate
    FROM GRP.GroupMaster gm
    INNER JOIN LatestChat lc ON lc.GroupID = gm.GroupID AND lc.rn = 1;

    UPDATE gmem
    SET gmem.UnreadCount = ISNULL(
        (SELECT COUNT(*) FROM GRP.GroupUnreadChat guc
         WHERE guc.GroupID = gmem.GroupID AND guc.UserID = gmem.UserID), 0)
    FROM GRP.GroupMembers gmem;

    -- SilaHistory 'G': one row per (group, member) -- Quick has some doubled
    -- (GroupID, UserID) member rows, collapsed the way TrgGroupMemoryAfterInsert
    -- does (DISTINCT). CK_SilaHistory_UserID_NotZero: UserID 0 skipped.
    DELETE FROM dbo.SilaHistory WHERE RecordType = 'G';

    INSERT INTO dbo.SilaHistory (
        RecordType, GroupID, UserID, LastChatID, LastMessage, LastMaintDate, UnreadMessage
    )
    SELECT
        'G' AS RecordType,
        gmem.GroupID,
        gmem.UserID,
        gm.LastChatID,
        gm.LastMessage,
        ISNULL(gm.LastMaintDate, '1900-01-01') AS LastMaintDate,  -- nullable on GroupMaster, NOT NULL on SilaHistory
        gmem.UnreadCount
    FROM (
        SELECT GroupID, UserID, MAX(UnreadCount) AS UnreadCount
        FROM GRP.GroupMembers
        WHERE UserID <> 0
        GROUP BY GroupID, UserID
    ) gmem
    INNER JOIN GRP.GroupMaster gm ON gm.GroupID = gmem.GroupID;

    DECLARE @MaxGCHID INT = (SELECT ISNULL(MAX(ID), 0) FROM GRP.GroupChatHistory);
    DBCC CHECKIDENT('GRP.GroupChatHistory', RESEED, @MaxGCHID) WITH NO_INFOMSGS;
    DECLARE @MaxGroupID2 INT = (SELECT ISNULL(MAX(GroupID), 0) FROM GRP.GroupMaster);
    DBCC CHECKIDENT('GRP.GroupMaster', RESEED, @MaxGroupID2) WITH NO_INFOMSGS;

    -- ChatID comes from NEXT VALUE FOR dbo.ChatGroup (a SEQUENCE): past every
    -- ChatID -- messages and unread rows -- or the next new group message
    -- collides with a copied one.
    DECLARE @MaxGroupChatID INT = (SELECT MAX(v) FROM (
        SELECT ISNULL(MAX(ChatID), 0) AS v FROM GRP.GroupChatHistory
        UNION ALL SELECT ISNULL(MAX(ChatID), 0) FROM GRP.GroupUnreadChat) x);
    DECLARE @RestartSeqSql NVARCHAR(200) =
        N'ALTER SEQUENCE dbo.ChatGroup RESTART WITH ' + CAST(@MaxGroupChatID + 1 AS NVARCHAR(20));
    EXEC sp_executesql @RestartSeqSql;

    ENABLE TRIGGER ALL ON GRP.GroupUnreadChat;
    ENABLE TRIGGER ALL ON GRP.GroupMembers;
    ENABLE TRIGGER ALL ON GRP.GroupChatHistory;
    COMMIT TRANSACTION;

    SELECT 'GroupChatHistory' AS TableName, @Copied AS CopiedFromQuick,
           (SELECT COUNT(*) FROM [Quick].[GRP].[GroupChatHistory]) - @Copied AS DuplicateChatIDsDropped,
           @MaxGroupChatID + 1 AS ChatGroupSequenceRestartedAt;
    SELECT 'Broadcast groups back' AS Step, gm.OldID AS OldGroupID, gm.NewID AS GroupID, g.Name,
           @Renumber AS ChatIDsRenumbered,
           (SELECT COUNT(*) FROM GRP.GroupChatHistory h WHERE h.GroupID = gm.NewID) AS Messages
    FROM @GMap gm JOIN GRP.GroupMaster g ON g.GroupID = gm.NewID;
    SELECT 'SilaHistory (G)' AS TableName, COUNT(*) AS [RowCount] FROM dbo.SilaHistory WHERE RecordType = 'G';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    BEGIN TRY SET IDENTITY_INSERT GRP.GroupChatHistory OFF; END TRY BEGIN CATCH END CATCH;
    BEGIN TRY SET IDENTITY_INSERT GRP.GroupMaster OFF; END TRY BEGIN CATCH END CATCH;
    INSERT INTO #GrpFailed (Step) VALUES (N'GroupChatHistory / broadcast groups / SilaHistory');
    SELECT 'GroupChatHistory / broadcast groups / SilaHistory' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- ----------------------------------------------------------------------------
-- 5) Broadcast groups' members = the active users (triggers on: the members
--    added get their SilaHistory 'G' rows from TrgGroupMemoryAfterInsert).
-- ----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM #GrpFailed) RETURN;
BEGIN TRY
    DECLARE @Added INT, @Removed INT;
    EXEC dbo.SilaSyncBroadcastGroup @GroupID = 0, @UserID = 0, @Added = @Added OUTPUT, @Removed = @Removed OUTPUT;
    SELECT 'SilaSyncBroadcastGroup' AS Step, @Added AS MembersAdded, @Removed AS MembersRemoved;
END TRY
BEGIN CATCH
    INSERT INTO #GrpFailed (Step) VALUES (N'SilaSyncBroadcastGroup');
    SELECT 'SilaSyncBroadcastGroup' AS TableName, ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
GO

-- Which step stopped the run, if any.
SELECT CASE WHEN EXISTS (SELECT 1 FROM #GrpFailed) THEN N'STOPPED at: ' + (SELECT TOP (1) Step FROM #GrpFailed)
            ELSE N'GRP schema: all steps OK' END AS Result;
DROP TABLE #GrpFailed;
GO
