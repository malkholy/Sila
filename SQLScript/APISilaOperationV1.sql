USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [CHA].[APISilaOperationV1] -- main router SP for the Sila web API (the
-- :9201 gateway, same transport as [CHA].[APITicketOperation]).
--
-- First operations: read-only live-DB inspection, so schema/SP discovery
-- happens through the API instead of SSMS screenshots:
--   Ping           -- which DB/server/login answers; proves the key works
--   ListObjects    -- LineData {Schema?, Type? (U|V|P|FN|IF|TF|TR), Search?}
--   GetDefinition  -- LineData {Object}   source of a proc/view/function/trigger
--   GetColumns     -- LineData {Object}   columns of a table/view
--   GetParameters  -- LineData {Object}   parameters of a proc/function
--   PreviewRows    -- LineData {Object, Top? (1-500, default 50)}  table/view only
--   RunQuery       -- LineData {Sql}      free SQL, run as [SilaReader]
--
-- Security:
--   * The gateway passes @User as sent by the browser (no token), so @User is
--     NOT trusted. Every call must carry LineData.ApiKey, checked against the
--     SHA-256 hashes in [dbo].[SilaApiKey] (mint one with SilaApiKeyNew.sql).
--   * PreviewRows and RunQuery hand their SQL to [CHA].[APISilaReaderExec],
--     a module declared WITH EXECUTE AS 'SilaReader' (db_datareader + VIEW
--     DEFINITION, no login), so they cannot write and cannot leave this
--     database, whatever the SQL says. Not an EXECUTE AS *statement* here:
--     verified live 2026-10-20 that dynamic SQL can REVERT one of those back
--     to the gateway's dbo context. The other operations are fixed catalog
--     SELECTs with no dynamic SQL.
--
-- Parameters mirror the ticket gateway's body keys exactly (operation, User,
-- TicketID, ChannelID, LineData, ..., DeskTopVerion -- typo included) so the
-- :9201 gateway binds them the same way it does for APITicketOperation.
-- Every parameter has a default; NULLs are tolerated. Types stay within what
-- the legacy gateway's dbo.GetProcedureParameter binds (INT / NVARCHAR /
-- VARCHAR) -- it returns NULL for BIGINT and several others
-- (ProV1 docs/general-api-v2-plan.md, section 1).
--
-- Errors come back as one row {State, Message} (Message starts with
-- 'SQL Exception: ' for SQL errors), plus @State/@Message.
--
-- Idempotent: safe to re-run in full.
-- =========================================================================

IF SCHEMA_ID(N'CHA') IS NULL EXEC (N'CREATE SCHEMA [CHA]');
GO

IF OBJECT_ID(N'[dbo].[SilaApiKey]', N'U') IS NULL
CREATE TABLE [dbo].[SilaApiKey] (
    KeyID     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_SilaApiKey PRIMARY KEY,
    Label     NVARCHAR(100)     NOT NULL,
    KeyHash   VARBINARY(32)     NOT NULL,          -- HASHBYTES('SHA2_256', <64-char hex key>)
    IsActive  BIT               NOT NULL CONSTRAINT DF_SilaApiKey_IsActive DEFAULT (1),
    CreatedAt DATETIME2(0)      NOT NULL CONSTRAINT DF_SilaApiKey_CreatedAt DEFAULT (SYSDATETIME())
);
GO

-- Read-only identity for PreviewRows / RunQuery. No login: it can only be
-- reached through [CHA].[APISilaReaderExec] inside this database.
IF DATABASE_PRINCIPAL_ID(N'SilaReader') IS NULL
    CREATE USER [SilaReader] WITHOUT LOGIN;
GO
ALTER ROLE [db_datareader] ADD MEMBER [SilaReader];
GRANT VIEW DEFINITION TO [SilaReader];
-- SilaReader must read the key table: APISilaReaderExec checks the key itself.
-- Safe -- it holds only SHA-256 hashes of random 256-bit keys. REVOKE also
-- clears the DENY an earlier version of this script set.
REVOKE SELECT ON OBJECT::[dbo].[SilaApiKey] FROM [SilaReader];
GO

-- -------------------------------------------------------------------------
-- [CHA].[APISilaReaderExec] -- runs one SQL batch as SilaReader. Called by
-- APISilaOperationV1 (PreviewRows / RunQuery). The gateway executes any SP
-- the client names, so this one re-checks the API key on its own.
-- -------------------------------------------------------------------------
CREATE OR ALTER PROCEDURE [CHA].[APISilaReaderExec]
    @ApiKey NVARCHAR(200) = '',
    @Sql    NVARCHAR(MAX) = ''
WITH EXECUTE AS 'SilaReader'
AS
BEGIN
    SET NOCOUNT ON;

    IF @ApiKey IS NULL OR LEN(@ApiKey) <> 64
       OR NOT EXISTS (SELECT 1 FROM [dbo].[SilaApiKey]
                      WHERE IsActive = 1
                        AND KeyHash = HASHBYTES('SHA2_256', UPPER(CAST(@ApiKey AS VARCHAR(64)))))
    BEGIN
        SELECT 401 AS State, 'Invalid or missing ApiKey' AS Message;
        RETURN;
    END

    EXEC sp_executesql @Sql;
END
GO

CREATE OR ALTER PROCEDURE [CHA].[APISilaOperationV1]
    @operation      VARCHAR(100)   = '',
    @User           NVARCHAR(100)  = '',
    @TicketID       INT            = 0,
    @ChannelID      INT            = 0,
    @LineData       NVARCHAR(MAX)  = '',
    @LastChatID     INT            = 0,
    @MinChatID      INT            = 0,
    @PlatForm       NVARCHAR(50)   = '',
    @WebVersion     NVARCHAR(50)   = '',
    @AndroidVersion NVARCHAR(50)   = '',
    @IOSVersion     NVARCHAR(50)   = '',
    @DeskTopVerion  NVARCHAR(50)   = '',
    @FireBaseToken  NVARCHAR(500)  = '',
    @State          INT            = 0  OUTPUT,
    @Message        NVARCHAR(500)  = '' OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET @State = 0;
    SET @Message = '';

    BEGIN TRY
        IF ISJSON(@LineData) <> 1 SET @LineData = N'{}';

        -- -----------------------------------------------------------------
        -- API key (every operation). Exact 64-char hex only: a longer value
        -- must not match by truncation.
        -- -----------------------------------------------------------------
        DECLARE @ApiKey NVARCHAR(200) = JSON_VALUE(@LineData, '$.ApiKey');
        IF @ApiKey IS NULL OR LEN(@ApiKey) <> 64
           OR NOT EXISTS (SELECT 1 FROM [dbo].[SilaApiKey]
                          WHERE IsActive = 1
                            AND KeyHash = HASHBYTES('SHA2_256', UPPER(CAST(@ApiKey AS VARCHAR(64)))))
        BEGIN
            SET @State = 401;
            SET @Message = 'Invalid or missing ApiKey';
            SELECT @State AS State, @Message AS Message;
            RETURN;
        END

        DECLARE @Obj   NVARCHAR(400) = JSON_VALUE(@LineData, '$.Object');
        DECLARE @ObjId INT           = OBJECT_ID(@Obj);

        -- -----------------------------------------------------------------
        -- Ping
        -- -----------------------------------------------------------------
        IF @operation = 'Ping'
        BEGIN
            SET @Message = 'Success';
            SELECT 'APISilaOperationV1' AS Api, DB_NAME() AS DatabaseName, @@SERVERNAME AS ServerName,
                   SUSER_SNAME() AS LoginName, USER_NAME() AS DbUser, SYSDATETIME() AS ServerTime,
                   @User AS CallerUser;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- ListObjects
        -- -----------------------------------------------------------------
        IF @operation = 'ListObjects'
        BEGIN
            DECLARE @LO_Schema SYSNAME       = JSON_VALUE(@LineData, '$.Schema');
            DECLARE @LO_Type   VARCHAR(2)    = JSON_VALUE(@LineData, '$.Type');
            DECLARE @LO_Search NVARCHAR(128) = JSON_VALUE(@LineData, '$.Search');

            SET @Message = 'Success';
            SELECT TOP (2000)
                   SCHEMA_NAME(o.schema_id) AS SchemaName, o.name AS ObjectName,
                   RTRIM(o.type) AS Type, o.type_desc AS TypeDesc,
                   (SELECT SUM(p.rows) FROM sys.partitions p
                    WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS RowCnt,
                   o.create_date AS CreatedAt, o.modify_date AS ModifiedAt
            FROM sys.objects o
            WHERE o.is_ms_shipped = 0
              AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR')
              AND (@LO_Schema IS NULL OR SCHEMA_NAME(o.schema_id) = @LO_Schema)
              AND (@LO_Type   IS NULL OR o.type = @LO_Type)
              AND (@LO_Search IS NULL OR o.name LIKE N'%' + @LO_Search + N'%')
            ORDER BY SchemaName, ObjectName;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- GetDefinition
        -- -----------------------------------------------------------------
        IF @operation = 'GetDefinition'
        BEGIN
            DECLARE @GD_Def NVARCHAR(MAX) = OBJECT_DEFINITION(@ObjId);
            IF @GD_Def IS NULL
            BEGIN
                SET @State = 1;
                SET @Message = 'No definition for ' + ISNULL(@Obj, '(no Object)') + ' (not found, encrypted, or a table)';
                SELECT @State AS State, @Message AS Message;
                RETURN;
            END

            SET @Message = 'Success';
            SELECT OBJECT_SCHEMA_NAME(@ObjId) AS SchemaName, OBJECT_NAME(@ObjId) AS ObjectName,
                   @GD_Def AS Definition;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- GetColumns
        -- -----------------------------------------------------------------
        IF @operation = 'GetColumns'
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = @ObjId AND type IN ('U', 'V', 'IF', 'TF'))
            BEGIN
                SET @State = 1;
                SET @Message = 'Table/view not found: ' + ISNULL(@Obj, '(no Object)');
                SELECT @State AS State, @Message AS Message;
                RETURN;
            END

            SET @Message = 'Success';
            SELECT c.column_id AS ColumnID, c.name AS ColumnName,
                   t.name + CASE
                       WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary')
                           THEN '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length AS VARCHAR(10))) + ')'
                       WHEN t.name IN ('nvarchar', 'nchar')
                           THEN '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length / 2 AS VARCHAR(10))) + ')'
                       WHEN t.name IN ('decimal', 'numeric')
                           THEN '(' + CAST(c.precision AS VARCHAR(10)) + ',' + CAST(c.scale AS VARCHAR(10)) + ')'
                       ELSE '' END AS DataType,
                   c.is_nullable AS IsNullable, c.is_identity AS IsIdentity, c.is_computed AS IsComputed,
                   dc.definition AS DefaultValue
            FROM sys.columns c
            JOIN sys.types t ON t.user_type_id = c.user_type_id
            LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
            WHERE c.object_id = @ObjId
            ORDER BY c.column_id;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- GetParameters
        -- -----------------------------------------------------------------
        IF @operation = 'GetParameters'
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = @ObjId AND type IN ('P', 'FN', 'IF', 'TF'))
            BEGIN
                SET @State = 1;
                SET @Message = 'Procedure/function not found: ' + ISNULL(@Obj, '(no Object)');
                SELECT @State AS State, @Message AS Message;
                RETURN;
            END

            SET @Message = 'Success';
            SELECT p.parameter_id AS ParameterID, p.name AS ParameterName, TYPE_NAME(p.user_type_id) AS DataType,
                   p.max_length AS MaxLength, p.is_output AS IsOutput
            FROM sys.parameters p
            WHERE p.object_id = @ObjId
            ORDER BY p.parameter_id;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- PreviewRows (table/view only; identifiers come from sys.objects and
        -- are QUOTENAME'd -- nothing from the client is spliced into SQL)
        -- -----------------------------------------------------------------
        IF @operation = 'PreviewRows'
        BEGIN
            DECLARE @PR_Schema SYSNAME, @PR_Name SYSNAME;
            SELECT @PR_Schema = SCHEMA_NAME(schema_id), @PR_Name = name
            FROM sys.objects WHERE object_id = @ObjId AND type IN ('U', 'V');

            IF @PR_Name IS NULL
            BEGIN
                SET @State = 1;
                SET @Message = 'Table/view not found: ' + ISNULL(@Obj, '(no Object)');
                SELECT @State AS State, @Message AS Message;
                RETURN;
            END

            DECLARE @PR_Top INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 50);
            IF @PR_Top < 1 SET @PR_Top = 1;
            IF @PR_Top > 500 SET @PR_Top = 500;

            DECLARE @PR_Sql NVARCHAR(600) =
                N'SELECT TOP (' + CAST(@PR_Top AS NVARCHAR(10)) + N') * FROM '
                + QUOTENAME(@PR_Schema) + N'.' + QUOTENAME(@PR_Name) + N';';

            EXEC [CHA].[APISilaReaderExec] @ApiKey = @ApiKey, @Sql = @PR_Sql;

            SET @Message = 'Success';
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- RunQuery (free SQL, read-only by identity, not by parsing)
        -- -----------------------------------------------------------------
        IF @operation = 'RunQuery'
        BEGIN
            DECLARE @RQ_Sql NVARCHAR(MAX);
            SELECT @RQ_Sql = [Sql] FROM OPENJSON(@LineData) WITH ([Sql] NVARCHAR(MAX) '$.Sql');

            IF @RQ_Sql IS NULL OR LTRIM(RTRIM(@RQ_Sql)) = ''
            BEGIN
                SET @State = 1;
                SET @Message = 'LineData.Sql is required';
                SELECT @State AS State, @Message AS Message;
                RETURN;
            END

            EXEC [CHA].[APISilaReaderExec] @ApiKey = @ApiKey, @Sql = @RQ_Sql;

            SET @Message = 'SQL executed successfully';
            RETURN;
        END

        SET @State = 1;
        SET @Message = 'Unknown operation: ' + ISNULL(@operation, '(null)');
        SELECT @State AS State, @Message AS Message;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        SET @State = ERROR_NUMBER();
        SET @Message = LEFT('SQL Exception: ' + ERROR_MESSAGE() + ' (Line: ' + CAST(ERROR_LINE() AS VARCHAR(10)) + ')', 500);
        SELECT @State AS State, @Message AS Message;
    END CATCH
END
GO
