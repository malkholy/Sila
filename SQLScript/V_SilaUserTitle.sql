USE [SILA101]
GO
-- =========================================================================
-- [dbo].[V_SilaUserTitle] -- one row per Sila user: job title, department and
-- user group, from where they really live (the same sources as the mobile
-- app's dbo.V_UserMaster_1): quick.QUK.UserMaster / UserGroupMaster for the
-- user group and the employee, hr.dbo.EmployeeMaster / Department / Job for
-- the job and department. dbo.UserJobMaster / UserDepartmentMaster in SILA101
-- are nearly empty (1 of 435 active users had a job, 2026-10-22).
--
-- Since 2026-10-26 read from dbo.SilaUserTitleCache, refilled from quick /
-- HR by dbo.SilaRefreshUserTitles (SilaUserTitleCache.sql -- deploy that file,
-- not this one, first: it creates the table and fills it).
--
-- Read by the web procedures (dbo.APISilaWebOperation,
-- CHA.APISilaWebTicketOperation) for titles under names and the people
-- picker's user-group filter. TOP (1) per user: a duplicate row in quick / HR
-- never duplicates a person (applied by the refresh).
-- Idempotent (CREATE OR ALTER).
-- =========================================================================
CREATE OR ALTER VIEW [dbo].[V_SilaUserTitle]
AS
SELECT u.UserID, c.UserGroupID, c.UserGroupName, c.JobName, c.DepartmentName
FROM dbo.UserMaster u
LEFT JOIN dbo.SilaUserTitleCache c ON c.UserID = u.UserID;
GO
