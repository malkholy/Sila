USE [SILA101]
GO
-- Run AFTER APISilaDeployV1.sql, in SSMS.
-- =========================================================================
-- Mints one DEPLOY key for [CHA].[APISilaDeployV1], bound to one Sila user:
-- it only works when the caller signed in to SilaApi as @BoundUser. Only the
-- SHA-256 hash is stored; the plain key is shown ONCE below -- copy it then.
-- Revoke:  UPDATE [dbo].[SilaApiKey] SET IsActive = 0 WHERE KeyID = <id>;
-- Audit:   SELECT TOP 50 * FROM [dbo].[SilaDeployLog] ORDER BY DeployID DESC;
-- =========================================================================
DECLARE @BoundUser NVARCHAR(100) = N'mhd';                       -- the Sila user allowed to deploy with it
DECLARE @Label     NVARCHAR(100) = N'Claude deploy (sila-db deploy.sh)';
DECLARE @Key       VARCHAR(64)   = CONVERT(VARCHAR(64), CRYPT_GEN_RANDOM(32), 2);

INSERT INTO [dbo].[SilaApiKey] (Label, KeyHash, Scope, BoundUser)
VALUES (@Label, HASHBYTES('SHA2_256', @Key), 'deploy', @BoundUser);

SELECT CAST(SCOPE_IDENTITY() AS INT) AS KeyID, @Label AS Label, @BoundUser AS BoundUser, @Key AS DeployKey_CopyNow;
GO
