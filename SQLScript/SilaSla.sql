USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- Ticket service levels (SLA): how long a ticket waits for its first reply
-- and until it is finished, counted in WORKING time, against per-channel
-- targets.
--
--   dbo.SilaWorkDay          one row per working day with its hours. Filled
--                            Saturday-Thursday 08:00-16:00 for 2024-2032 (no
--                            Fridays). A holiday = delete that date's row;
--                            different hours = update WorkStart / WorkEnd.
--   dbo.fnSilaWorkMinutes    working minutes between two moments.
--   dbo.SilaChannelSla       per-channel targets in working minutes:
--                            FirstReplyMinutes, FinishMinutes (NULL = no target).
--   dbo.fnSilaTicketSla      one ticket's first reply time, the working minutes
--                            it waited for it and until it was finished (or
--                            until now, while it is open) and its states against
--                            the targets: 0 no target, 1 on time, 2 due soon
--                            (75% of the target used, still open), 3 late.
--
-- States apply to tickets opened from the go-live date (2026-10-23) on: older
-- tickets get state 0 (their minutes are still returned, for the report's
-- averages), so the old backlog doesn't show as late. A ticket on Hold (5) is
-- never late while it is held (its minutes still include the held time).
-- First reply = the first non-system message from someone other than the
-- person who opened the ticket (edit copies not counted). Finished = Ended,
-- or Closed for a ticket closed without ending.
-- Idempotent. Deploy with deploy.sh or in SSMS.
-- =========================================================================
IF OBJECT_ID(N'dbo.SilaWorkDay', N'U') IS NULL
    CREATE TABLE dbo.SilaWorkDay (
        WorkDate  DATE     NOT NULL CONSTRAINT PK_SilaWorkDay PRIMARY KEY,
        WorkStart DATETIME NOT NULL,
        WorkEnd   DATETIME NOT NULL
    );
GO
-- Saturday-Thursday, 08:00-16:00 (day 0 = Monday: 1900-01-01 was a Monday; 4 = Friday)
WITH n AS (SELECT TOP (3300) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS i
           FROM sys.all_objects a CROSS JOIN sys.all_objects b),
     d AS (SELECT DATEADD(DAY, i, CAST('2024-01-01' AS DATE)) AS WorkDate FROM n)
INSERT INTO dbo.SilaWorkDay (WorkDate, WorkStart, WorkEnd)
SELECT d.WorkDate,
       DATEADD(HOUR, 8, CAST(d.WorkDate AS DATETIME)),
       DATEADD(HOUR, 16, CAST(d.WorkDate AS DATETIME))
FROM d
WHERE d.WorkDate <= '2032-12-31'
  AND DATEDIFF(DAY, '19000101', d.WorkDate) % 7 <> 4
  AND NOT EXISTS (SELECT 1 FROM dbo.SilaWorkDay w WHERE w.WorkDate = d.WorkDate);
GO
CREATE OR ALTER FUNCTION dbo.fnSilaWorkMinutes (@From DATETIME, @To DATETIME)
RETURNS TABLE
AS RETURN
    SELECT ISNULL(SUM(CASE WHEN x.s < x.e THEN DATEDIFF(MINUTE, x.s, x.e) ELSE 0 END), 0) AS Minutes
    FROM dbo.SilaWorkDay w
    CROSS APPLY (SELECT CASE WHEN @From > w.WorkStart THEN @From ELSE w.WorkStart END AS s,
                        CASE WHEN @To < w.WorkEnd THEN @To ELSE w.WorkEnd END AS e) x
    WHERE @From < @To
      AND w.WorkDate BETWEEN CAST(@From AS DATE) AND CAST(@To AS DATE);
GO
IF OBJECT_ID(N'dbo.SilaChannelSla', N'U') IS NULL
    CREATE TABLE dbo.SilaChannelSla (
        ChannelID         INT          NOT NULL CONSTRAINT PK_SilaChannelSla PRIMARY KEY,
        FirstReplyMinutes INT          NULL,
        FinishMinutes     INT          NULL,
        LastMaintBy       NVARCHAR(50) NOT NULL CONSTRAINT DF_SilaChannelSla_By DEFAULT (N''),
        LastMaintDate     DATETIME     NOT NULL CONSTRAINT DF_SilaChannelSla_Date DEFAULT (GETDATE())
    );
GO
CREATE OR ALTER FUNCTION dbo.fnSilaTicketSla (@TicketID INT)
RETURNS TABLE
AS RETURN
    SELECT t.TicketID, r.FirstReplyDate, f.FinishDate, s.FirstReplyMinutes AS ReplyTarget, s.FinishMinutes AS FinishTarget,
           rw.Minutes AS ReplyMinutes, fw.Minutes AS FinishMinutes,
           CASE WHEN s.FirstReplyMinutes IS NULL OR t.CreatedDate < '2026-10-23' THEN 0
                WHEN t.TicketState = 5 AND r.FirstReplyDate IS NULL THEN 1          -- on hold: not late
                WHEN rw.Minutes > s.FirstReplyMinutes THEN 3
                WHEN r.FirstReplyDate IS NULL AND t.TicketState < 10 AND rw.Minutes * 4 >= s.FirstReplyMinutes * 3 THEN 2
                ELSE 1 END AS ReplyState,
           CASE WHEN s.FinishMinutes IS NULL OR t.CreatedDate < '2026-10-23' THEN 0
                WHEN t.TicketState = 5 THEN 1                                      -- on hold: not late
                WHEN fw.Minutes > s.FinishMinutes THEN 3
                WHEN f.FinishDate IS NULL AND fw.Minutes * 4 >= s.FinishMinutes * 3 THEN 2
                ELSE 1 END AS FinishState
    FROM CHA.TicketHistory t
    LEFT JOIN dbo.SilaChannelSla s ON s.ChannelID = t.TicketChannelID
    OUTER APPLY (SELECT TOP (1) c.CreatedDate AS FirstReplyDate
                 FROM CHA.TicketChatHistory c
                 LEFT JOIN dbo.UserMaster cu ON cu.Username = t.CreatedByUser
                 WHERE c.TicketID = t.TicketID AND ISNULL(c.IsSystem, 0) = 0 AND ISNULL(c.OrginalChatID, 0) = 0
                   AND c.FromUserID <> ISNULL(cu.UserID, 0)
                 ORDER BY c.ChatID) r
    CROSS APPLY (SELECT CASE WHEN t.EndedDate > '2000-01-01' THEN t.EndedDate
                             WHEN t.ClosedDate > '2000-01-01' THEN t.ClosedDate END AS FinishDate) f
    CROSS APPLY dbo.fnSilaWorkMinutes(t.CreatedDate,
                                      CASE WHEN r.FirstReplyDate IS NOT NULL THEN r.FirstReplyDate
                                           WHEN t.TicketState < 10 THEN GETDATE()
                                           ELSE ISNULL(f.FinishDate, GETDATE()) END) rw
    CROSS APPLY dbo.fnSilaWorkMinutes(t.CreatedDate, ISNULL(f.FinishDate, GETDATE())) fw
    WHERE t.TicketID = @TicketID;
GO
