USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- My Day reminders: a person's own reminders and notes, private to them.
--
--   dbo.SilaReminder        one row per reminder (a repeating one is ONE row
--                           that moves to its next date each time it fires or
--                           is marked done). Optional link to the chat, group
--                           or ticket (and message) it is about.
--   dbo.fnSilaReminderNext  the next date of a repeating reminder after a moment.
--   dbo.SilaReminderOperation  SilaApi's reminder sender only (its own SQL
--                           login, never /api/v2/exec):
--     Claim due { Top, MaxAgeMinutes }  takes reminders whose time has come
--                (DueAt <= now, not done, not yet fired; UPDLOCK, READPAST so
--                two senders never take the same one), fires them -- a one-off
--                gets NotifiedAt, a repeating one moves to its next date -- and
--                returns them with the user's device tokens (newest 5). Late =
--                1 when the time passed more than MaxAgeMinutes ago (the server
--                was down): those fire silently, no push.
--
-- DueAt = DueDate + DueTime; a reminder with a date only is due at 09:00.
-- The web side reads and writes reminders through dbo.APISilaWebOperation
-- ('My day', 'Save reminder', 'Reminder done', 'Delete reminder').
-- Idempotent. Deploy with deploy.sh or in SSMS.
-- =========================================================================
IF OBJECT_ID(N'dbo.SilaReminder', N'U') IS NULL
    CREATE TABLE dbo.SilaReminder (
        ReminderID    INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_SilaReminder PRIMARY KEY,
        UserID        INT            NOT NULL,
        Title         NVARCHAR(200)  NOT NULL,
        Note          NVARCHAR(1000) NOT NULL CONSTRAINT DF_SilaReminder_Note DEFAULT (N''),
        DueDate       DATE           NULL,
        DueTime       TIME(0)        NULL,
        DueAt         AS (DATEADD(MINUTE, ISNULL(DATEPART(HOUR, DueTime) * 60 + DATEPART(MINUTE, DueTime), 540),
                                  CAST(DueDate AS DATETIME))) PERSISTED,   -- 540 = 09:00
        RepeatKind    VARCHAR(10)    NULL CONSTRAINT CK_SilaReminder_Repeat CHECK (RepeatKind IN ('day', 'week', 'month')),
        LinkKind      VARCHAR(10)    NULL CONSTRAINT CK_SilaReminder_Link CHECK (LinkKind IN ('chat', 'group', 'ticket')),
        LinkID        INT            NULL,      -- SessionID | GroupID | TicketID
        ChatID        INT            NULL,      -- the message, when set from a message
        Push          BIT            NOT NULL CONSTRAINT DF_SilaReminder_Push DEFAULT (1),
        NotifiedAt    DATETIME       NULL,      -- a one-off that fired
        LastFiredAt   DATETIME       NULL,
        DoneAt        DATETIME       NULL,
        CreatedDate   DATETIME       NOT NULL CONSTRAINT DF_SilaReminder_Created DEFAULT (GETDATE()),
        LastMaintDate DATETIME       NOT NULL CONSTRAINT DF_SilaReminder_Maint DEFAULT (GETDATE())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SilaReminder_User' AND object_id = OBJECT_ID(N'dbo.SilaReminder'))
    CREATE INDEX IX_SilaReminder_User ON dbo.SilaReminder (UserID, DoneAt) INCLUDE (DueDate, DueTime);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SilaReminder_Due' AND object_id = OBJECT_ID(N'dbo.SilaReminder'))
    CREATE INDEX IX_SilaReminder_Due ON dbo.SilaReminder (DueAt) WHERE DoneAt IS NULL AND NotifiedAt IS NULL;
GO
-- The first date of a repeating reminder whose moment (date + time, 09:00 when
-- none) is after @After. A month from the 31st lands on the month's last day.
CREATE OR ALTER FUNCTION dbo.fnSilaReminderNext (@Date DATE, @Time TIME(0), @Repeat VARCHAR(10), @After DATETIME)
RETURNS DATE
AS
BEGIN
    IF @Date IS NULL OR @Repeat IS NULL RETURN @Date;
    DECLARE @Mins INT = ISNULL(DATEPART(HOUR, @Time) * 60 + DATEPART(MINUTE, @Time), 540);
    -- step n intervals from the ORIGINAL date (so the 31st stays the month's end);
    -- start close to @After so a reminder left for months takes a few steps only
    DECLARE @N INT = CASE @Repeat WHEN 'day' THEN DATEDIFF(DAY, @Date, @After) - 1
                                  WHEN 'week' THEN DATEDIFF(DAY, @Date, @After) / 7 - 1
                                  ELSE DATEDIFF(MONTH, @Date, @After) - 1 END;
    IF @N < 0 SET @N = 0;
    DECLARE @D DATE = @Date, @Steps INT = 0;
    WHILE @Steps < 1000
    BEGIN
        SET @D = CASE @Repeat WHEN 'day' THEN DATEADD(DAY, @N, @Date)
                              WHEN 'week' THEN DATEADD(WEEK, @N, @Date)
                              ELSE DATEADD(MONTH, @N, @Date) END;
        IF DATEADD(MINUTE, @Mins, CAST(@D AS DATETIME)) > @After BREAK;
        SET @N += 1; SET @Steps += 1;
    END
    RETURN @D;
END
GO
CREATE OR ALTER PROCEDURE dbo.SilaReminderOperation
    @Operation NVARCHAR(50),
    @LineData  NVARCHAR(MAX) = N'',
    @State     INT           = 0  OUTPUT,
    @Message   NVARCHAR(500) = N'' OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET @State = 0; SET @Message = N'';
    IF ISJSON(@LineData) <> 1 SET @LineData = N'{}';

    IF @Operation = N'Claim due'
    BEGIN
        DECLARE @Top INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 200);
        DECLARE @MaxAge INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.MaxAgeMinutes') AS INT), 30);
        IF @Top NOT BETWEEN 1 AND 1000 SET @Top = 200;
        IF @MaxAge NOT BETWEEN 1 AND 1440 SET @MaxAge = 30;
        DECLARE @Now DATETIME = GETDATE();
        DECLARE @C TABLE (ReminderID INT PRIMARY KEY, FiredDueAt DATETIME, Late BIT);

        BEGIN TRANSACTION;
        INSERT INTO @C (ReminderID, FiredDueAt, Late)
        SELECT TOP (@Top) r.ReminderID, r.DueAt, CASE WHEN r.DueAt < DATEADD(MINUTE, -@MaxAge, @Now) THEN 1 ELSE 0 END
        FROM dbo.SilaReminder r WITH (UPDLOCK, READPAST)
        WHERE r.DoneAt IS NULL AND r.NotifiedAt IS NULL AND r.DueAt <= @Now
        ORDER BY r.DueAt;
        UPDATE r SET
            r.NotifiedAt = CASE WHEN r.RepeatKind IS NULL THEN @Now END,
            r.DueDate = CASE WHEN r.RepeatKind IS NULL THEN r.DueDate ELSE dbo.fnSilaReminderNext(r.DueDate, r.DueTime, r.RepeatKind, @Now) END,
            r.LastFiredAt = @Now, r.LastMaintDate = @Now
        FROM dbo.SilaReminder r JOIN @C c ON c.ReminderID = r.ReminderID;
        COMMIT TRANSACTION;

        SELECT c.ReminderID, c.FiredDueAt AS DueAt, c.Late, r.UserID, u.Username, r.Title, r.Note, r.Push,
               ISNULL(r.LinkKind, '') AS LinkKind, ISNULL(r.LinkID, 0) AS LinkID, ISNULL(r.ChatID, 0) AS ChatID,
               (SELECT STRING_AGG(t.FireBaseToken, N'|') FROM (
                    SELECT TOP (5) f.FireBaseToken FROM dbo.UserFireBaseHistory f
                    WHERE f.UserID = r.UserID AND LEN(f.FireBaseToken) > 20
                    GROUP BY f.FireBaseToken ORDER BY MAX(ISNULL(f.LastUsedDate, f.CreatedDate)) DESC) t) AS Tokens
        FROM @C c
        JOIN dbo.SilaReminder r ON r.ReminderID = c.ReminderID
        JOIN dbo.UserMaster u ON u.UserID = r.UserID AND u.IsNotActive = 0
        ORDER BY c.FiredDueAt;
        RETURN;
    END

    SET @State = 400; SET @Message = N'Unknown operation.';
END
GO
