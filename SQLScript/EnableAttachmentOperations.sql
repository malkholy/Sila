USE [SILA101]
GO
-- Run in SSMS. The same rows as the last block of MobileApiOperationPermissions.sql
-- (kept there too); idempotent: adds only what is missing.
-- -------------------------------------------------------------------------
-- dbo.APIAttachmentOperation (2026-10-22): the mobile app's file steps --
-- 'Get ID' (reserve an AttachmentID; List0 = one unnamed column, "" in JSON),
-- 'Upload' (save the file's row + post the message; RecordType O/G/T/M/K/UP/GP),
-- 'Forward Attachment' (re-post an attachment into conversations by SilaID).
-- Known gaps (the procedure, not these rows): Upload does not check that the
-- caller belongs to the chat / group / ticket, GP sets any group's photo, and
-- Forward Attachment trusts the SilaIDs and the AttachmentID it is given.
-- -------------------------------------------------------------------------
DECLARE @Attachment NVARCHAR(MAX) = N'["RecordType","AttachmentID","LastChatID","FireBaseToken","AppVersionWeb","AppVersionAndroid","AppVersionIos","AppVersionDesktop","PlatForm"]';
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'dbo.APIAttachmentOperation', N'Get ID',             N'Mobile: reserve an AttachmentID (dbo.Attachment sequence)'),
    (N'dbo.APIAttachmentOperation', N'Upload',             N'Mobile: save a file row (AttachmentHistory) and post it (RecordType O/G/T/M/K/UP/GP)'),
    (N'dbo.APIAttachmentOperation', N'Forward Attachment', N'Mobile: re-post an attachment into conversations (LineData = [{SilaID}])')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, @Attachment, s.Notes, N'claude');
GO
