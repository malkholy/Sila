USE [SILA101]
GO
-- =========================================================================
-- Change markers for tickets: a RowVer (rowversion) column on CHA.TicketHistory
-- and CHA.TicketMembers. SQL Server sets it on EVERY row change, from any code
-- path (mobile CHA.APITicketOperation, the web CHA.APISilaWebTicketOperation,
-- the SQL Agent jobs, triggers) -- no trigger, no sequence. The web
-- 'Ticket list' reads "what changed since my watermark" from it, including
-- Ended / Closed tickets (whose dbo.SilaHistory rows are deleted) and members
-- who left. Run in SSMS, at a quiet time: adding a rowversion fills every
-- existing row once and locks the table meanwhile (~168 k + ~1.5 M rows).
--
-- CHA.TicketHistoryForward gets RowVer too, as binary(8), at the same position:
-- three procedures copy a ticket with
--     INSERT INTO cha.TicketHistoryForward SELECT * FROM cha.TicketHistory
-- which needs both tables to keep the same columns in the same order (checked
-- 2026-10-22: 25 identical columns). binary(8) because a rowversion column
-- refuses explicit values. Both columns are added in ONE transaction so no
-- forward can run between the two ALTERs.
--
-- Idempotent: every step checks first. Undo (if ever needed): drop the two
-- indexes, then the three columns, again in one transaction for the pair.
-- =========================================================================

-- 1. TicketHistory + TicketHistoryForward, together
IF COL_LENGTH('CHA.TicketHistory', 'RowVer') IS NULL
BEGIN
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    IF COL_LENGTH('CHA.TicketHistoryForward', 'RowVer') IS NULL
        ALTER TABLE [CHA].[TicketHistoryForward] ADD [RowVer] BINARY(8) NULL;
    ALTER TABLE [CHA].[TicketHistory] ADD [RowVer] ROWVERSION;
    COMMIT TRANSACTION;
END
GO

-- 2. TicketMembers (unread counts, leaving, roles)
IF COL_LENGTH('CHA.TicketMembers', 'RowVer') IS NULL
    ALTER TABLE [CHA].[TicketMembers] ADD [RowVer] ROWVERSION;
GO

-- 3. Indexes for the delta: tickets changed since X, and one user's member rows
--    changed since X (ONLINE: Enterprise Edition; the tables stay usable)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('CHA.TicketHistory') AND name = 'IX_TicketHistory_RowVer')
    CREATE NONCLUSTERED INDEX [IX_TicketHistory_RowVer] ON [CHA].[TicketHistory] ([RowVer])
    WITH (ONLINE = ON);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('CHA.TicketMembers') AND name = 'IX_TicketMembers_UserID_RowVer')
    CREATE NONCLUSTERED INDEX [IX_TicketMembers_UserID_RowVer] ON [CHA].[TicketMembers] ([UserID], [RowVer])
    INCLUDE ([TicketID], [IsLeft]) WITH (ONLINE = ON);
GO

-- 4. Check: both tables still line up for the forward copy (expect 0 rows)
SELECT a.column_id, a.name AS TicketHistory, b.name AS TicketHistoryForward
FROM (SELECT column_id, name FROM sys.columns WHERE object_id = OBJECT_ID('CHA.TicketHistory')) a
FULL JOIN (SELECT column_id, name FROM sys.columns WHERE object_id = OBJECT_ID('CHA.TicketHistoryForward')) b
       ON b.column_id = a.column_id
WHERE a.name IS NULL OR b.name IS NULL OR a.name <> b.name;
GO
