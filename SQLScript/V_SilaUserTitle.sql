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
-- Used by the web procedures (dbo.APISilaWebOperation,
-- CHA.APISilaWebTicketOperation) for titles under names and the people
-- picker's user-group filter. TOP (1) per user: a duplicate row in quick / HR
-- never duplicates a person. Callers need read access to the quick and HR
-- databases (the SilaApi / gateway SQL login has it).
-- Idempotent (CREATE OR ALTER).
-- =========================================================================
CREATE OR ALTER VIEW [dbo].[V_SilaUserTitle]
AS
SELECT u.UserID, q.UserGroupID, q.UserGroupName, e.JobName, e.DepartmentName
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
GO
