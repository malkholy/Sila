USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [dbo].[SilaPushLog] -- what SilaApi's Firebase sender did with each message
-- it claimed (dbo.SilaPushOperation 'Log'), for System Settings > User Master
-- (APISilaWebOperation 'Settings user push': the latest 20 per person).
-- The unread rows themselves are deleted once read, so they cannot show it.
--
--   Result     Sent       Firebase accepted it for at least one device
--              Failed     every device failed for another reason; retried
--                         (one row per attempt, at most 5)
--              TokenGone  every device was gone; the tokens were removed
--              NoDevice   the person has no device token: nothing sent
--              Muted      a muted ticket: nothing sent
--   Devices    tokens tried; Delivered = how many Firebase accepted
--
-- Rows older than 30 days are removed by the 'Log' operation itself.
-- Idempotent. Deploy with deploy.sh or in SSMS, BEFORE SilaPushOperation.sql.
-- =========================================================================
IF OBJECT_ID(N'dbo.SilaPushLog', N'U') IS NULL
CREATE TABLE dbo.SilaPushLog
(
    LogID      BIGINT IDENTITY(1, 1) NOT NULL,
    LoggedAt   DATETIME       NOT NULL CONSTRAINT DF_SilaPushLog_LoggedAt DEFAULT (GETDATE()),
    UserID     INT            NOT NULL,
    Src        CHAR(1)        NOT NULL,
    RefID      INT            NOT NULL,
    ChatType   INT            NOT NULL,
    Title      NVARCHAR(200)  NULL,
    Body       NVARCHAR(300)  NULL,
    Devices    INT            NOT NULL,
    Delivered  INT            NOT NULL,
    Result     VARCHAR(10)    NOT NULL,
    CONSTRAINT PK_SilaPushLog PRIMARY KEY CLUSTERED (LogID),
    CONSTRAINT CK_SilaPushLog_Result CHECK (Result IN ('Sent', 'Failed', 'TokenGone', 'NoDevice', 'Muted'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SilaPushLog_User' AND object_id = OBJECT_ID(N'dbo.SilaPushLog'))
CREATE INDEX IX_SilaPushLog_User ON dbo.SilaPushLog (UserID, LogID DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SilaPushLog_LoggedAt' AND object_id = OBJECT_ID(N'dbo.SilaPushLog'))
CREATE INDEX IX_SilaPushLog_LoggedAt ON dbo.SilaPushLog (LoggedAt);
GO
