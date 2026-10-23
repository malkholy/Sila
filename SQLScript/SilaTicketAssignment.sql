USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [dbo].[SilaTicketAssignment] -- who owns a ticket: one assignee per ticket
-- (a member of it). Ticket admins / team leaders assign or reassign anyone in
-- the ticket; any non-CC member can take an unassigned ticket; the assignee or
-- a manager can unassign. Every change posts a system line in the ticket.
-- Written by CHA.APISilaWebTicketOperation ('Assign ticket', 'Take ticket',
-- 'Unassign ticket') and CHA.APITicketOperation (mobile: 'Assign Ticket',
-- 'Take Ticket', 'Unassign Ticket'). The row goes when the assignee leaves or
-- is removed, and when a forwarded original is retired.
-- Kept out of CHA.TicketHistory on purpose: the mobile Accept Forward copies
-- that table with SELECT * into CHA.TicketHistoryForward.
-- Idempotent. Deploy with deploy.sh or in SSMS.
-- =========================================================================
IF OBJECT_ID(N'dbo.SilaTicketAssignment', N'U') IS NULL
    CREATE TABLE dbo.SilaTicketAssignment (
        TicketID     INT          NOT NULL CONSTRAINT PK_SilaTicketAssignment PRIMARY KEY,
        UserID       INT          NOT NULL,
        AssignedBy   NVARCHAR(50) NOT NULL CONSTRAINT DF_SilaTicketAssignment_By DEFAULT (N''),
        AssignedDate DATETIME     NOT NULL CONSTRAINT DF_SilaTicketAssignment_Date DEFAULT (GETDATE())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SilaTicketAssignment_User' AND object_id = OBJECT_ID(N'dbo.SilaTicketAssignment'))
    CREATE INDEX IX_SilaTicketAssignment_User ON dbo.SilaTicketAssignment (UserID);
GO
