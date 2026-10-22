USE [SILA101]
GO
-- =========================================================================
-- 2026-10-22: dbo.Attachment was behind the data. It stood at 850290 while
-- 1,369 old ticket messages already point at AttachmentIDs 850294..853760
-- (none of them in AttachmentHistory), so new files (mobile 'Get ID' and the
-- web Files API alike) were given numbers old messages already carry.
-- 1. Move the sequence past every number already taken (only ever forward).
-- 2. Undo the collision of the first 10 web test uploads (850281..850290,
--    ticket 2301855, by mhd): their AttachmentHistory rows made 9 old messages
--    point at them. The files stay on disk; they can no longer be opened.
-- Safe to run again.
-- =========================================================================
IF (SELECT CAST(current_value AS BIGINT) FROM sys.sequences WHERE name = N'Attachment' AND schema_id = SCHEMA_ID(N'dbo')) < 860000
    ALTER SEQUENCE dbo.Attachment RESTART WITH 860000;
GO

DELETE FROM dbo.AttachmentHistory WHERE AttachmentID BETWEEN 850281 AND 850290 AND CreatedBy = N'mhd';
UPDATE PLS.V1FileUpload SET IsDeleted = 1, DeletedBy = N'mhd' WHERE AttachmentID BETWEEN 850281 AND 850290 AND IsDeleted = 0;
DELETE FROM CHA.TicketChatHistory WHERE TicketID = 2301855 AND AttachmentID BETWEEN 850281 AND 850290 AND FromUserName = N'mhd';
GO
