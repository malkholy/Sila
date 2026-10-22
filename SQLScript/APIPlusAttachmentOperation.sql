USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- Sila's attachment metadata + permission checks for the Files API
-- (SilaApi/Plus.Api/Attachments, the "Files" role on :7500). The API handles
-- the bytes (type / content check, virus scan, disk); this SP decides who may
-- add / open / remove which file. Same operations and result shapes as
-- PlusV1's procedure, so the API code is unchanged -- the storage is Sila's:
--
--   * a file belongs to one conversation: EntityType 'Chat' (EntityKey =
--     SessionID), 'Group' (GroupID) or 'Ticket' (TicketID);
--   * the API's ID is the file's AttachmentID (dbo.Attachment sequence, as the
--     mobile app's 'Get ID'), so a message's AttachmentID opens its file;
--   * PLS.V1FileUpload tracks each web upload (pending -> live, soft delete);
--     when the file is stored (SetExist) a dbo.AttachmentHistory row is added,
--     so the existing views and the mobile app see it like any other file.
--
-- Who may do what (@User = the signed-in user from the token):
--   read (List / Get) .......... members of the chat / group / ticket (not
--                                left); a file posted as an admins-only ticket
--                                note: ticket admins / team leaders only
--   upload (CheckAccess / Insert) the same, plus the send rules: a locked group
--                                takes admins only, a ticket New / In Progress
--   Delete / UpdateDescription . the person who uploaded it
--
-- Called ONLY by the Files API (never through /api/v2/exec: no allow-list row).
-- Operations (LineData JSON), as the API calls them:
--   CheckAccess   { EntityType, EntityKey }
--   List          { EntityType, EntityKey }  -> ID, FileID, FileOrginalName, FileName,
--                    FileDescription, FileURL, FileDisplay, CreatedDate, CreatedBy
--   Insert        { EntityType, EntityKey, FileOrginalName, Extension, FileDescription }
--                 -> ID, FileID, FileName, CreatedDate   (pending until SetExist)
--   SetExist      { ID, FileURL, FileDisplay, FileSize? }  -> the caller's pending upload goes live
--   CancelInsert  { ID }
--   Get           { ID, EntityType, EntityKey } -> FileName, FileOrginalName, CreatedDate, FileURL
--   Delete        { ID, EntityType, EntityKey } -> soft delete (uploader only)
--   UpdateDescription { ID, EntityType, EntityKey, FileDescription } (uploader only)
--   GetByFileName { FileName }  -- office-network link only (@User = '__lan_link__')
--   GetOfficeNetworks {}        -- same user only; Sila has no office list: none
-- Failure: @State = HTTP-style code (400 / 403 / 404 / 409) + @Message.
-- Deploy: deploy.sh or SSMS. Idempotent.
-- =========================================================================

IF SCHEMA_ID(N'PLS') IS NULL EXEC (N'CREATE SCHEMA [PLS]');
GO

IF OBJECT_ID(N'[PLS].[V1FileUpload]', N'U') IS NULL
CREATE TABLE [PLS].[V1FileUpload] (
    AttachmentID    INT            NOT NULL CONSTRAINT PK_V1FileUpload PRIMARY KEY,
    EntityType      VARCHAR(10)    NOT NULL,              -- Chat | Group | Ticket
    EntityKey       INT            NOT NULL,              -- SessionID | GroupID | TicketID
    FileOrginalName NVARCHAR(400)  NOT NULL,
    FileName        NVARCHAR(200)  NOT NULL,              -- stored name: <AttachmentID>-<yyyyMMddHHmmss>-0.<ext>
    Extension       NVARCHAR(10)   NOT NULL,              -- '.pdf'
    FileDescription NVARCHAR(200)  NOT NULL CONSTRAINT DF_V1FileUpload_Desc DEFAULT (N''),
    FileSizeBytes   BIGINT         NULL,
    FileURL         NVARCHAR(1000) NOT NULL CONSTRAINT DF_V1FileUpload_URL DEFAULT (N''),
    FileDisplay     NVARCHAR(1000) NULL,
    CreatedBy       NVARCHAR(100)  NOT NULL,
    CreatedDate     DATETIME       NOT NULL,
    IsExist         BIT            NOT NULL CONSTRAINT DF_V1FileUpload_Exist DEFAULT (0),
    IsDeleted       BIT            NOT NULL CONSTRAINT DF_V1FileUpload_Deleted DEFAULT (0),
    DeletedBy       NVARCHAR(100)  NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_V1FileUpload_Entity' AND object_id = OBJECT_ID(N'[PLS].[V1FileUpload]'))
    CREATE INDEX IX_V1FileUpload_Entity ON [PLS].[V1FileUpload] (EntityType, EntityKey) INCLUDE (IsExist, IsDeleted);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_V1FileUpload_FileName' AND object_id = OBJECT_ID(N'[PLS].[V1FileUpload]'))
    CREATE INDEX IX_V1FileUpload_FileName ON [PLS].[V1FileUpload] (FileName);
GO

CREATE OR ALTER PROCEDURE Pls.APIPlusAttachmentOperation
    @Operation  VARCHAR(100),
    @LineData   NVARCHAR(MAX) = '',
    @User       NVARCHAR(100) = '',
    @State      INT           OUTPUT,
    @Message    NVARCHAR(500) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET @State = 0;
    SET @Message = '';

    BEGIN TRY
        IF LTRIM(RTRIM(ISNULL(@User, ''))) = '' OR ISJSON(ISNULL(@LineData, '')) = 0
        BEGIN
            SET @State = 400; SET @Message = 'Invalid request';
            SELECT @State AS State, @Message AS Message; RETURN;
        END

        -- ---------------------------------------------------------------
        -- Office-network link (/api/v2/files/...): Sila keeps no office list,
        -- so GetOfficeNetworks returns none and those links answer 404.
        -- ---------------------------------------------------------------
        IF @Operation IN ('GetByFileName', 'GetOfficeNetworks')
        BEGIN
            IF @User <> '__lan_link__'
            BEGIN
                SET @State = 403; SET @Message = 'Not allowed';
                SELECT @State AS State, @Message AS Message; RETURN;
            END
            IF @Operation = 'GetOfficeNetworks'
                SELECT CAST(NULL AS NVARCHAR(50)) AS Cidr WHERE 1 = 0;
            ELSE
                SELECT TOP (1) f.AttachmentID AS ID, f.AttachmentID AS FileID, f.FileName, f.FileOrginalName, f.CreatedDate
                FROM [PLS].[V1FileUpload] f
                WHERE f.FileName = JSON_VALUE(@LineData, '$.FileName') AND f.IsDeleted = 0 AND f.IsExist = 1;
            RETURN;
        END
        IF @User = '__lan_link__'
        BEGIN
            SET @State = 403; SET @Message = 'Not allowed';
            SELECT @State AS State, @Message AS Message; RETURN;
        END

        DECLARE @UserID INT, @Inactive INT;
        SELECT @UserID = UserID, @Inactive = IsNotActive FROM dbo.UserMaster WHERE Username = @User;
        IF @UserID IS NULL OR ISNULL(@Inactive, 1) <> 0
        BEGIN
            SET @State = 403; SET @Message = 'User is not active';
            SELECT @State AS State, @Message AS Message; RETURN;
        END

        DECLARE @ID INT = TRY_CAST(JSON_VALUE(@LineData, '$.ID') AS INT);

        -- SetExist / CancelInsert act only on the caller's own pending upload.
        IF @Operation = 'SetExist'
        BEGIN
            DECLARE @Size BIGINT = TRY_CAST(JSON_VALUE(@LineData, '$.FileSize') AS BIGINT);
            DECLARE @SizeText NVARCHAR(50) = CASE
                WHEN @Size IS NULL THEN N''
                WHEN @Size < 1024 THEN CAST(@Size AS NVARCHAR(20)) + N' B'
                WHEN @Size < 1048576 THEN CAST(CAST(ROUND(@Size / 1024.0, 0) AS INT) AS NVARCHAR(20)) + N' KB'
                ELSE CAST(CAST(ROUND(@Size / 1048576.0, 1) AS DECIMAL(10, 1)) AS NVARCHAR(20)) + N' MB' END;
            BEGIN TRAN;
                UPDATE [PLS].[V1FileUpload]
                SET IsExist = 1, FileSizeBytes = @Size,
                    FileURL = ISNULL(JSON_VALUE(@LineData, '$.FileURL'), N''),
                    FileDisplay = JSON_VALUE(@LineData, '$.FileDisplay')
                WHERE AttachmentID = @ID AND IsExist = 0 AND IsDeleted = 0 AND CreatedBy = @User;
                IF @@ROWCOUNT = 0
                BEGIN
                    ROLLBACK;
                    SET @State = 409; SET @Message = 'Attachment is not pending for this user';
                    SELECT @State AS State, @Message AS Message; RETURN;
                END
                -- the file as every other Sila file: the views (and the mobile app) read AttachmentHistory
                INSERT INTO dbo.AttachmentHistory
                    (AttachmentID, FileName, FileOrginalName, FileExtension, FileSize, CreatedDate, CreatedBy,
                     SessionID, GroupID, TicketID, MailID, TaskID, FileURL)
                SELECT f.AttachmentID, f.FileName, f.FileOrginalName, REPLACE(f.Extension, N'.', N''), @SizeText,
                       f.CreatedDate, f.CreatedBy,
                       CASE WHEN f.EntityType = 'Chat' THEN f.EntityKey ELSE 0 END,
                       CASE WHEN f.EntityType = 'Group' THEN f.EntityKey ELSE 0 END,
                       CASE WHEN f.EntityType = 'Ticket' THEN f.EntityKey ELSE 0 END,
                       0, 0, f.FileURL
                FROM [PLS].[V1FileUpload] f WHERE f.AttachmentID = @ID;
            COMMIT;
            SELECT @State AS State, 'OK' AS Message;
            RETURN;
        END
        IF @Operation = 'CancelInsert'
        BEGIN
            DELETE FROM [PLS].[V1FileUpload] WHERE AttachmentID = @ID AND IsExist = 0 AND CreatedBy = @User;
            SELECT @State AS State, 'OK' AS Message;
            RETURN;
        END

        -- ---------------------------------------------------------------
        -- Everything else works on a conversation: is the caller in it?
        -- ---------------------------------------------------------------
        DECLARE @EntityType VARCHAR(10) = JSON_VALUE(@LineData, '$.EntityType');
        DECLARE @EntityKey INT = TRY_CAST(JSON_VALUE(@LineData, '$.EntityKey') AS INT);
        DECLARE @IsMember BIT = 0, @CanWrite BIT = 0, @IsManager BIT = 0, @WhyNot NVARCHAR(200) = N'';

        IF @EntityType = 'Chat'
        BEGIN
            IF EXISTS (SELECT 1 FROM One.OneChatSession WHERE SessionID = @EntityKey AND (UserID1 = @UserID OR UserID2 = @UserID))
                SELECT @IsMember = 1, @CanWrite = 1;
        END
        ELSE IF @EntityType = 'Group'
        BEGIN
            DECLARE @GAdmin INT, @GLocked INT;
            SELECT @GAdmin = ISNULL(gm.IsAdmin, 0), @GLocked = ISNULL(g.ChatIsLocked, 0)
            FROM GRP.GroupMembers gm JOIN GRP.GroupMaster g ON g.GroupID = gm.GroupID
            WHERE gm.GroupID = @EntityKey AND gm.UserID = @UserID;
            IF @GAdmin IS NOT NULL
            BEGIN
                SET @IsMember = 1;
                SET @CanWrite = CASE WHEN @GLocked = 1 AND @GAdmin = 0 THEN 0 ELSE 1 END;
                IF @CanWrite = 0 SET @WhyNot = N'Only admins can send in this group';
            END
        END
        ELSE IF @EntityType = 'Ticket'
        BEGIN
            DECLARE @TState INT;
            SELECT @TState = th.TicketState,
                   @IsManager = CASE WHEN tm.IsAdmin = 1 OR tm.IsTeamLeader = 1 THEN 1 ELSE 0 END
            FROM CHA.TicketMembers tm JOIN CHA.TicketHistory th ON th.TicketID = tm.TicketID
            WHERE tm.TicketID = @EntityKey AND tm.UserID = @UserID AND tm.IsLeft = 0;
            IF @TState IS NOT NULL
            BEGIN
                SET @IsMember = 1;
                SET @CanWrite = CASE WHEN @TState IN (0, 1) THEN 1 ELSE 0 END;
                IF @CanWrite = 0 SET @WhyNot = N'Files can only be added while the ticket is new or in progress';
            END
        END
        ELSE
        BEGIN
            SET @State = 404; SET @Message = 'Attachments are not enabled for this record type';
            SELECT @State AS State, @Message AS Message; RETURN;
        END

        IF @IsMember = 0
        BEGIN
            SET @State = 404; SET @Message = 'Conversation not found';
            SELECT @State AS State, @Message AS Message; RETURN;
        END

        IF @Operation = 'CheckAccess'
        BEGIN
            IF @CanWrite = 0
            BEGIN
                SET @State = 403; SET @Message = @WhyNot;
                SELECT @State AS State, @Message AS Message; RETURN;
            END
            SELECT @State AS State, 'OK' AS Message;
            RETURN;
        END

        -- files of this conversation the caller may see: live, not deleted, and not
        -- inside an admins-only ticket note unless he is a ticket manager
        IF @Operation = 'List'
        BEGIN
            SELECT f.AttachmentID AS ID, f.AttachmentID AS FileID, f.FileOrginalName, f.FileName, f.FileDescription,
                   f.FileURL, f.FileDisplay, f.CreatedDate, f.CreatedBy
            FROM [PLS].[V1FileUpload] f
            WHERE f.EntityType = @EntityType AND f.EntityKey = @EntityKey AND f.IsExist = 1 AND f.IsDeleted = 0
              AND NOT (@EntityType = 'Ticket' AND @IsManager = 0 AND EXISTS (
                  SELECT 1 FROM CHA.TicketChatHistory c WHERE c.TicketID = @EntityKey AND c.AttachmentID = f.AttachmentID AND c.IsAdmin = 1))
            ORDER BY f.CreatedDate DESC, f.AttachmentID DESC;
            RETURN;
        END

        IF @Operation IN ('Get', 'Delete', 'UpdateDescription')
        BEGIN
            DECLARE @FOwner NVARCHAR(100);
            SELECT @FOwner = f.CreatedBy FROM [PLS].[V1FileUpload] f
            WHERE f.AttachmentID = @ID AND f.EntityType = @EntityType AND f.EntityKey = @EntityKey
              AND f.IsExist = 1 AND f.IsDeleted = 0
              AND NOT (@EntityType = 'Ticket' AND @IsManager = 0 AND EXISTS (
                  SELECT 1 FROM CHA.TicketChatHistory c WHERE c.TicketID = @EntityKey AND c.AttachmentID = f.AttachmentID AND c.IsAdmin = 1));
            IF @FOwner IS NULL
            BEGIN
                SET @State = 404; SET @Message = 'Attachment not found';
                SELECT @State AS State, @Message AS Message; RETURN;
            END
            IF @Operation = 'Get'
            BEGIN
                SELECT FileName, FileOrginalName, CreatedDate, FileURL FROM [PLS].[V1FileUpload] WHERE AttachmentID = @ID;
                RETURN;
            END
            IF @FOwner <> @User
            BEGIN
                SET @State = 403; SET @Message = 'Only the person who added the file can change it';
                SELECT @State AS State, @Message AS Message; RETURN;
            END
            IF @Operation = 'UpdateDescription'
            BEGIN
                DECLARE @NewDesc NVARCHAR(200) = LEFT(NULLIF(LTRIM(RTRIM(JSON_VALUE(@LineData, '$.FileDescription'))), N''), 200);
                IF @NewDesc IS NULL
                BEGIN
                    SET @State = 400; SET @Message = 'A description is required';
                    SELECT @State AS State, @Message AS Message; RETURN;
                END
                UPDATE [PLS].[V1FileUpload] SET FileDescription = @NewDesc WHERE AttachmentID = @ID;
            END
            ELSE
                UPDATE [PLS].[V1FileUpload] SET IsDeleted = 1, DeletedBy = @User WHERE AttachmentID = @ID;
            SELECT @State AS State, 'OK' AS Message;
            RETURN;
        END

        IF @Operation = 'Insert'
        BEGIN
            IF @CanWrite = 0
            BEGIN
                SET @State = 403; SET @Message = @WhyNot;
                SELECT @State AS State, @Message AS Message; RETURN;
            END
            DECLARE @OrigName NVARCHAR(400) = LEFT(JSON_VALUE(@LineData, '$.FileOrginalName'), 400);
            DECLARE @Ext NVARCHAR(10) = LOWER(JSON_VALUE(@LineData, '$.Extension'));
            DECLARE @Desc NVARCHAR(200) = LEFT(NULLIF(LTRIM(RTRIM(JSON_VALUE(@LineData, '$.FileDescription'))), N''), 200);
            IF ISNULL(@OrigName, '') = '' OR @Ext IS NULL OR @Ext NOT LIKE '.%' OR @Ext LIKE '%[^.a-z0-9]%' OR LEN(@Ext) > 9
            BEGIN
                SET @State = 400; SET @Message = 'FileOrginalName and Extension are required';
                SELECT @State AS State, @Message AS Message; RETURN;
            END

            DECLARE @Now DATETIME = GETDATE();
            DECLARE @NewID INT = NEXT VALUE FOR dbo.Attachment;
            -- <AttachmentID>-<yyyyMMddHHmmss>-0.<ext>: the stored-name pattern the Files API accepts
            DECLARE @StoredName NVARCHAR(200) = CAST(@NewID AS NVARCHAR(12)) + N'-' + FORMAT(@Now, 'yyyyMMddHHmmss') + N'-0' + @Ext;
            INSERT INTO [PLS].[V1FileUpload]
                (AttachmentID, EntityType, EntityKey, FileOrginalName, FileName, Extension, FileDescription, CreatedBy, CreatedDate)
            VALUES (@NewID, @EntityType, @EntityKey, @OrigName, @StoredName, @Ext, ISNULL(@Desc, N''), @User, @Now);

            SELECT @NewID AS ID, @NewID AS FileID, @StoredName AS FileName, @Now AS CreatedDate;
            RETURN;
        END

        SET @State = 400; SET @Message = 'Unknown operation';
        SELECT @State AS State, @Message AS Message;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        -- always 500: a SQL error number (e.g. 403) must never read as a permission result
        SET @State = 500;
        SET @Message = 'SQL Exception: ' + ERROR_MESSAGE();
        SELECT @State AS State, @Message AS Message;
    END CATCH
END
GO
