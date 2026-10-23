USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [dbo].[SilaPushOperation] -- the push-notification queue for SilaApi's
-- Firebase sender (SilaApi Plus.Api/Push). It replaces the polling program
-- that read dbo.APIFireBaseCenterlOperation ('Get One-To-One' ... 'Update
-- Ticket'); the unread tables stay the queue. Called ONLY by SilaApi's own SQL
-- login from its background service -- not through /api/v2/exec, so it has no
-- row in PLS.V1ApiOperationPermission and no @User.
--
--   Claim        { Top, MaxAgeMinutes, HoldSeconds }  takes up to Top unsent
--                rows (IsSent = 0, fewer than 5 attempts) created between
--                MaxAgeMinutes ago and HoldSeconds ago -- older ones are never
--                sent (no burst of stale messages), newer ones wait so a
--                message read on the web meanwhile is never pushed (reading
--                deletes its unread row). Claiming counts an attempt and stamps
--                SentDate, so a second sender skips them (UPDLOCK, READPAST) and
--                a crashed send is retried after 2 minutes. Returns one row per
--                message with its title, body, the data fields of the app's
--                payload and the user's device tokens (newest 5).
--   Mark         { Sent: [ { Src, ID } ] }  IsSent = 1 for the delivered ones;
--                failed ones keep their attempt and are retried.
--   Remove tokens {  Tokens: [ "..." ] }  tokens Firebase reports as gone.
--
-- Src: O one-to-one, G group, C ticket, M mail, K task, N general notification.
-- ChatType (the app's): 1 one-to-one, 2 group, 3 ticket, 4 mail, 5 task, 6 general.
-- Muted tickets (TicketMembers.IsMuted) are claimed with Muted = 1: the sender
-- marks them sent without pushing.
-- Idempotent. Deploy with deploy.sh or in SSMS.
-- =========================================================================
CREATE OR ALTER PROCEDURE dbo.SilaPushOperation
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

    IF @Operation = N'Claim'
    BEGIN
        DECLARE @Top INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 200);
        DECLARE @MaxAge INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.MaxAgeMinutes') AS INT), 30);
        DECLARE @Hold INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.HoldSeconds') AS INT), 5);
        IF @Top NOT BETWEEN 1 AND 1000 SET @Top = 200;
        IF @MaxAge NOT BETWEEN 1 AND 1440 SET @MaxAge = 30;
        IF @Hold NOT BETWEEN 0 AND 300 SET @Hold = 5;
        DECLARE @Now DATETIME = GETDATE();
        DECLARE @From DATETIME = DATEADD(MINUTE, -@MaxAge, @Now), @Until DATETIME = DATEADD(SECOND, -@Hold, @Now),
                @Stale DATETIME = DATEADD(MINUTE, -2, @Now);
        DECLARE @C TABLE (Src CHAR(1) NOT NULL, ID INT NOT NULL, PRIMARY KEY (Src, ID));

        BEGIN TRANSACTION;
        INSERT INTO @C SELECT TOP (@Top) 'O', ID FROM ONE.OneToOneUnreadChat WITH (UPDLOCK, READPAST)
            WHERE IsSent = 0 AND ISNULL(SendingAttempt, 0) < 5 AND CreatedDate BETWEEN @From AND @Until
              AND (SentDate IS NULL OR SentDate < @Stale) ORDER BY ID;
        INSERT INTO @C SELECT TOP (@Top) 'G', ID FROM GRP.GroupUnreadChat WITH (UPDLOCK, READPAST)
            WHERE IsSent = 0 AND ISNULL(SendingAttempt, 0) < 5 AND CreatedDate BETWEEN @From AND @Until
              AND (SentDate IS NULL OR SentDate < @Stale) ORDER BY ID;
        INSERT INTO @C SELECT TOP (@Top) 'C', ID FROM CHA.TicketUnreadChat WITH (UPDLOCK, READPAST)
            WHERE IsSent = 0 AND ISNULL(SendingAttempt, 0) < 5 AND CreatedDate BETWEEN @From AND @Until
              AND (SentDate IS NULL OR SentDate < @Stale) ORDER BY ID;
        INSERT INTO @C SELECT TOP (@Top) 'M', ID FROM MAIL.MailUnreadChat WITH (UPDLOCK, READPAST)
            WHERE IsSent = 0 AND ISNULL(SendingAttempt, 0) < 5 AND CreatedDate BETWEEN @From AND @Until
              AND (SentDate IS NULL OR SentDate < @Stale) ORDER BY ID;
        INSERT INTO @C SELECT TOP (@Top) 'K', ID FROM TASK.TaskUnreadChat WITH (UPDLOCK, READPAST)
            WHERE IsSent = 0 AND ISNULL(SendingAttempt, 0) < 5 AND CreatedDate BETWEEN @From AND @Until
              AND (SentDate IS NULL OR SentDate < @Stale) ORDER BY ID;
        INSERT INTO @C SELECT TOP (@Top) 'N', NotificationID FROM dbo.GeneralNotification WITH (UPDLOCK, READPAST)
            WHERE ISNULL(IsSent, 0) = 0 AND ISNULL(Attempts, 0) < 5 AND CreatedDate BETWEEN @From AND @Until
              AND (SentDate IS NULL OR SentDate < @Stale) ORDER BY NotificationID;

        UPDATE x SET SendingAttempt = ISNULL(x.SendingAttempt, 0) + 1, SentDate = @Now FROM ONE.OneToOneUnreadChat x JOIN @C c ON c.Src = 'O' AND c.ID = x.ID;
        UPDATE x SET SendingAttempt = ISNULL(x.SendingAttempt, 0) + 1, SentDate = @Now FROM GRP.GroupUnreadChat x JOIN @C c ON c.Src = 'G' AND c.ID = x.ID;
        UPDATE x SET SendingAttempt = ISNULL(x.SendingAttempt, 0) + 1, SentDate = @Now FROM CHA.TicketUnreadChat x JOIN @C c ON c.Src = 'C' AND c.ID = x.ID;
        UPDATE x SET SendingAttempt = ISNULL(x.SendingAttempt, 0) + 1, SentDate = @Now FROM MAIL.MailUnreadChat x JOIN @C c ON c.Src = 'M' AND c.ID = x.ID;
        UPDATE x SET SendingAttempt = ISNULL(x.SendingAttempt, 0) + 1, SentDate = @Now FROM TASK.TaskUnreadChat x JOIN @C c ON c.Src = 'K' AND c.ID = x.ID;
        UPDATE x SET Attempts = ISNULL(x.Attempts, 0) + 1, SentDate = @Now FROM dbo.GeneralNotification x JOIN @C c ON c.Src = 'N' AND c.ID = x.NotificationID;
        COMMIT TRANSACTION;

        -- one row per message; titles as the old sender built them (FromAccount)
        WITH q AS (
            SELECT 'O' AS Src, a.ID, a.UserID, 1 AS ChatType, ISNULL(NULLIF(fu.FullName, N''), fu.Username) AS Title,
                   a.Text, a.AttachmentID, a.SessionID, 0 AS GroupID, 0 AS ChannelID, 0 AS TicketID, 0 AS MailID, 0 AS TaskID, 0 AS Muted
            FROM ONE.OneToOneUnreadChat a JOIN @C c ON c.Src = 'O' AND c.ID = a.ID
            LEFT JOIN dbo.UserMaster fu ON fu.UserID = a.FromUserID
            UNION ALL
            SELECT 'G', a.ID, a.UserID, 2, ISNULL(NULLIF(fu.FullName, N''), fu.Username) + N'@' + ISNULL(g.Name, N''),
                   a.Text, a.AttachmentID, 0, a.GroupID, 0, 0, 0, 0, 0
            FROM GRP.GroupUnreadChat a JOIN @C c ON c.Src = 'G' AND c.ID = a.ID
            LEFT JOIN dbo.UserMaster fu ON fu.UserID = a.FromUserID
            LEFT JOIN GRP.GroupMaster g ON g.GroupID = a.GroupID
            UNION ALL
            SELECT 'C', a.ID, a.UserID, 3, ISNULL(NULLIF(fu.FullName, N''), fu.Username) + N'@' + ISNULL(ch.Name, N''),
                   a.Text, a.AttachmentID, 0, 0, a.ChannelID, a.TicketID, 0, 0,
                   CASE WHEN EXISTS (SELECT 1 FROM CHA.TicketMembers m WHERE m.TicketID = a.TicketID AND m.UserID = a.UserID AND m.IsMuted = 1) THEN 1 ELSE 0 END
            FROM CHA.TicketUnreadChat a JOIN @C c ON c.Src = 'C' AND c.ID = a.ID
            LEFT JOIN dbo.UserMaster fu ON fu.UserID = a.FromUserID
            LEFT JOIN CHA.ChannelMaster ch ON ch.ChannelID = a.ChannelID
            UNION ALL
            SELECT 'M', a.ID, a.UserID, 4, ISNULL(NULLIF(fu.FullName, N''), fu.Username), a.Text, a.AttachmentID, 0, 0, 0, 0, a.MailID, 0, 0
            FROM MAIL.MailUnreadChat a JOIN @C c ON c.Src = 'M' AND c.ID = a.ID
            LEFT JOIN dbo.UserMaster fu ON fu.UserID = a.FromUserID
            UNION ALL
            SELECT 'K', a.ID, a.UserID, 5, ISNULL(NULLIF(fu.FullName, N''), fu.Username), a.Text, a.AttachmentID, 0, 0, 0, 0, 0, a.TaskID, 0
            FROM TASK.TaskUnreadChat a JOIN @C c ON c.Src = 'K' AND c.ID = a.ID
            LEFT JOIN dbo.UserMaster fu ON fu.UserID = a.FromUserID
            UNION ALL
            SELECT 'N', a.NotificationID, a.UserID, 6, a.NotificationSubject, a.NotificationText, 0, 0, 0, 0, 0, 0, 0, 0
            FROM dbo.GeneralNotification a JOIN @C c ON c.Src = 'N' AND c.ID = a.NotificationID
        )
        SELECT q.Src, q.ID, q.UserID, q.ChatType, ISNULL(q.Title, N'Sila') AS Title,
               CASE WHEN LTRIM(RTRIM(ISNULL(q.Text, N''))) = N'' AND ISNULL(q.AttachmentID, 0) <> 0 THEN N'Sent a file'
                    ELSE LEFT(ISNULL(q.Text, N''), 1000) END AS Body,
               q.SessionID, q.GroupID, q.ChannelID, q.TicketID, q.MailID, q.TaskID, q.Muted,
               (SELECT STRING_AGG(t.FireBaseToken, N'|') FROM (
                    SELECT TOP (5) f.FireBaseToken FROM dbo.UserFireBaseHistory f
                    WHERE f.UserID = q.UserID AND LEN(f.FireBaseToken) > 20
                    GROUP BY f.FireBaseToken ORDER BY MAX(ISNULL(f.LastUsedDate, f.CreatedDate)) DESC) t) AS Tokens
        FROM q
        ORDER BY q.Src, q.ID;
        RETURN;
    END

    IF @Operation = N'Mark'
    BEGIN
        DECLARE @S TABLE (Src CHAR(1) NOT NULL, ID INT NOT NULL, PRIMARY KEY (Src, ID));
        INSERT INTO @S SELECT DISTINCT LEFT(x.Src, 1), x.ID FROM OPENJSON(@LineData, '$.Sent') WITH (Src NVARCHAR(5) '$.Src', ID INT '$.ID') x
        WHERE x.ID IS NOT NULL AND LEFT(x.Src, 1) IN ('O', 'G', 'C', 'M', 'K', 'N');
        UPDATE x SET IsSent = 1, SentDate = GETDATE() FROM ONE.OneToOneUnreadChat x JOIN @S s ON s.Src = 'O' AND s.ID = x.ID;
        UPDATE x SET IsSent = 1, SentDate = GETDATE() FROM GRP.GroupUnreadChat x JOIN @S s ON s.Src = 'G' AND s.ID = x.ID;
        UPDATE x SET IsSent = 1, SentDate = GETDATE() FROM CHA.TicketUnreadChat x JOIN @S s ON s.Src = 'C' AND s.ID = x.ID;
        UPDATE x SET IsSent = 1, SentDate = GETDATE() FROM MAIL.MailUnreadChat x JOIN @S s ON s.Src = 'M' AND s.ID = x.ID;
        UPDATE x SET IsSent = 1, SentDate = GETDATE() FROM TASK.TaskUnreadChat x JOIN @S s ON s.Src = 'K' AND s.ID = x.ID;
        UPDATE x SET IsSent = 1, SentDate = GETDATE() FROM dbo.GeneralNotification x JOIN @S s ON s.Src = 'N' AND s.ID = x.NotificationID;
        SELECT COUNT(*) AS Marked FROM @S;
        RETURN;
    END

    IF @Operation = N'Remove tokens'
    BEGIN
        DELETE f FROM dbo.UserFireBaseHistory f
        WHERE f.FireBaseToken IN (SELECT [value] FROM OPENJSON(@LineData, '$.Tokens') WHERE LEN([value]) > 20);
        SELECT @@ROWCOUNT AS Removed;
        RETURN;
    END

    SET @State = 1; SET @Message = N'Unknown operation.';
END
GO
