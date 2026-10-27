USE [InternalMail]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/*
  004 -- the Sila username of each mailbox.

  The Sila Mail API finds a signed-in user's mailbox from the login token, which
  names the user (erp_user), not the numeric UserID; the internal server cannot
  ask SILA101. "Add mailbox" stores the username with the address; for a mailbox
  added before this, add it again in the Mail Monitor (same user, same address):
  that fills the username in. One mailbox per username.

  Idempotent: safe to run again. Run in SSMS.
*/

IF COL_LENGTH(N'mail.MailUser', N'Username') IS NULL
    ALTER TABLE [mail].[MailUser] ADD [Username] NVARCHAR(50) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_MailUser_Username' AND object_id = OBJECT_ID(N'[mail].[MailUser]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UX_MailUser_Username] ON [mail].[MailUser] ([Username]) WHERE [Username] IS NOT NULL;
GO
