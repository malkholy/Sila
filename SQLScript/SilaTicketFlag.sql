USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [dbo].[SilaTicketFlag] -- a person's own follow-up flag on a ticket (like
-- flagging an email): private to that user, with an optional due date and
-- note. One row per ticket + user; clearing the flag deletes the row.
-- Shown only while the user is still in the ticket and it isn't closed (the
-- procedures filter on TicketMembers.IsLeft = 0 and TicketState < 50), so a
-- flag comes back if the ticket is reopened.
-- Written by CHA.APISilaWebTicketOperation 'Set ticket flag' (web) and
-- CHA.APITicketOperation 'Set Ticket Flag' / 'Clear Ticket Flag' (mobile).
-- Kept out of CHA.TicketMembers on purpose: the mobile procedures copy that
-- table with SELECT *.
-- Idempotent. Deploy with deploy.sh or in SSMS.
-- =========================================================================
IF OBJECT_ID(N'dbo.SilaTicketFlag', N'U') IS NULL
    CREATE TABLE dbo.SilaTicketFlag (
        TicketID      INT           NOT NULL,
        UserID        INT           NOT NULL,
        DueDate       DATE          NULL,
        Note          NVARCHAR(300) NOT NULL CONSTRAINT DF_SilaTicketFlag_Note DEFAULT (N''),
        CreatedDate   DATETIME      NOT NULL CONSTRAINT DF_SilaTicketFlag_Created DEFAULT (GETDATE()),
        LastMaintDate DATETIME      NOT NULL CONSTRAINT DF_SilaTicketFlag_Maint DEFAULT (GETDATE()),
        CONSTRAINT PK_SilaTicketFlag PRIMARY KEY (TicketID, UserID)
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SilaTicketFlag_User' AND object_id = OBJECT_ID(N'dbo.SilaTicketFlag'))
    CREATE INDEX IX_SilaTicketFlag_User ON dbo.SilaTicketFlag (UserID) INCLUDE (DueDate);
GO
