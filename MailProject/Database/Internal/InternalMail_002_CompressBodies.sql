USE [InternalMail]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/*
  002 -- message bodies compressed (decided 2026-10-25).

  - BodyHtml NVARCHAR(MAX) becomes BodyHtmlGz VARBINARY(MAX): gzip of the
    UTF-16 text, the same format as COMPRESS(nvarchar), so it reads back with
        CAST(DECOMPRESS([BodyHtmlGz]) AS NVARCHAR(MAX))
    or in C# (GZip + Encoding.Unicode). The Mail Connector API compresses
    before it stores; existing rows are converted here, in SQL.
  - BodyText (for search) is capped at 64K characters.
  - The table is rebuilt at the end so the space of the old column is reused.
    (The database file keeps its size until someone chooses to shrink it.)

  Stop the Mail Connector API before running; start the new version after.
  Idempotent: safe to run again. Run in SSMS.
*/

IF COL_LENGTH(N'mail.MailMessageBody', N'BodyHtmlGz') IS NULL
    ALTER TABLE [mail].[MailMessageBody] ADD [BodyHtmlGz] VARBINARY(MAX) NULL;
GO

-- Existing HTML into the compressed column, 500 rows per statement (each its own
-- transaction, so the log stays small). Dynamic SQL: the column may be gone already.
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

UPDATE [mail].[MailMessageBody] SET [BodyText] = LEFT([BodyText], 65536) WHERE LEN([BodyText]) > 65536;
GO

ALTER INDEX [PK_MailMessageBody] ON [mail].[MailMessageBody] REBUILD;
GO
