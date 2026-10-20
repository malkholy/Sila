USE [SILA101]
GO
-- Run AFTER APISilaOperationV1.sql.
-- =========================================================================
-- Mints one API key for [CHA].[APISilaOperationV1]. Only the SHA-256 hash is
-- stored; the plain key is shown ONCE in the result below -- copy it then.
-- Each run adds a new key (it does not replace old ones). Revoke a key with:
--   UPDATE [dbo].[SilaApiKey] SET IsActive = 0 WHERE KeyID = <id>;
-- =========================================================================
DECLARE @Label NVARCHAR(100) = N'Claude live-db reader';   -- who/what holds this key
DECLARE @Key   VARCHAR(64)   = CONVERT(VARCHAR(64), CRYPT_GEN_RANDOM(32), 2);

INSERT INTO [dbo].[SilaApiKey] (Label, KeyHash)
VALUES (@Label, HASHBYTES('SHA2_256', @Key));

SELECT CAST(SCOPE_IDENTITY() AS INT) AS KeyID, @Label AS Label, @Key AS ApiKey_CopyNow;
GO
