USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- PLS.APIPlusAuthSessionOperation -- session store for the new API gateway
-- (SilaApi/Plus.Api, Auth/SqlAuthStore.cs). Called ONLY by the gateway's
-- /api/v2/auth/* endpoints; the gateway refuses it through /api/v2/exec.
--
-- GENERIC: identical in every project. It only touches the gateway tables
-- (SQLScript/V1ApiTables.sql). Everything about the project's own users --
-- where UserMaster lives, how passwords are stored, lockout -- is delegated
-- to that project's Pls.APIPlusUserOperationV1:
--   'Login'             -> checks the password (+ attempt counter)
--   'GetLoginStatus'    -> is the user still active? (Validate / Refresh)
--   'ChangeOwnPassword' -> verifies the current password, stores the new one
--
-- Operations (parameters fixed by SqlAuthStore.cs):
--   Login          @Username, @Password, @SessionId, @NewRefreshHash
--   Refresh        @RefreshHash, @NewRefreshHash
--   Validate       @SessionId            (every gateway request)
--   Logout         @SessionId
--   ChangePassword @SessionId, @Password (current), @NewPassword
--
-- Result contract: success = exactly ONE row
--   (Subject, SessionId, Username, DisplayName, ForcePasswordChange, ExpiresAt[UTC])
-- failure = NO rows (the gateway answers 401 with a generic message).
-- Logout returns no rows.
--
-- Deploy: SSMS against SILA101 (a page-business-style SP, not the router SP).
-- =========================================================================
CREATE OR ALTER PROCEDURE [PLS].[APIPlusAuthSessionOperation]
    @Operation      VARCHAR(30),
    @ClientIP       VARCHAR(45)      = '',
    @Username       NVARCHAR(100)    = NULL,
    @Password       NVARCHAR(100)    = NULL,
    @NewPassword    NVARCHAR(100)    = NULL,
    @SessionId      UNIQUEIDENTIFIER = NULL,
    @RefreshHash    BINARY(32)       = NULL,
    @NewRefreshHash BINARY(32)       = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @SessionDays INT = 7;
    DECLARE @Now DATETIME2(3) = SYSUTCDATETIME();

    DECLARE @LineData NVARCHAR(MAX), @UState INT, @UMessage NVARCHAR(500);
    DECLARE @Subject UNIQUEIDENTIFIER, @Stamp UNIQUEIDENTIFIER, @Sid UNIQUEIDENTIFIER,
            @IdUser NVARCHAR(100), @DisplayName NVARCHAR(200),
            @ExpiresAt DATETIME2(3), @Force BIT = 0, @Consumed DATETIME2(3);

    -- Result shapes of Pls.APIPlusUserOperationV1 (captured with INSERT ... EXEC).
    CREATE TABLE #Login   (Username NVARCHAR(100), Name NVARCHAR(MAX), IsAdmin INT);
    CREATE TABLE #Status  (Username NVARCHAR(100), Name NVARCHAR(MAX), IsNotActive INT);
    CREATE TABLE #Changed (Username NVARCHAR(100));

    BEGIN TRY
        -- -----------------------------------------------------------------
        -- Login
        -- The password check runs OUTSIDE any transaction here, so the
        -- user SP's failed-attempt counter update is never rolled back.
        -- -----------------------------------------------------------------
        IF @Operation = 'Login'
        BEGIN
            IF @SessionId IS NULL OR @NewRefreshHash IS NULL
               OR ISNULL(@Username, '') = '' OR ISNULL(@Password, '') = '' RETURN;

            SET @LineData = (SELECT @Username AS Username, @Password AS Password
                             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER);
            INSERT #Login
            EXEC Pls.[APIPlusUserOperationV1] @Operation = 'Login', @LineData = @LineData, @User = @Username,
                 @State = @UState OUTPUT, @Message = @UMessage OUTPUT;

            IF ISNULL(@UState, 1) <> 0 OR (SELECT COUNT(*) FROM #Login) <> 1 RETURN;
            SELECT @IdUser = Username, @DisplayName = ISNULL(NULLIF(Name, ''), Username) FROM #Login;

            BEGIN TRAN;
                SELECT @Subject = Subject, @Stamp = CredentialStamp
                FROM [PLS].[V1ApiIdentity] WITH (UPDLOCK, HOLDLOCK)
                WHERE Username = @IdUser;

                IF @Subject IS NULL
                BEGIN
                    SELECT @Subject = NEWID(), @Stamp = NEWID();
                    INSERT [PLS].[V1ApiIdentity] (Subject, Username, CredentialStamp)
                    VALUES (@Subject, @IdUser, @Stamp);
                END

                UPDATE [PLS].[V1ApiIdentity] SET LastLoginAt = @Now WHERE Subject = @Subject;

                SET @ExpiresAt = DATEADD(DAY, @SessionDays, @Now);
                INSERT [PLS].[V1ApiSession]
                    (SessionId, Subject, CredentialStamp, ForcePasswordChange, CreatedAt, ExpiresAt, LastSeenAt, CreatedIP, LastIP)
                VALUES (@SessionId, @Subject, @Stamp, 0, @Now, @ExpiresAt, @Now, @ClientIP, @ClientIP);

                INSERT [PLS].[V1ApiRefreshToken] (TokenHash, SessionId, CreatedAt)
                VALUES (@NewRefreshHash, @SessionId, @Now);
            COMMIT;

            SELECT @Subject AS Subject, @SessionId AS SessionId, @IdUser AS Username,
                   @DisplayName AS DisplayName, CAST(0 AS BIT) AS ForcePasswordChange, @ExpiresAt AS ExpiresAt;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Logout
        -- -----------------------------------------------------------------
        IF @Operation = 'Logout'
        BEGIN
            UPDATE [PLS].[V1ApiSession]
            SET RevokedAt = @Now, RevokedReason = 'Logout'
            WHERE SessionId = @SessionId AND RevokedAt IS NULL;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Validate / Refresh / ChangePassword -- all start from a live session.
        -- -----------------------------------------------------------------
        IF @Operation IN ('Validate', 'Refresh', 'ChangePassword')
        BEGIN
            IF @Operation = 'Refresh'
            BEGIN
                IF @RefreshHash IS NULL OR @NewRefreshHash IS NULL RETURN;

                SELECT @Sid = SessionId, @Consumed = ConsumedAt
                FROM [PLS].[V1ApiRefreshToken]
                WHERE TokenHash = @RefreshHash;

                IF @Sid IS NULL RETURN;
                IF @Consumed IS NOT NULL
                BEGIN
                    -- A refresh token used twice means it was copied: kill the session.
                    UPDATE [PLS].[V1ApiSession]
                    SET RevokedAt = @Now, RevokedReason = 'RefreshReuse'
                    WHERE SessionId = @Sid AND RevokedAt IS NULL;
                    RETURN;
                END
            END
            ELSE
                SET @Sid = @SessionId;

            IF @Sid IS NULL RETURN;

            -- Live = not revoked, not expired, and no password change since it started.
            SELECT @Subject = s.Subject, @ExpiresAt = s.ExpiresAt, @Force = s.ForcePasswordChange,
                   @IdUser = i.Username
            FROM [PLS].[V1ApiSession] s
            JOIN [PLS].[V1ApiIdentity] i ON i.Subject = s.Subject
            WHERE s.SessionId = @Sid
              AND s.RevokedAt IS NULL
              AND s.ExpiresAt > @Now
              AND s.CredentialStamp = i.CredentialStamp;

            IF @Subject IS NULL RETURN;

            -- Still allowed in the project's own user table?
            SET @LineData = (SELECT @IdUser AS Username FOR JSON PATH, WITHOUT_ARRAY_WRAPPER);
            INSERT #Status
            EXEC Pls.[APIPlusUserOperationV1] @Operation = 'GetLoginStatus', @LineData = @LineData, @User = @IdUser,
                 @State = @UState OUTPUT, @Message = @UMessage OUTPUT;

            IF NOT EXISTS (SELECT 1 FROM #Status WHERE IsNotActive = 0)
            BEGIN
                UPDATE [PLS].[V1ApiSession]
                SET RevokedAt = @Now, RevokedReason = 'Disabled'
                WHERE SessionId = @Sid AND RevokedAt IS NULL;
                RETURN;
            END
            SELECT TOP (1) @DisplayName = ISNULL(NULLIF(Name, ''), @IdUser) FROM #Status;

            IF @Operation = 'Validate'
            BEGIN
                -- Called on every request: only write LastSeenAt every 5 minutes.
                UPDATE [PLS].[V1ApiSession]
                SET LastSeenAt = @Now, LastIP = @ClientIP
                WHERE SessionId = @Sid
                  AND (LastSeenAt IS NULL OR LastSeenAt < DATEADD(MINUTE, -5, @Now));
            END
            ELSE IF @Operation = 'Refresh'
            BEGIN
                BEGIN TRAN;
                    UPDATE [PLS].[V1ApiRefreshToken]
                    SET ConsumedAt = @Now, ReplacedByHash = @NewRefreshHash
                    WHERE TokenHash = @RefreshHash AND ConsumedAt IS NULL;

                    IF @@ROWCOUNT = 0
                    BEGIN
                        -- Lost a race with another use of the same token: treat as reuse.
                        ROLLBACK;
                        UPDATE [PLS].[V1ApiSession]
                        SET RevokedAt = @Now, RevokedReason = 'RefreshReuse'
                        WHERE SessionId = @Sid AND RevokedAt IS NULL;
                        RETURN;
                    END

                    INSERT [PLS].[V1ApiRefreshToken] (TokenHash, SessionId, CreatedAt)
                    VALUES (@NewRefreshHash, @Sid, @Now);

                    UPDATE [PLS].[V1ApiSession]
                    SET LastSeenAt = @Now, LastIP = @ClientIP
                    WHERE SessionId = @Sid;
                COMMIT;
            END
            ELSE -- ChangePassword
            BEGIN
                IF ISNULL(@Password, '') = '' OR ISNULL(@NewPassword, '') = '' RETURN;

                SET @LineData = (SELECT @IdUser AS Username, @Password AS CurrentPassword, @NewPassword AS NewPassword
                                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER);
                INSERT #Changed
                EXEC Pls.[APIPlusUserOperationV1] @Operation = 'ChangeOwnPassword', @LineData = @LineData, @User = @IdUser,
                     @State = @UState OUTPUT, @Message = @UMessage OUTPUT;

                IF ISNULL(@UState, 1) <> 0 OR NOT EXISTS (SELECT 1 FROM #Changed) RETURN;

                -- New stamp = every existing session of this user is dead (sign in again).
                BEGIN TRAN;
                    UPDATE [PLS].[V1ApiIdentity] SET CredentialStamp = NEWID() WHERE Subject = @Subject;
                    UPDATE [PLS].[V1ApiSession]
                    SET RevokedAt = @Now, RevokedReason = 'PasswordChanged'
                    WHERE Subject = @Subject AND RevokedAt IS NULL;
                COMMIT;
                SET @Force = 0;
            END

            SELECT @Subject AS Subject, @Sid AS SessionId, @IdUser AS Username,
                   @DisplayName AS DisplayName, @Force AS ForcePasswordChange, @ExpiresAt AS ExpiresAt;
            RETURN;
        END

        -- Unknown operation: no rows = refused.
        RETURN;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;   -- the gateway logs only the error type/number and answers 500
    END CATCH
END
GO
