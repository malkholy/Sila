USE [Mail]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/*
  002 -- message bodies compressed (decided 2026-10-25), same as InternalMail 002.

  BodyHtml NVARCHAR(MAX) becomes BodyHtmlGz VARBINARY(MAX): gzip of the UTF-16
  text (the format of COMPRESS(nvarchar)), copied as-is from InternalMail.
  Read back with CAST(DECOMPRESS([BodyHtmlGz]) AS NVARCHAR(MAX)).

  Idempotent: safe to run again. Run in SSMS.
*/

IF COL_LENGTH(N'mail.MailMessageBody', N'BodyHtmlGz') IS NULL
    ALTER TABLE [mail].[MailMessageBody] ADD [BodyHtmlGz] VARBINARY(MAX) NULL;
GO

IF COL_LENGTH(N'mail.MailMessageBody', N'BodyHtml') IS NOT NULL
    EXEC(N'
        DECLARE @Rows INT = 1;
        WHILE @Rows > 0
        BEGIN
            UPDATE TOP (500) [mail].[MailMessageBody]
            SET [BodyHtmlGz] = COMPRESS([BodyHtml]), [BodyHtml] = NULL
            WHERE [BodyHtml] IS NOT NULL;
            SET @Rows = @@ROWCOUNT;
        END');
GO

IF COL_LENGTH(N'mail.MailMessageBody', N'BodyHtml') IS NOT NULL
    ALTER TABLE [mail].[MailMessageBody] DROP COLUMN [BodyHtml];
GO
