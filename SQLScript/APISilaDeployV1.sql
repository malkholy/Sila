USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [CHA].[APISilaDeployV1] -- deploys SQL scripts (procedures, views,
-- functions, config rows) without SSMS, for the sila-db deploy tool
-- (.claude/skills/sila-db/deploy.sh). Requested by the project owner
-- 2026-10-21. Bootstrap: THIS script, the permission seed and
-- SilaDeployKeyNew.sql are run by a person in SSMS, once.
--
-- Who can deploy: a caller whose LineData.ApiKey matches an active
-- dbo.SilaApiKey row with Scope = 'deploy' AND BoundUser = @User. Through
-- SilaApi /api/v2/exec, @User comes from the signed-in token. Read keys
-- (Scope 'read', the default) can't deploy.
--
-- Operations (LineData always carries ApiKey):
--   Ping     which server / DB / login answers, and whether it may create
--            procedures and views there.
--   Deploy   LineData { Sql, Label? } -- ONE batch (the tool splits on GO).
--            Runs in a transaction (XACT_ABORT): a failing batch is rolled
--            back whole. Logged in dbo.SilaDeployLog before and after.
--
-- Guardrails (refuse the batch): USE, logins/users/roles/permissions,
-- DROP/TRUNCATE TABLE, database-level ALTER/CREATE/DROP, backup/restore,
-- server config and external data access, and any mention of the deploy /
-- key / reader objects themselves. Those changes stay in SSMS. The guardrail
-- is a text check that catches mistakes; the deploy key is the security.
--
-- Idempotent. Deploy in SSMS against SILA101.
-- =========================================================================

-- Key scope + owner (existing keys stay read keys)
IF COL_LENGTH(N'dbo.SilaApiKey', N'Scope') IS NULL
    ALTER TABLE [dbo].[SilaApiKey] ADD Scope VARCHAR(10) NOT NULL
        CONSTRAINT DF_SilaApiKey_Scope DEFAULT ('read') WITH VALUES;
GO
IF COL_LENGTH(N'dbo.SilaApiKey', N'BoundUser') IS NULL
    ALTER TABLE [dbo].[SilaApiKey] ADD BoundUser NVARCHAR(100) NULL;
GO

IF OBJECT_ID(N'[dbo].[SilaDeployLog]', N'U') IS NULL
CREATE TABLE [dbo].[SilaDeployLog] (
    DeployID     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_SilaDeployLog PRIMARY KEY,
    KeyID        INT            NOT NULL,
    CallerUser   NVARCHAR(250)  NOT NULL,
    Label        NVARCHAR(200)  NULL,
    ScriptHash   VARBINARY(32)  NOT NULL,
    ScriptText   NVARCHAR(MAX)  NOT NULL,
    StartedAt    DATETIME2(3)   NOT NULL CONSTRAINT DF_SilaDeployLog_Started DEFAULT (SYSDATETIME()),
    FinishedAt   DATETIME2(3)   NULL,
    Status       VARCHAR(10)    NOT NULL CONSTRAINT DF_SilaDeployLog_Status DEFAULT ('started'),  -- started | ok | failed | refused
    ErrorMessage NVARCHAR(2000) NULL
);
GO

CREATE OR ALTER PROCEDURE [CHA].[APISilaDeployV1]
    @operation      VARCHAR(100)   = '',
    @User           NVARCHAR(250)  = '',
    @LineData       NVARCHAR(MAX)  = '',
    @State          INT            = 0  OUTPUT,
    @Message        NVARCHAR(500)  = '' OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET @State = 0;
    SET @Message = '';

    DECLARE @DeployID INT = NULL;

    BEGIN TRY
        IF ISJSON(@LineData) <> 1 SET @LineData = N'{}';

        -- ---------------------------------------------------------------
        -- Deploy key: Scope 'deploy', bound to the caller
        -- ---------------------------------------------------------------
        DECLARE @ApiKey NVARCHAR(200) = JSON_VALUE(@LineData, '$.ApiKey');
        DECLARE @KeyID INT = NULL;
        IF @ApiKey IS NOT NULL AND LEN(@ApiKey) = 64
            SELECT @KeyID = KeyID FROM [dbo].[SilaApiKey]
            WHERE IsActive = 1 AND Scope = 'deploy' AND BoundUser = @User
              AND KeyHash = HASHBYTES('SHA2_256', UPPER(CAST(@ApiKey AS VARCHAR(64))));
        IF @KeyID IS NULL
        BEGIN
            SET @State = 401;
            SET @Message = 'Invalid deploy key for this user';
            RETURN;
        END

        -- ---------------------------------------------------------------
        -- Ping
        -- ---------------------------------------------------------------
        IF @operation = 'Ping'
        BEGIN
            SET @Message = 'Success';
            SELECT 'APISilaDeployV1' AS Api, DB_NAME() AS DatabaseName, @@SERVERNAME AS ServerName,
                   SUSER_SNAME() AS LoginName, USER_NAME() AS DbUser, @User AS CallerUser, @KeyID AS KeyID,
                   HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE PROCEDURE') AS CanCreateProcedure,
                   HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE VIEW') AS CanCreateView,
                   HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER ANY SCHEMA') AS CanAlterAnySchema;
            RETURN;
        END

        -- ---------------------------------------------------------------
        -- Deploy (one batch)
        -- ---------------------------------------------------------------
        IF @operation = 'Deploy'
        BEGIN
            DECLARE @Sql NVARCHAR(MAX), @Label NVARCHAR(200);
            SELECT @Sql = [Sql], @Label = [Label]
            FROM OPENJSON(@LineData) WITH ([Sql] NVARCHAR(MAX) '$.Sql', [Label] NVARCHAR(200) '$.Label');

            IF @Sql IS NULL OR LTRIM(RTRIM(@Sql)) = ''
            BEGIN
                SET @State = 1;
                SET @Message = 'LineData.Sql is required';
                RETURN;
            END

            -- Guardrail: uppercase, brackets removed, every whitespace run -> one space
            DECLARE @Norm NVARCHAR(MAX) = UPPER(REPLACE(REPLACE(@Sql, N'[', N''), N']', N''));
            SET @Norm = REPLACE(REPLACE(REPLACE(@Norm, NCHAR(13), N' '), NCHAR(10), N' '), NCHAR(9), N' ');
            WHILE CHARINDEX(N'  ', @Norm) > 0 SET @Norm = REPLACE(@Norm, N'  ', N' ');
            SET @Norm = N' ' + @Norm + N' ';

            DECLARE @Hit NVARCHAR(100) = (
                SELECT TOP (1) t.Token FROM (VALUES
                    (N' USE '), (N' CREATE LOGIN'), (N' ALTER LOGIN'), (N' DROP LOGIN'),
                    (N' CREATE USER'), (N' ALTER USER'), (N' DROP USER'), (N' ALTER ROLE'), (N' CREATE ROLE'), (N' DROP ROLE'),
                    (N' GRANT '), (N' REVOKE '), (N' DENY '), (N' ALTER AUTHORIZATION'), (N'IMPERSONATE'),
                    (N'SP_ADDROLEMEMBER'), (N'SP_ADDSRVROLEMEMBER'), (N'SP_DROPROLEMEMBER'),
                    (N' DROP TABLE'), (N' TRUNCATE TABLE'), (N' DROP SCHEMA'),
                    (N' CREATE DATABASE'), (N' ALTER DATABASE'), (N' DROP DATABASE'),
                    (N' BACKUP '), (N' RESTORE '), (N' SHUTDOWN'), (N' ALTER SERVER'),
                    (N'SP_CONFIGURE'), (N'RECONFIGURE'), (N'XP_CMDSHELL'),
                    (N'OPENROWSET'), (N'OPENDATASOURCE'), (N'OPENQUERY'), (N'SP_ADDLINKEDSERVER'),
                    (N'APISILADEPLOYV1'), (N'SILADEPLOYLOG'), (N'SILAAPIKEY'),
                    (N'SILAREADER'), (N'APISILAOPERATIONV1'), (N'APISILAREADEREXEC')
                ) AS t (Token)
                WHERE CHARINDEX(t.Token, @Norm) > 0);

            INSERT INTO [dbo].[SilaDeployLog] (KeyID, CallerUser, Label, ScriptHash, ScriptText, Status, FinishedAt, ErrorMessage)
            VALUES (@KeyID, @User, @Label, HASHBYTES('SHA2_256', @Sql), @Sql,
                    CASE WHEN @Hit IS NULL THEN 'started' ELSE 'refused' END,
                    CASE WHEN @Hit IS NULL THEN NULL ELSE SYSDATETIME() END,
                    CASE WHEN @Hit IS NULL THEN NULL ELSE N'Refused: contains ' + LTRIM(@Hit) END);
            SET @DeployID = SCOPE_IDENTITY();

            IF @Hit IS NOT NULL
            BEGIN
                SET @State = 403;
                SET @Message = LEFT(N'Refused: the batch contains "' + LTRIM(RTRIM(@Hit)) + N'". Run it in SSMS instead. (DeployID '
                               + CAST(@DeployID AS NVARCHAR(12)) + N')', 500);
                RETURN;
            END

            BEGIN TRANSACTION;
            EXEC sp_executesql @Sql;
            COMMIT TRANSACTION;

            UPDATE [dbo].[SilaDeployLog] SET Status = 'ok', FinishedAt = SYSDATETIME() WHERE DeployID = @DeployID;
            SET @Message = N'Deployed (DeployID ' + CAST(@DeployID AS NVARCHAR(12)) + N')';
            RETURN;
        END

        SET @State = 1;
        SET @Message = 'Unknown operation';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        SET @State = ERROR_NUMBER();
        SET @Message = LEFT('SQL Exception: ' + ERROR_MESSAGE() + ' (Line: ' + CAST(ERROR_LINE() AS VARCHAR(10)) + ')', 500);
        IF @DeployID IS NOT NULL
            UPDATE [dbo].[SilaDeployLog]
            SET Status = 'failed', FinishedAt = SYSDATETIME(), ErrorMessage = LEFT(@Message, 2000)
            WHERE DeployID = @DeployID;
    END CATCH
END
GO
