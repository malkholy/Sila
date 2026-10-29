-- ============================================================================
-- STANDALONE re-run of the SilaHistory regeneration only - this same logic
-- is now also embedded directly in Manual_InsertSelect_OneSchema_All.sql's
-- step 3 (runs right after OneChatSession's LastChatID/LastMessage/
-- LastMaintDate are recomputed, in the same transaction, before that
-- table's trigger goes back on). Use THIS file only if you need to refresh
-- SilaHistory's 'O' rows on their own later, without re-running the whole
-- chat/unread/history migration.
--
-- Regenerate SilaHistory's RecordType='O' rows from Sila101's OWN already-
-- migrated One schema data (OneChatSession + OneToOneUnreadChat) - NOT
-- copied from Quick's QuickHistory. Run this ON Sila101 only, no Quick
-- connectivity needed.
--
-- WHY regenerate instead of migrate from Quick: SilaHistory is a derived/
-- summary table - [One].[TriggerOneChatHistoryAfterInsert] auto-populates
-- it from OneToOneChatHistory on every insert. Quick's own QuickHistory
-- (QuickType='O') is a SEPARATE, independently-computed rollup on Quick's
-- side that may not exactly match what's already correctly migrated into
-- Sila101's OneChatSession/OneToOneChatHistory/OneToOneUnreadChat. This
-- script recomputes SilaHistory's 'O' rows the same way the trigger would,
-- guaranteeing consistency with the data already on Sila101 (migration
-- decision - see chat history for the reasoning).
--
-- SilaHistory holds MULTIPLE record types in one table (C/G/K/M/O/etc) -
-- every operation below is scoped to WHERE RecordType='O' only. Other
-- record types are never touched.
--
-- This DELETES the 20 live 'O' rows created by real production chat
-- activity since the One-schema migration finished, and replaces them with
-- a full regenerated set (per migration decision - full delete+reload is
-- this migration's standing policy).
--
-- One row per (SessionID, participant) - matches the trigger's own shape:
-- a 2-participant session gets 2 rows (one per UserID, OtherUserID = the
-- other party); a self-chat session (UserID1 = UserID2) gets 1 row.
-- UnreadMessage is a live COUNT(*) against OneToOneUnreadChat, same as the
-- trigger computes it.
--
-- Column defaults reused (NOT set explicitly here, matching the trigger's
-- own INSERT column list): GroupID/ChannelID/TicketID/MailID/TaskID/
-- TicketState/TaskState/MailState = 0, TicketSubject/MailSubject/
-- TaskSubject = '', SynSequence = NEXT VALUE FOR dbo.SynSeq (per-row,
-- automatic - no manual sequence handling needed since we're not copying
-- old explicit ID values here, unlike ChatOneToOne/Attachment).
--
-- No triggers to disable: [dbo].[TrgSilaHistoryafterUpdate] only fires on
-- UPDATE (confirmed via OBJECTPROPERTY), not INSERT/DELETE.
--
-- Wrapped in an explicit transaction so a failure partway through rolls
-- back the DELETE too.
-- ============================================================================

SET XACT_ABORT ON;

BEGIN TRY

    BEGIN TRANSACTION;

    DELETE FROM dbo.SilaHistory WHERE RecordType = 'O';

    INSERT INTO dbo.SilaHistory (
        RecordType, SessionID, UserID, LastChatID, LastMessage,
        LastMaintDate, OtherUserID, UnreadMessage
    )
    SELECT
        'O' AS RecordType,
        s.SessionID,
        s.UserID,
        s.LastChatID,
        s.LastMessage,
        ISNULL(s.LastMaintDate, '1900-01-01') AS LastMaintDate,  -- OneChatSession.LastMaintDate is nullable; SilaHistory's is NOT NULL
        s.OtherUserID,
        (SELECT COUNT(*) FROM One.OneToOneUnreadChat u
         WHERE u.SessionID = s.SessionID AND u.UserID = s.UserID) AS UnreadMessage
    FROM (
        -- SilaHistory.UserID has a CK_SilaHistory_UserID_NotZero constraint;
        -- 11 sessions have a 0 participant (legacy/invalid data) - those
        -- rows are skipped below, not backfilled.
        SELECT SessionID, UserID1 AS UserID, UserID2 AS OtherUserID,
               LastChatID, LastMessage, LastMaintDate
        FROM One.OneChatSession
        WHERE UserID1 <> 0

        UNION ALL

        -- UserID1 <> UserID2 avoids a duplicate row for self-chat sessions.
        SELECT SessionID, UserID2 AS UserID, UserID1 AS OtherUserID,
               LastChatID, LastMessage, LastMaintDate
        FROM One.OneChatSession
        WHERE UserID2 <> 0 AND UserID1 <> UserID2
    ) s;

    COMMIT TRANSACTION;

    SELECT COUNT(*) AS RowsInSilaHistory_O FROM dbo.SilaHistory WHERE RecordType = 'O';

END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    SELECT ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
END CATCH
