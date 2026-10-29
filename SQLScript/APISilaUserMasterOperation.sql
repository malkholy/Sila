USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- dbo.APISilaUserMasterOperation -- System Settings > User Master writes:
-- add a user, edit a user, reset a password, deactivate / re-activate.
-- Called by the web app through SilaApi /api/v2/exec (src/shared/settings.js).
-- Only the user 'mhd' -- checked here, the app just hides the buttons. The
-- master list itself stays 'Settings users' in dbo.APISilaWebOperation.
--
-- Operations (inputs in LineData; @User comes from the signed-in token):
--   Save user    { UserID (0 = new), Username (new only), Password (new only),
--                  FullName, MobileNumber, LocalNumber, EmailAddress,
--                  EmployeeID, GroupID, IsAdmin: 1|0 }  -> { UserID }
--                  The username never changes after creation.
--   Reset user password { UserID, Password }  the new password works at once
--                  (ChangePasswordDate = now: a NULL date would lock the user out
--                  of the web, which refuses "must change" accounts). Every
--                  web session of the user ends.
--   Reset login attempts { UserID }  the failed sign-ins before now no longer
--                  count toward the lockout (5 within 15 minutes, checked by
--                  Pls.APIPlusUserOperationV1): dbo.SilaLoginAttemptReset. Reset
--                  user password does the same.
--   Set user active     { UserID, Active: 1|0 }  not the caller.
--                  Deactivating ends the user's web sessions and drops the push tokens;
--                  dbo.TrgUserMasterBroadcastGroups moves the user out of / back into
--                  the broadcast groups.
--
-- Passwords are stored like the legacy login reads them:
-- EncryptByPassPhrase('key', <nvarchar>) in UserMaster.Hash; 6 to 30 characters
-- (the legacy login reads the hash back as nvarchar(30)). Never returned, never logged.
--
-- NOTE: Migration/Manual_InsertSelect_UserMaster.sql is a full reload from
-- Quick: users added or edited here are replaced by Quick's on its next run.
--
-- Deploy: SSMS against SILA101 (a user / password procedure: not deploy.sh).
-- Run before APIPlusUserOperationV1.sql and APISilaWebOperation.sql, which
-- read dbo.SilaLoginAttemptReset. Idempotent: CREATE OR ALTER + MERGE.
-- =========================================================================

-- When an admin last cleared a user's failed sign-ins (one row per user).
IF OBJECT_ID(N'[dbo].[SilaLoginAttemptReset]', N'U') IS NULL
CREATE TABLE [dbo].[SilaLoginAttemptReset]
(
    [UserID]  INT           NOT NULL CONSTRAINT [PK_SilaLoginAttemptReset] PRIMARY KEY,
    [ResetAt] DATETIME      NOT NULL,
    [ResetBy] NVARCHAR(250) NOT NULL
);
GO
CREATE OR ALTER PROCEDURE [dbo].[APISilaUserMasterOperation]
    @Operation NVARCHAR(100),
    @User      NVARCHAR(250),
    @LineData  NVARCHAR(MAX) = N'',
    @State     INT           = 0  OUTPUT,
    @Message   NVARCHAR(500) = N'' OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET @State = 0;
    SET @Message = N'';

    BEGIN TRY
        IF ISJSON(@LineData) <> 1 SET @LineData = N'{}';

        IF LOWER(@User) <> N'mhd' OR NOT EXISTS (SELECT 1 FROM dbo.UserMaster WHERE Username = @User AND ISNULL(IsNotActive, 1) = 0)
        BEGIN SET @State = 403; SET @Message = N'System settings are not available for this user.'; RETURN; END

        DECLARE @UID INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT), 0);
        DECLARE @Pwd NVARCHAR(MAX) = JSON_VALUE(@LineData, '$.Password');
        DECLARE @Target NVARCHAR(250);
        DECLARE @Now DATETIME2(3) = SYSUTCDATETIME();

        IF @Operation IN (N'Reset user password', N'Reset login attempts', N'Set user active') OR (@Operation = N'Save user' AND @UID <> 0)
        BEGIN
            SELECT @Target = Username FROM dbo.UserMaster WHERE UserID = @UID;
            IF @Target IS NULL BEGIN SET @State = 404; SET @Message = N'User not found.'; RETURN; END
        END

        -- -----------------------------------------------------------------
        -- Save user: new (UserID 0) or edit
        -- -----------------------------------------------------------------
        IF @Operation = N'Save user'
        BEGIN
            DECLARE @Name NVARCHAR(MAX), @Login NVARCHAR(MAX), @Mobile NVARCHAR(MAX), @Local NVARCHAR(MAX),
                    @Email NVARCHAR(MAX), @EmpText NVARCHAR(MAX), @GroupID INT, @IsAdmin INT;
            SELECT @Login   = LTRIM(RTRIM(ISNULL(Username, N''))),
                   @Name    = LTRIM(RTRIM(ISNULL(FullName, N''))),
                   @Mobile  = LTRIM(RTRIM(ISNULL(MobileNumber, N''))),
                   @Local   = LTRIM(RTRIM(ISNULL(LocalNumber, N''))),
                   @Email   = NULLIF(LTRIM(RTRIM(ISNULL(EmailAddress, N''))), N''),
                   @EmpText = NULLIF(LTRIM(RTRIM(ISNULL(EmployeeID, N''))), N''),
                   @GroupID = ISNULL(TRY_CAST(GroupID AS INT), 0),
                   @IsAdmin = CASE WHEN TRY_CAST(IsAdmin AS INT) = 1 THEN 1 ELSE 0 END
            FROM OPENJSON(@LineData) WITH (Username NVARCHAR(MAX), FullName NVARCHAR(MAX), MobileNumber NVARCHAR(MAX),
                 LocalNumber NVARCHAR(MAX), EmailAddress NVARCHAR(MAX), EmployeeID NVARCHAR(MAX), GroupID NVARCHAR(50), IsAdmin NVARCHAR(10));

            IF @Name = N'' BEGIN SET @State = 1; SET @Message = N'Enter the full name.'; RETURN; END
            IF LEN(@Name) > 100 BEGIN SET @State = 1; SET @Message = N'The full name can be at most 100 characters.'; RETURN; END
            IF LEN(@Mobile) > 20 OR LEN(@Local) > 10
            BEGIN SET @State = 1; SET @Message = N'The mobile can be at most 20 characters, the extension 10.'; RETURN; END
            IF @Email IS NOT NULL AND (LEN(@Email) > 256 OR @Email NOT LIKE N'_%@_%._%' OR @Email LIKE N'% %')
            BEGIN SET @State = 1; SET @Message = N'The email address is not valid.'; RETURN; END
            IF @EmpText IS NOT NULL AND TRY_CAST(@EmpText AS INT) IS NULL
            BEGIN SET @State = 1; SET @Message = N'The HR employee ID must be a number.'; RETURN; END
            IF @GroupID <> 0 AND NOT EXISTS (SELECT 1 FROM dbo.UserGroupMaster WHERE GroupID = @GroupID)
            BEGIN SET @State = 1; SET @Message = N'The user group does not exist.'; RETURN; END
            IF @UID <> 0 AND @IsAdmin = 0 AND LOWER(@Target) = LOWER(@User)
            BEGIN SET @State = 1; SET @Message = N'You cannot remove your own admin role.'; RETURN; END

            IF @UID = 0
            BEGIN
                IF @Login = N'' BEGIN SET @State = 1; SET @Message = N'Enter the username.'; RETURN; END
                IF LEN(@Login) > 30 OR LEN(@Login) < 2 OR @Login LIKE N'%[^a-zA-Z0-9._-]%'
                BEGIN SET @State = 1; SET @Message = N'The username: 2 to 30 characters, English letters, digits and . _ - only.'; RETURN; END
                IF EXISTS (SELECT 1 FROM dbo.UserMaster WHERE LOWER(Username) = LOWER(@Login))
                BEGIN SET @State = 1; SET @Message = N'Another user already has this username.'; RETURN; END
                IF LEN(ISNULL(@Pwd, N'')) < 6 OR LEN(@Pwd) > 30
                BEGIN SET @State = 1; SET @Message = N'The password must be 6 to 30 characters.'; RETURN; END

                DECLARE @PwdN NVARCHAR(30) = @Pwd;
                INSERT INTO dbo.UserMaster (Username, FullName, Hash, MobileNumber, LocalNumber, GroupID, IsAdmin, IsNotActive,
                                            CreatedBy, CreatedDate, LastMintBy, LastMintDate, AttachmentID, ForceLogout, IsDeveloper,
                                            DepartmentID, JobID, EmployeeID, EmailAddress, ChangePasswordDate)
                VALUES (@Login, @Name, EncryptByPassPhrase('key', @PwdN), @Mobile, @Local, @GroupID, @IsAdmin, 0,
                        @User, GETDATE(), @User, GETDATE(), 0, 0, 0,
                        0, 0, TRY_CAST(@EmpText AS INT), @Email, GETDATE());
                SET @UID = SCOPE_IDENTITY();
            END
            ELSE
                UPDATE dbo.UserMaster
                SET FullName = @Name, MobileNumber = @Mobile, LocalNumber = @Local, GroupID = @GroupID, IsAdmin = @IsAdmin,
                    EmployeeID = TRY_CAST(@EmpText AS INT), EmailAddress = @Email, LastMintBy = @User, LastMintDate = GETDATE()
                WHERE UserID = @UID;

            SELECT @UID AS UserID;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Reset user password
        -- -----------------------------------------------------------------
        IF @Operation = N'Reset user password'
        BEGIN
            IF LEN(ISNULL(@Pwd, N'')) < 6 OR LEN(@Pwd) > 30
            BEGIN SET @State = 1; SET @Message = N'The password must be 6 to 30 characters.'; RETURN; END
            DECLARE @NewPwd NVARCHAR(30) = @Pwd;

            BEGIN TRANSACTION;
                UPDATE dbo.UserMaster
                SET Hash = EncryptByPassPhrase('key', @NewPwd), ChangePasswordDate = GETDATE(), LastMintBy = @User, LastMintDate = GETDATE()
                WHERE UserID = @UID;
                -- a new stamp ends every web session of the user (PLS.APIPlusAuthSessionOperation)
                UPDATE [PLS].[V1ApiIdentity] SET CredentialStamp = NEWID() WHERE Username = @Target;
                UPDATE s SET RevokedAt = @Now, RevokedReason = 'PasswordReset'
                FROM [PLS].[V1ApiSession] s JOIN [PLS].[V1ApiIdentity] i ON i.Subject = s.Subject
                WHERE i.Username = @Target AND s.RevokedAt IS NULL;
                -- a new password starts with a clean count
                MERGE [dbo].[SilaLoginAttemptReset] AS t
                USING (SELECT @UID AS UserID) AS x ON t.UserID = x.UserID
                WHEN MATCHED THEN UPDATE SET ResetAt = GETDATE(), ResetBy = @User
                WHEN NOT MATCHED THEN INSERT (UserID, ResetAt, ResetBy) VALUES (@UID, GETDATE(), @User);
            COMMIT;

            SELECT @UID AS UserID;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Reset login attempts: unlock without changing the password
        -- -----------------------------------------------------------------
        IF @Operation = N'Reset login attempts'
        BEGIN
            MERGE [dbo].[SilaLoginAttemptReset] AS t
            USING (SELECT @UID AS UserID) AS x ON t.UserID = x.UserID
            WHEN MATCHED THEN UPDATE SET ResetAt = GETDATE(), ResetBy = @User
            WHEN NOT MATCHED THEN INSERT (UserID, ResetAt, ResetBy) VALUES (@UID, GETDATE(), @User);

            SELECT @UID AS UserID;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Set user active (deactivate / re-activate)
        -- -----------------------------------------------------------------
        IF @Operation = N'Set user active'
        BEGIN
            DECLARE @Active INT = TRY_CAST(JSON_VALUE(@LineData, '$.Active') AS INT);
            IF @Active NOT IN (0, 1) OR @Active IS NULL BEGIN SET @State = 1; SET @Message = N'Active must be 1 or 0.'; RETURN; END
            IF LOWER(@Target) = LOWER(@User) BEGIN SET @State = 1; SET @Message = N'You cannot deactivate yourself.'; RETURN; END

            BEGIN TRANSACTION;
                UPDATE dbo.UserMaster SET IsNotActive = 1 - @Active, LastMintBy = @User, LastMintDate = GETDATE()
                WHERE UserID = @UID AND ISNULL(IsNotActive, 0) <> 1 - @Active;
                IF @Active = 0
                BEGIN
                    UPDATE s SET RevokedAt = @Now, RevokedReason = 'Disabled'
                    FROM [PLS].[V1ApiSession] s JOIN [PLS].[V1ApiIdentity] i ON i.Subject = s.Subject
                    WHERE i.Username = @Target AND s.RevokedAt IS NULL;
                    DELETE FROM dbo.UserFireBaseHistory WHERE UserID = @UID;
                END
            COMMIT;

            SELECT @UID AS UserID, @Active AS Active;
            RETURN;
        END

        SET @State = 1;
        SET @Message = N'Unknown operation.';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        SET @State = ERROR_NUMBER();
        SET @Message = LEFT(N'SQL Exception: ' + ERROR_MESSAGE() + N' (Line: ' + CAST(ERROR_LINE() AS NVARCHAR(10)) + N')', 500);
    END CATCH
END
GO

-- -------------------------------------------------------------------------
-- Allow-list rows (PLS.V1ApiOperationPermission). The SP authorizes the
-- caller itself; inputs travel in LineData: no extra parameters.
-- -------------------------------------------------------------------------
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'dbo.APISilaUserMasterOperation', N'Save user',           N'System Settings (mhd only, checked in the SP): add a user or edit one (not the username)'),
    (N'dbo.APISilaUserMasterOperation', N'Reset user password', N'System Settings (mhd only, checked in the SP): set a user''s password, ends the user''s web sessions'),
    (N'dbo.APISilaUserMasterOperation', N'Reset login attempts', N'System Settings (mhd only, checked in the SP): clear a user''s failed sign-ins (unlock)'),
    (N'dbo.APISilaUserMasterOperation', N'Set user active',     N'System Settings (mhd only, checked in the SP): deactivate / re-activate a user')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, N'[]', s.Notes, N'claude');
GO
