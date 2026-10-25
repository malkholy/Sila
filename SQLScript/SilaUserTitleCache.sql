USE [SILA101]
GO
-- =========================================================================
-- Job titles kept inside SILA101 (dbo.SilaUserTitleCache), so the web
-- procedures stop reaching into the quick and HR databases on every call.
--
-- Why: dbo.V_SilaUserTitle read quick.QUK.UserMaster / UserGroupMaster and
-- hr.dbo.EmployeeMaster / Department / Job for every sender of every message.
-- Measured 2026-10-26: everything else in 'Ticket messages' takes under 1 ms;
-- the call still spent ~0.7 s on the server, and the same 50 messages with
-- job titles took ~1 s in SSMS against ~0 without them.
--
--   dbo.SilaUserTitleCache     one row per user: user group, job, department
--   dbo.SilaRefreshUserTitles  refills it from quick / HR (inserts and updates
--                              only; ~505 users). Run hourly by a SQL Agent job
--                              (SilaUserTitleJob.sql, SSMS) and once here.
--   dbo.V_SilaUserTitle        same columns as before, now read from the
--                              cache, so none of its ~20 callers change.
--
-- The view is switched in the LAST batch, after the fill batch has checked the
-- cache is full: if the fill fails (no access to quick / HR from this
-- connection), the run stops there and the view keeps reading quick / HR.
-- Then run EXEC dbo.SilaRefreshUserTitles in SSMS and re-run this file.
-- Idempotent.
-- =========================================================================

IF OBJECT_ID(N'[dbo].[SilaUserTitleCache]', N'U') IS NULL
CREATE TABLE [dbo].[SilaUserTitleCache]
(
    [UserID]          INT            NOT NULL,
    [UserGroupID]     INT            NULL,
    [UserGroupName]   NVARCHAR(200)  NULL,
    [JobName]         NVARCHAR(200)  NULL,
    [DepartmentName]  NVARCHAR(200)  NULL,
    [RefreshedAt]     DATETIME2(0)   NOT NULL CONSTRAINT [DF_SilaUserTitleCache_RefreshedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_SilaUserTitleCache] PRIMARY KEY CLUSTERED ([UserID])
);
GO

-- Refills the cache from quick / HR, with the old view's rules (TOP (1) per
-- user, so a duplicate row there never duplicates a person). Updates changed
-- rows, adds new users; a user no longer found there gets empty titles.
CREATE OR ALTER PROCEDURE [dbo].[SilaRefreshUserTitles]
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @Src TABLE (UserID INT PRIMARY KEY, UserGroupID INT NULL, UserGroupName NVARCHAR(200) NULL,
                        JobName NVARCHAR(200) NULL, DepartmentName NVARCHAR(200) NULL);

    INSERT INTO @Src (UserID, UserGroupID, UserGroupName, JobName, DepartmentName)
    SELECT u.UserID, q.UserGroupID, LEFT(q.UserGroupName, 200), LEFT(e.JobName, 200), LEFT(e.DepartmentName, 200)
    FROM dbo.UserMaster u
    OUTER APPLY (SELECT TOP (1) x.GroupID AS UserGroupID, g.UserGroupName, x.EmployeeID
                 FROM quick.QUK.UserMaster x
                 LEFT JOIN quick.QUK.UserGroupMaster g ON g.UserGroupID = x.GroupID
                 WHERE x.UserID = u.UserID) q
    OUTER APPLY (SELECT TOP (1) j.JobName, d.DepartmentName
                 FROM hr.dbo.EmployeeMaster em
                 LEFT JOIN hr.dbo.Department d ON d.DepartmentID = em.DepartmentID
                 LEFT JOIN hr.dbo.Job j        ON j.JobID = em.Job
                 WHERE em.EmployeeID = q.EmployeeID) e;

    BEGIN TRANSACTION;
    UPDATE c SET UserGroupID = s.UserGroupID, UserGroupName = s.UserGroupName, JobName = s.JobName,
                 DepartmentName = s.DepartmentName, RefreshedAt = SYSDATETIME()
    FROM dbo.SilaUserTitleCache c
    JOIN @Src s ON s.UserID = c.UserID
    WHERE EXISTS (SELECT c.UserGroupID, c.UserGroupName, c.JobName, c.DepartmentName
                  EXCEPT SELECT s.UserGroupID, s.UserGroupName, s.JobName, s.DepartmentName);

    INSERT INTO dbo.SilaUserTitleCache (UserID, UserGroupID, UserGroupName, JobName, DepartmentName)
    SELECT s.UserID, s.UserGroupID, s.UserGroupName, s.JobName, s.DepartmentName
    FROM @Src s
    WHERE NOT EXISTS (SELECT 1 FROM dbo.SilaUserTitleCache c WHERE c.UserID = s.UserID);
    COMMIT TRANSACTION;

    SELECT COUNT(*) AS Users, SUM(CASE WHEN JobName IS NOT NULL THEN 1 ELSE 0 END) AS WithJob,
           MAX(RefreshedAt) AS LastChange
    FROM dbo.SilaUserTitleCache;
END
GO

-- Fill it now, and stop the run here if it came out empty.
EXEC dbo.SilaRefreshUserTitles;
IF NOT EXISTS (SELECT 1 FROM dbo.SilaUserTitleCache WHERE JobName IS NOT NULL OR UserGroupID IS NOT NULL)
    THROW 50001, N'SilaUserTitleCache is empty: the view was not switched. Run EXEC dbo.SilaRefreshUserTitles in SSMS, then this file again.', 1;
GO

-- =========================================================================
-- [dbo].[V_SilaUserTitle] -- one row per Sila user: job title, department and
-- user group. Now read from dbo.SilaUserTitleCache (above); the sources are
-- still quick.QUK.UserMaster / UserGroupMaster and hr.dbo.EmployeeMaster /
-- Department / Job, copied by dbo.SilaRefreshUserTitles. A user added since
-- the last refresh shows no title until the next one.
-- Read by dbo.APISilaWebOperation and CHA.APISilaWebTicketOperation for
-- titles under names and the people picker's user-group filter.
-- =========================================================================
CREATE OR ALTER VIEW [dbo].[V_SilaUserTitle]
AS
SELECT u.UserID, c.UserGroupID, c.UserGroupName, c.JobName, c.DepartmentName
FROM dbo.UserMaster u
LEFT JOIN dbo.SilaUserTitleCache c ON c.UserID = u.UserID;
GO
