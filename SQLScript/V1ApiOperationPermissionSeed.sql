USE [SILA101]
GO
-- =========================================================================
-- PLS.V1ApiOperationPermission -- the API gateway's operation allowlist for
-- SILA101 (SilaApi/Plus.Api). One idempotent block per procedure + operation
-- the clients call through /api/v2/exec. Missing row = HTTP 403.
--
-- Rules (same as PlusV1):
--   * ProcedureName spelled exactly as the client sends it, no brackets
--     (binary collation -- 'CHA.x' <> 'Cha.x').
--   * Enabled = 1 only if the SP authorizes the caller itself; else 0 + a Note.
--   * Never delete a row -- disable it with a Note.
-- Table: SQLScript/V1ApiTables.sql. Deploy in SSMS against SILA101.
-- =========================================================================

-- -------------------------------------------------------------------------
-- CHA.APISilaOperationV1 -- read-only live-DB inspection (sila-db skill).
-- Every call still needs LineData.ApiKey (checked against dbo.SilaApiKey);
-- PreviewRows / RunQuery run as [SilaReader] (no writes, no other DBs).
-- -------------------------------------------------------------------------
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'CHA.APISilaOperationV1', N'Ping',          N'Live DB reader: which DB/server answers'),
    (N'CHA.APISilaOperationV1', N'ListObjects',   N'Live DB reader: list tables/views/procs'),
    (N'CHA.APISilaOperationV1', N'GetDefinition', N'Live DB reader: source of a module'),
    (N'CHA.APISilaOperationV1', N'GetColumns',    N'Live DB reader: columns of a table/view'),
    (N'CHA.APISilaOperationV1', N'GetParameters', N'Live DB reader: parameters of a proc/function'),
    (N'CHA.APISilaOperationV1', N'PreviewRows',   N'Live DB reader: TOP n rows, as SilaReader'),
    (N'CHA.APISilaOperationV1', N'RunQuery',      N'Live DB reader: read-only SQL, as SilaReader')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, N'[]', s.Notes, N'claude');
GO

-- -------------------------------------------------------------------------
-- Pls.APIPlusUserOperationV1 -- only the caller's own profile. Login /
-- GetLoginStatus / ChangeOwnPassword are reached only through the auth
-- endpoints (PLS.APIPlusAuthSessionOperation), never through /exec.
-- -------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM [PLS].[V1ApiOperationPermission]
               WHERE ProcedureName = N'Pls.APIPlusUserOperationV1' AND OperationName = N'GetMyProfile')
    INSERT [PLS].[V1ApiOperationPermission]
        (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (N'Pls.APIPlusUserOperationV1', N'GetMyProfile', 1, 1, N'[]',
            N'Signed-in user''s own Username / Name / IsAdmin', N'claude');
GO

-- -------------------------------------------------------------------------
-- dbo.APISilaWebOperation -- the web app's own router. Its rows (Left side,
-- Chat messages, Mark chat read, ...) are kept at the end of
-- SQLScript/APISilaWebOperation.sql, so the procedure and its allow-list
-- deploy together (deploy.sh).
-- -------------------------------------------------------------------------

-- -------------------------------------------------------------------------
-- CHA.APISilaDeployV1 -- script deployment for the sila-db deploy tool.
-- The SP authorizes the caller itself: a Scope='deploy' key bound to the
-- signed-in @User (SQLScript/SilaDeployKeyNew.sql). Every batch is logged in
-- dbo.SilaDeployLog. Disable both rows to switch deployment off.
-- -------------------------------------------------------------------------
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'CHA.APISilaDeployV1', N'Ping',   N'Deploy tool: which DB answers and whether it may create objects'),
    (N'CHA.APISilaDeployV1', N'Deploy', N'Deploy tool: run one script batch (deploy key bound to the caller, logged)')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, N'[]', s.Notes, N'claude');
GO

-- dbo.APIGeneralOperation is the mobile app's router: the web must not call it
-- (it would consume the mobile ForceFullSync flag). An earlier draft of this
-- script allowed its 'Left side'; if that row was deployed, disable it.
UPDATE [PLS].[V1ApiOperationPermission]
SET Enabled = 0, Notes = N'Disabled: mobile router; the web uses dbo.APISilaWebOperation',
    ModifiedBy = N'claude', ModifiedAt = SYSUTCDATETIME()
WHERE ProcedureName = N'dbo.APIGeneralOperation' AND OperationName = N'Left side' AND Enabled = 1;
GO
