-- ============================================================================
-- Manual INSERT...SELECT migration: Quick.QUK.UserMaster -> Sila101 dbo.UserMaster
-- Run this ON Sila101 in SSMS (it reads the [quick] database on the same
-- instance; for a linked server replace [quick] below with its path, e.g.
-- [QUICKSERVER].[quick].[QUK].[UserMaster]). Run it FIRST: the chat scripts
-- look users up here.
--
-- FULL RELOAD (standing decision): every run deletes every Sila user and
-- copies them again from Quick, in one transaction.
--
-- Mapping:
--   - Rows with a NULL Username skipped (Sila's Username is NOT NULL).
--   - EmployeeID copied (the HR EmployeeMaster key; must be a number).
--   - GroupID: the Sila dbo.UserGroupMaster group with the same name as the
--     user's Quick group (trimmed). A Quick group Sila does not have yet is
--     added to UserGroupMaster first; UserGroupMaster itself is never emptied
--     (Sila's own groups -- Developers, IT, Color Centers -- stay). Quick group
--     0 or without a name -> 0.
--   - EmailAddress is Sila-only (Quick has none): kept across the reload by
--     UserID.
--   - DepartmentID / JobID = 0 (Sila-only, no source on Quick).
--   - Quick-only ID (surrogate) dropped.
--
-- dbo.TrgUserMasterBroadcastGroups is off for the copy; broadcast group
-- members are rebuilt with the GRP schema (EXEC dbo.SilaSyncBroadcastGroup
-- after Manual_InsertSelect_GRPSchema_All.sql). At the end the job-title cache
-- is refreshed (dbo.SilaRefreshUserTitles).
--
-- quick's text is Arabic_CI_AS, Sila's Arabic_100_CI_AS: compared in Sila's
-- collation (COLLATE DATABASE_DEFAULT).
-- ============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF COL_LENGTH(N'dbo.UserMaster', N'EmployeeID') IS NULL
    ALTER TABLE dbo.UserMaster ADD EmployeeID INT NULL;
IF COL_LENGTH(N'dbo.UserMaster', N'EmailAddress') IS NULL
    ALTER TABLE dbo.UserMaster ADD EmailAddress NVARCHAR(256) NULL;
GO

BEGIN TRY
    IF EXISTS (SELECT 1 FROM quick.QUK.UserMaster
               WHERE EmployeeID IS NOT NULL AND TRY_CAST(EmployeeID AS INT) IS NULL)
        THROW 50001, N'quick.QUK.UserMaster.EmployeeID has values that are not numbers -- nothing was changed.', 1;

    BEGIN TRANSACTION;

    -- Sila-only values to put back after the reload
    DECLARE @Keep TABLE (UserID INT PRIMARY KEY, EmailAddress NVARCHAR(256) NOT NULL);
    INSERT INTO @Keep (UserID, EmailAddress)
    SELECT UserID, EmailAddress FROM dbo.UserMaster WHERE NULLIF(LTRIM(RTRIM(EmailAddress)), N'') IS NOT NULL;

    -- Quick groups Sila does not have yet
    INSERT INTO dbo.UserGroupMaster (GroupName, CreatedBy, CreatedDate, LastMintBy, LastMintDate)
    SELECT DISTINCT LTRIM(RTRIM(g.UserGroupName)) COLLATE DATABASE_DEFAULT, N'migration', GETDATE(), N'migration', GETDATE()
    FROM quick.QUK.UserGroupMaster g
    WHERE NULLIF(LTRIM(RTRIM(g.UserGroupName)), N'') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dbo.UserGroupMaster s
                      WHERE LTRIM(RTRIM(s.GroupName)) = LTRIM(RTRIM(g.UserGroupName)) COLLATE DATABASE_DEFAULT);

    DISABLE TRIGGER ALL ON dbo.UserMaster;
    DELETE FROM dbo.UserMaster;

    SET IDENTITY_INSERT dbo.UserMaster ON;

    INSERT INTO dbo.UserMaster (
        UserID, Username, FullName, Hash, MobileNumber, LocalNumber,
        GroupID, IsAdmin, IsNotActive, CreatedBy, CreatedDate,
        LastMintBy, LastMintDate, AttachmentID, ForceLogout, IsDeveloper,
        DepartmentID, JobID, EmployeeID, EmailAddress
    )
    SELECT
        q.UserID, q.Username, q.FullName, q.Hash, q.MobileNumber, q.LocalNumber,
        ISNULL(s.GroupID, 0) AS GroupID, q.IsAdmin, q.IsNotActive, q.CreatedBy, q.CreatedDate,
        q.LastMintBy, q.LastMintDate, q.AttachmentID, q.ForceLogout, q.IsDeveloper,
        0 AS DepartmentID, 0 AS JobID, TRY_CAST(q.EmployeeID AS INT) AS EmployeeID, k.EmailAddress
    FROM quick.QUK.UserMaster q
    LEFT JOIN quick.QUK.UserGroupMaster g ON g.UserGroupID = q.GroupID
    OUTER APPLY (SELECT TOP (1) y.GroupID FROM dbo.UserGroupMaster y      -- lowest GroupID if Sila has twins
                 WHERE LTRIM(RTRIM(y.GroupName)) = LTRIM(RTRIM(g.UserGroupName)) COLLATE DATABASE_DEFAULT
                 ORDER BY y.GroupID) s
    LEFT JOIN @Keep k ON k.UserID = q.UserID
    WHERE q.Username IS NOT NULL;

    SET IDENTITY_INSERT dbo.UserMaster OFF;

    DECLARE @MaxUserID INT = (SELECT ISNULL(MAX(UserID), 0) FROM dbo.UserMaster);
    DBCC CHECKIDENT('dbo.UserMaster', RESEED, @MaxUserID) WITH NO_INFOMSGS;

    ENABLE TRIGGER ALL ON dbo.UserMaster;
    COMMIT TRANSACTION;

    SELECT COUNT(*) AS RowsInUserMaster,
           SUM(CASE WHEN u.EmployeeID IS NOT NULL THEN 1 ELSE 0 END) AS WithEmployeeID,
           SUM(CASE WHEN u.EmailAddress IS NOT NULL THEN 1 ELSE 0 END) AS WithEmail,
           SUM(CASE WHEN u.GroupID = 0 THEN 1 ELSE 0 END) AS NoGroup,
           SUM(CASE WHEN u.GroupID <> 0 AND g.GroupID IS NULL THEN 1 ELSE 0 END) AS InUnknownGroup
    FROM dbo.UserMaster u
    LEFT JOIN dbo.UserGroupMaster g ON g.GroupID = u.GroupID;

    -- emails kept for a user who is no longer in Quick (lost with him)
    SELECT k.UserID, k.EmailAddress AS EmailNotKept
    FROM @Keep k WHERE NOT EXISTS (SELECT 1 FROM dbo.UserMaster u WHERE u.UserID = k.UserID);
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    -- SET IDENTITY_INSERT is a session setting that ROLLBACK does not undo
    BEGIN TRY SET IDENTITY_INSERT dbo.UserMaster OFF; END TRY BEGIN CATCH END CATCH;
    SELECT ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;
    RETURN;
END CATCH;

EXEC dbo.SilaRefreshUserTitles;
GO
