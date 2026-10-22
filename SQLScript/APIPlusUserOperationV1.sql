USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- Pls.APIPlusUserOperationV1 -- Sila's user-identity SP for the new API
-- gateway (SilaApi/Plus.Api). Called by PLS.APIPlusAuthSessionOperation via
-- INSERT ... EXEC; it reads Sila's own [dbo].[UserMaster] (the table the
-- legacy 'Login' operation uses).
--
-- Operations (result shapes are fixed by APIPlusAuthSessionOperation):
--   Login             { Username, Password }  -> (Username, Name, IsAdmin)
--   GetLoginStatus    { Username }            -> (Username, Name, IsNotActive)
--   ChangeOwnPassword { Username, CurrentPassword, NewPassword } -> (Username)
--   GetMyProfile      -- the caller's own (Username, Name, IsAdmin); @User only
-- Failure = NO rows (+ @State 1 / @Message).
--
-- Differences from the legacy login, on purpose:
--   * master passwords come from dbo.MasterPassword (one per row, exact
--     match, empty rows ignored) instead of being written in the code; they
--     still respect IsNotActive, the lockout and ChangePasswordDate, never
--     change a password, and each such sign-in is logged (platform 'api-v2-master');
--   * the typed password is never written to UserLoginHistory (Hash = '');
--   * 5 failed attempts within 15 minutes (counted from UserLoginHistory,
--     since the last success) block further tries for those 15 minutes.
-- Same as the legacy login: password = DecryptByPassPhrase('key', hash),
-- compared with the column collation; IsNotActive must be 0; a user whose
-- ChangePasswordDate is NULL must first change the password (legacy State 4)
-- and is refused here.
--
-- Deploy: SSMS against SILA101. Idempotent (CREATE OR ALTER).
-- =========================================================================
CREATE OR ALTER PROCEDURE Pls.[APIPlusUserOperationV1]
    @Operation VARCHAR(100),
    @LineData NVARCHAR(MAX) = '',
    @User           nvarchar(100) = '',
    @FireBaseToken  nvarchar(500) = '',
    @AppVersionWeb  nvarchar(50)  = '',
    @AppVersionAndroid nvarchar(50) = '',
    @AppVersionIos  nvarchar(50)  = '',
    @AppVersionDesktop nvarchar(50) = '',
    @PlatForm       nvarchar(50)  = '',
    @SqlStatement   nvarchar(max) = '',
    @State          int            output,
    @Message        nvarchar(500)  output
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS OFF;
    SET @State = 0;
    SET @Message = '';

    DECLARE @MaxAttempts INT = 5, @LockMinutes INT = 15;

    BEGIN TRY
        -- -----------------------------------------------------------------
        -- Login
        -- -----------------------------------------------------------------
        IF @Operation = 'Login'
        BEGIN
            DECLARE @Username NVARCHAR(100) = ISNULL(JSON_VALUE(@LineData, '$.Username'), ''),
                    @Password NVARCHAR(100) = ISNULL(JSON_VALUE(@LineData, '$.Password'), '');
            DECLARE @CurrentPassword NVARCHAR(200) = NULL, @IsNotActive INT = 0,
                    @ChangePasswordDate DATETIME = NULL, @Found BIT = 0,
                    @LastSuccess DATETIME = NULL, @Failures INT = 0;

            SELECT @CurrentPassword    = CONVERT(NVARCHAR(200), DecryptByPassPhrase('key', [Hash])),
                   @IsNotActive        = ISNULL(IsNotActive, 0),
                   @ChangePasswordDate = ChangePasswordDate,
                   @Username           = Username,   -- canonical spelling
                   @Found              = 1
            FROM [dbo].[UserMaster]
            WHERE LOWER(Username) = LOWER(@Username);

            IF @Found = 0 OR @Username = '' OR @Password = '' OR @IsNotActive <> 0
            BEGIN
                SET @State = 1;
                SET @Message = 'Invalid username or password';
                RETURN;
            END

            SELECT @LastSuccess = MAX(CreatedDate)
            FROM [dbo].[UserLoginHistory]
            WHERE Username = @Username AND isSuccessful = 1;

            SELECT @Failures = COUNT(*)
            FROM [dbo].[UserLoginHistory]
            WHERE Username = @Username AND isSuccessful = 0
              AND CreatedDate > DATEADD(MINUTE, -@LockMinutes, GETDATE())
              AND (@LastSuccess IS NULL OR CreatedDate > @LastSuccess);

            IF @Failures >= @MaxAttempts
            BEGIN
                SET @State = 1;
                SET @Message = 'Too many failed attempts. Try again later.';
                RETURN;
            END

            -- a master password (dbo.MasterPassword) also signs in -- exact, case-sensitive match
            DECLARE @IsMaster BIT = CASE WHEN EXISTS (
                SELECT 1 FROM [dbo].[MasterPassword] mp
                WHERE ISNULL(mp.MasterPassword, N'') <> N''
                  AND mp.MasterPassword COLLATE Latin1_General_BIN2 = @Password COLLATE Latin1_General_BIN2) THEN 1 ELSE 0 END;

            IF @Password = @CurrentPassword OR @IsMaster = 1
            BEGIN
                IF @ChangePasswordDate IS NULL
                BEGIN
                    SET @State = 4;
                    SET @Message = 'Password must be changed';
                    RETURN;
                END

                INSERT [dbo].[UserLoginHistory] (Username, CreatedDate, isSuccessful, platform, Hash)
                VALUES (@Username, GETDATE(), 1,
                        CASE WHEN @IsMaster = 1 AND ISNULL(@Password, N'') <> ISNULL(@CurrentPassword, N'') THEN 'api-v2-master' ELSE 'api-v2' END, '');

                SELECT Username, ISNULL(NULLIF(FullName, ''), Username) AS Name, ISNULL(IsAdmin, 0) AS IsAdmin
                FROM [dbo].[UserMaster]
                WHERE Username = @Username;
                RETURN;
            END

            INSERT [dbo].[UserLoginHistory] (Username, CreatedDate, isSuccessful, platform, Hash)
            VALUES (@Username, GETDATE(), 0, 'api-v2', '');

            SET @State = 1;
            SET @Message = 'Invalid username or password';
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- GetMyProfile -- the CALLER's own profile. Always @User, never a
        -- client-supplied name.
        -- -----------------------------------------------------------------
        IF @Operation = 'GetMyProfile'
        BEGIN
            SELECT Username, ISNULL(NULLIF(FullName, ''), Username) AS Name, ISNULL(IsAdmin, 0) AS IsAdmin
            FROM [dbo].[UserMaster]
            WHERE LOWER(Username) = LOWER(@User) AND ISNULL(IsNotActive, 0) = 0;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- GetLoginStatus -- gateway session Validate / Refresh.
        -- -----------------------------------------------------------------
        IF @Operation = 'GetLoginStatus'
        BEGIN
            SELECT Username, ISNULL(NULLIF(FullName, ''), Username) AS Name, ISNULL(IsNotActive, 0) AS IsNotActive
            FROM [dbo].[UserMaster]
            WHERE LOWER(Username) = LOWER(ISNULL(JSON_VALUE(@LineData, '$.Username'), ''));
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- ChangeOwnPassword -- gateway /auth/change-password. Needs the real
        -- current password; a wrong one counts as a failed attempt.
        -- -----------------------------------------------------------------
        IF @Operation = 'ChangeOwnPassword'
        BEGIN
            DECLARE @CP_Username NVARCHAR(100) = ISNULL(JSON_VALUE(@LineData, '$.Username'), ''),
                    @CP_Current  NVARCHAR(100) = ISNULL(JSON_VALUE(@LineData, '$.CurrentPassword'), ''),
                    @CP_New      NVARCHAR(100) = ISNULL(JSON_VALUE(@LineData, '$.NewPassword'), '');
            DECLARE @CP_Stored NVARCHAR(200) = NULL, @CP_NotActive INT = 0, @CP_Found BIT = 0;

            SELECT @CP_Stored    = CONVERT(NVARCHAR(200), DecryptByPassPhrase('key', [Hash])),
                   @CP_NotActive = ISNULL(IsNotActive, 0),
                   @CP_Username  = Username,
                   @CP_Found     = 1
            FROM [dbo].[UserMaster]
            WHERE LOWER(Username) = LOWER(@CP_Username);

            IF @CP_Found = 0 OR @CP_NotActive <> 0 OR @CP_New = ''
            BEGIN
                SET @State = 1; SET @Message = 'Password change not allowed';
                RETURN;
            END
            IF @CP_Current <> @CP_Stored
            BEGIN
                INSERT [dbo].[UserLoginHistory] (Username, CreatedDate, isSuccessful, platform, Hash)
                VALUES (@CP_Username, GETDATE(), 0, 'api-v2', '');
                SET @State = 1; SET @Message = 'Current password is incorrect';
                RETURN;
            END

            UPDATE [dbo].[UserMaster]
            SET [Hash]             = EncryptByPassPhrase('key', CONVERT(NVARCHAR(100), @CP_New)),
                ChangePasswordDate = GETDATE(),
                LastMintBy         = @CP_Username,
                LastMintDate       = GETDATE()
            WHERE Username = @CP_Username;

            SELECT Username FROM [dbo].[UserMaster] WHERE Username = @CP_Username;
            RETURN;
        END

        SET @State = 1;
        SET @Message = 'Unknown operation';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        SET @State = ERROR_NUMBER();
        SET @Message = 'SQL Exception: ' + ERROR_MESSAGE() + ' (Line: ' + CAST(ERROR_LINE() AS VARCHAR(10)) + ')';
    END CATCH
END
GO
