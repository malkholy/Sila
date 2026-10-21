-- =========================================================================
-- Index for SilaApi's live change pump (SilaApi/Plus.Api/Live/LiveChanges.cs):
-- every ChangePollSeconds (2 s) while sockets are open it reads
--   dbo.SilaHistory WHERE SynSequence > @From ORDER BY SynSequence
-- Without this index that is a scan of the whole table (39,100 rows on
-- 2026-10-22); with it, a seek over the few rows that moved. The included
-- columns are the ones the pump returns, so it never touches the table.
-- Idempotent.
-- =========================================================================
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID(N'dbo.SilaHistory') AND name = N'IX_SilaHistory_SynSequence')
    CREATE NONCLUSTERED INDEX [IX_SilaHistory_SynSequence]
        ON [dbo].[SilaHistory] ([SynSequence])
        INCLUDE ([UserID], [RecordType], [SessionID], [GroupID], [TicketID], [MailID], [TaskID]);
GO
