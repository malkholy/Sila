USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [CHA].[APITicketOperation] -- the MOBILE app's channel / ticket procedure.
-- Same parameters, operations and result sets (in the same order) as the
-- version read live on 2026-10-22 (SQLScript/reference/CHA.APITicketOperation.sql),
-- so the app needs no change. The web uses CHA.APISilaWebTicketOperation.
--
-- What changed (the app sees an error message instead of a silent change):
--   * The caller's place in the ticket is checked (@User comes from the
--     SilaApi token). Members only: Get Right Side Ticket, New Chat, invites,
--     state changes, forwards. Admins-only notes (IsAdmin = 1) are returned to
--     ticket admins / team leaders only, and only they may write them.
--     Roles in a ticket: manager = IsAdmin or IsTeamLeader; creator =
--     IsCreatedBy or TicketHistory.CreatedByUser.
--       Start, Hold, Forward ................ managers
--       End, Reopen, Close .................. managers or the creator
--       Accept / Reject Forward ............. managers of the waiting copy
--       Cancel Ticket (cancel a forward) .... managers or the forwarder
--       Invite Member ....................... managers or the creator; only a
--                                             manager may invite someone as admin
--       Left Member ......................... yourself, or managers (not the creator)
--       Edit / Delete Chat .................. your own, non-system messages
--   * New Ticket / Forward Ticket: admin / team-leader roles are copied from the
--     channel (ChannelMembers), not taken from LineMember; the creator is
--     always a member.
--   * Bugs fixed: New Chat read LineData twice and saved every message twice
--     under one ChatID; Edit / Delete Chat cleared GRP.GroupUnreadChat instead
--     of the ticket's unread rows (and the copy counted as a new unread
--     message); Delete Chat made a copy of an admins-only note visible to all;
--     a re-invited member did not get his Home row back; multi-row member
--     deletes left other members' Home rows behind (the CHA.TicketMembers
--     triggers handle one row only).
--   * Writes run in one transaction; errors return @State = 1 + @Message.
--   * SPUserLog keeps every call but no longer stores message text.
--
-- Deploy in SSMS (or deploy.sh) only together with the app owner's go-ahead:
-- it replaces the procedure the mobile app uses.
-- =========================================================================
CREATE OR ALTER PROCEDURE [CHA].[APITicketOperation]
    @Operation nvarchar(250),
    @LineData nvarchar(max) = '',
    @LineMember nvarchar(max) = '',
    @TicketID int = 0,
    @TempTicketID int = 0,
    @ChannelID int = 0,
    @LastChatID int = 0,
    @MinChatID int = 0,
    @MaxSeq int = 0,
    @User nvarchar(250),
    @FireBaseToken nvarchar(4000) = '',
    @AppVersionWeb nvarchar(20) = '',
    @AppVersionAndroid nvarchar(20) = '',
    @AppVersionIos nvarchar(20) = '',
    @AppVersionDesktop nvarchar(20) = '',
    @PlatForm nvarchar(50) = '',
    @SqlStatement nvarchar(max) = '',
    @State int = 0 out,
    @Message nvarchar(1000) = '' out
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET @State = 0;
    SET @Message = '';

    DECLARE @Inactive int = 1, @UserID int = 0, @FullName nvarchar(max) = '';
    SELECT @Inactive = IsNotActive, @UserID = UserID, @FullName = FullName FROM UserMaster WHERE Username = @User;
    IF ISNULL(@Inactive, 1) <> 0
    BEGIN
        SET @Message = 'Inactive user. Operation blocked';
        SET @State = 1;
        RETURN;
    END

    BEGIN TRY
        DECLARE @ChatID int, @Text nvarchar(max) = '', @TextStyle nvarchar(max) = '', @ReplayMsgID int = 0,
                @LocalChatID int = 0, @OrginalChatID int = 0, @IsAdminChat int = 0, @ticketState int = 0,
                @Cnt int = 0, @ForceFullSync int = 0, @OrginalTicketID int = 0, @OrginalChannelID int = 0,
                @ForwardChannelID int = 0, @ForwardedTicketID int = 0, @RetTicket int = NULL, @RetChats int = 0,
                @Me nvarchar(max) = '@' + ISNULL(NULLIF(@FullName, ''), @User);

        -- every call is logged, as before -- without message text
        INSERT INTO SPUserLog (maxSeq, Username, ModuleName, SPName, SPOperation, AndroidVersion, DeskTopVerion, WebVersion,
                               IOSVersion, CreatedDate, platForm, FireBaseToken, SqlStatement, lineData, TicketTempID, TicketID)
        VALUES (@MaxSeq, @User, 'Channel', 'CHA.APITicketOperation', @Operation, @AppVersionAndroid, @AppVersionDesktop,
                @AppVersionWeb, @AppVersionIos, GETDATE(), @PlatForm, @FireBaseToken, '',
                CASE WHEN @Operation IN ('New Chat', 'Edit Chat', 'Delete Chat', 'New Ticket') THEN '' ELSE @LineData END,
                @TempTicketID, @TicketID);

        -------- Table Version (the app reads these two first, as before)
        SELECT * FROM ApplicationTableVersion;
        SELECT a.PlatFormName, a.VersionNo FROM SoftwareVersionHistory a WHERE IsNotActive = 0;
        ------
        EXEC APIUserFirebaseHistory @firebaseToken = @FirebaseToken, @PlatForm = @PlatForm, @user = @user;

        -- -----------------------------------------------------------------
        -- the caller's place in the ticket named by @TicketID
        -- -----------------------------------------------------------------
        DECLARE @IsMember int = 0, @IsManager int = 0, @IsCreator int = 0, @TChannel int = 0,
                @TCreatedBy nvarchar(50) = '', @TForwardBy nvarchar(50) = '';
        SELECT @IsMember = 1,
               @IsManager = CASE WHEN tm.IsAdmin = 1 OR tm.IsTeamLeader = 1 THEN 1 ELSE 0 END,
               @IsCreator = CASE WHEN tm.IsCreatedBy = 1 OR th.CreatedByUser = @User THEN 1 ELSE 0 END,
               @ticketState = th.TicketState, @TChannel = th.TicketChannelID, @TCreatedBy = ISNULL(th.CreatedByUser, ''),
               @TForwardBy = ISNULL(th.ForwardBy, ''), @OrginalTicketID = th.OrginalTicketID, @OrginalChannelID = th.OrginalChannelID
        FROM cha.TicketHistory th
        JOIN cha.TicketMembers tm ON tm.TicketID = th.TicketID AND tm.UserID = @UserID AND tm.IsLeft = 0
        WHERE th.TicketID = @TicketID;

        IF @Operation IN ('Forward Ticket', 'Accept Forward', 'Reject Forward', 'Cancel Ticket', 'Get Right Side Ticket',
                          'Left Member', 'Invite Member', 'End Ticket', 'Start Ticket', 'Close Ticket', 'Reopen Ticket', 'Hold Ticket')
           AND @IsMember = 0
        BEGIN
            SET @State = 1; SET @Message = 'Ticket not found';
            RETURN;
        END

        IF @Operation = 'Add favorite'
        BEGIN
            DELETE FROM cha.ChannelUserFavorite WHERE ChannelID = @ChannelID AND UserID = @UserID;
            INSERT INTO cha.ChannelUserFavorite (ChannelID, UserID) VALUES (@ChannelID, @UserID);
        END
        IF @Operation = 'Remove favorite'
            DELETE FROM cha.ChannelUserFavorite WHERE ChannelID = @ChannelID AND UserID = @UserID;

        -- =================================================================
        -- Forward Ticket (LineData = the target ChannelID, LineMember = people)
        -- =================================================================
        IF @Operation = 'Forward Ticket'
        BEGIN
            SET @ForwardChannelID = TRY_CAST(@LineData AS int);
            IF @IsManager = 0 BEGIN SET @State = 1; SET @Message = 'Only ticket admins and team leaders can forward a ticket'; RETURN; END
            IF @ticketState <> 0 BEGIN SET @State = 1; SET @Message = 'Ticket State is not Correct '; RETURN; END
            IF @ForwardChannelID IS NULL OR @ForwardChannelID = @TChannel
               OR NOT EXISTS (SELECT 1 FROM cha.ChannelMaster WHERE ChannelID = @ForwardChannelID AND ISNULL(InActive, 0) = 0)
               OR (SELECT CategoryID FROM cha.ChannelMaster WHERE ChannelID = @ForwardChannelID)
                  <> (SELECT CategoryID FROM cha.ChannelMaster WHERE ChannelID = @TChannel)
            BEGIN SET @State = 1; SET @Message = 'Forwarding Ticket is not Allowed '; RETURN; END

            -- members of the copy: the listed users + the target channel's admins / team leaders +
            -- the ticket's creator; roles from the target channel
            DECLARE @FMembers TABLE (UserID int PRIMARY KEY, IsAdmin int, IsTeamLeader int, IsCreatedBy int, IsCC int, IsInvited int);
            INSERT INTO @FMembers
            SELECT x.UserID, ISNULL(MAX(cm.IsAdmin), 0), ISNULL(MAX(cm.IsTeamLeader), 0), 0,
                   MAX(CASE WHEN x.IsCC = 1 THEN 1 ELSE 0 END), MAX(CASE WHEN x.IsInvited = 1 THEN 1 ELSE 0 END)
            FROM OPENJSON(CASE WHEN ISJSON(@LineMember) = 1 THEN @LineMember ELSE '[]' END)
                 WITH (UserID int, IsAdmin int, IsTeamLeader int, IsCreatedBy int, IsCC int, IsInvited int) x
            JOIN UserMaster u ON u.UserID = x.UserID AND u.IsNotActive = 0
            LEFT JOIN cha.ChannelMembers cm ON cm.ChannelID = @ForwardChannelID AND cm.UserID = x.UserID
            GROUP BY x.UserID;
            INSERT INTO @FMembers
            SELECT cm.UserID, cm.IsAdmin, cm.IsTeamLeader, 0, 0, 0
            FROM cha.ChannelMembers cm JOIN UserMaster u ON u.UserID = cm.UserID AND u.IsNotActive = 0
            WHERE cm.ChannelID = @ForwardChannelID AND (cm.IsAdmin = 1 OR cm.IsTeamLeader = 1)
              AND NOT EXISTS (SELECT 1 FROM @FMembers f WHERE f.UserID = cm.UserID);
            UPDATE f SET f.IsCreatedBy = 1 FROM @FMembers f JOIN UserMaster u ON u.UserID = f.UserID WHERE u.Username = @TCreatedBy;
            IF @@ROWCOUNT = 0
                INSERT INTO @FMembers SELECT u.UserID, 0, 0, 1, 0, 0 FROM UserMaster u WHERE u.Username = @TCreatedBy AND u.IsNotActive = 0;

            BEGIN TRANSACTION;
            SET @Text = '@' + @FullName + ' has Forwarded Ticket #' + CONVERT(nvarchar, @TicketID);
            SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO cha.TicketChatHistory (ChatID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate, LocalChatID, ChannelID, IsSystem)
            VALUES (@ChatID, @TicketID, @UserID, @User, @Text, @Text, 0, GETDATE(), 0, @TChannel, 1);
            UPDATE cha.TicketHistory SET TicketState = 2, ForwardDate = GETDATE(), ForwardBy = @User, LastMaintDate = GETDATE(), LastMaintByUser = @User
            WHERE TicketID = @TicketID;
            SET @OrginalTicketID = @TicketID;
            SET @TicketID = NEXT VALUE FOR dbo.TicketID;
            INSERT INTO cha.TicketHistory (TicketID, TicketSubject, CreatedByUser, CreatedDate, TicketChannelID, OrginalChannelID, OrginalTicketID, TicketState)
            SELECT @TicketID, TicketSubject, CreatedByUser, GETDATE(), @ForwardChannelID, TicketChannelID, TicketID, 3
            FROM cha.TicketHistory WHERE TicketID = @OrginalTicketID;
            INSERT INTO cha.TicketMembers (ChannelID, TicketID, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, IsMuted, IsInvited)
            SELECT @ForwardChannelID, @TicketID, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, 0, IsInvited FROM @FMembers;
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- =================================================================
        -- Accept Forward (on the waiting copy)
        -- =================================================================
        IF @Operation = 'Accept Forward'
        BEGIN
            IF @IsManager = 0 BEGIN SET @State = 1; SET @Message = 'Only ticket admins and team leaders can accept a forward'; RETURN; END
            IF @ticketState <> 3 BEGIN SET @State = 1; SET @Message = 'Ticket State is not Correct '; RETURN; END
            BEGIN TRANSACTION;
            SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
            SET @Text = '@' + @FullName + ' has accepted forwarded Ticket #' + CONVERT(nvarchar, @TicketID);
            INSERT INTO cha.TicketChatHistory (ChatID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate, AttachmentID, LocalChatID, ChannelID, IsSystem)
            VALUES (@ChatID, @TicketID, @UserID, @User, @Text, @Text, 0, GETDATE(), 0, 0, @TChannel, 1);
            INSERT INTO cha.TicketHistoryForward SELECT * FROM cha.TicketHistory WHERE TicketID = @OrginalTicketID;
            DELETE FROM cha.TicketMembers WHERE TicketID = @OrginalTicketID;
            DELETE FROM SilaHistory WHERE TicketID = @OrginalTicketID AND RecordType = 'C';   -- the delete trigger handles one row only
            DELETE FROM cha.TicketHistory WHERE TicketID = @OrginalTicketID;
            UPDATE cha.TicketHistory SET TicketState = 0, LastMaintDate = GETDATE(), LastMaintByUser = @User WHERE TicketID = @TicketID;
            DELETE cha.TicketChatHistory WHERE TicketID = @OrginalTicketID AND IsAdmin = 1;
            UPDATE cha.TicketChatHistory SET ChannelID = @TChannel, TicketID = @TicketID WHERE TicketID = @OrginalTicketID;
            UPDATE cha.TicketUnreadChat SET TicketID = @TicketID
            WHERE TicketID = @OrginalTicketID AND UserID IN (SELECT x.UserID FROM cha.TicketMembers x WHERE x.TicketID = @TicketID);
            DELETE FROM cha.TicketUnreadChat WHERE TicketID = @OrginalTicketID;
            -- moving rows re-ran the message trigger: put the newest message and the counts right
            UPDATE th SET th.LastChatID = l.ChatID, th.LastMessage = l.Text
            FROM cha.TicketHistory th
            CROSS APPLY (SELECT TOP (1) c.ChatID, c.Text FROM cha.TicketChatHistory c
                         WHERE c.TicketID = th.TicketID AND c.IsAdmin = 0 ORDER BY c.ChatID DESC) l
            WHERE th.TicketID = @TicketID;
            UPDATE tm SET tm.UnreadCount = (SELECT COUNT(*) FROM cha.TicketUnreadChat u WHERE u.TicketID = tm.TicketID AND u.UserID = tm.UserID)
            FROM cha.TicketMembers tm WHERE tm.TicketID = @TicketID;
            UPDATE sh SET sh.UnreadMessage = tm.UnreadCount
            FROM SilaHistory sh JOIN cha.TicketMembers tm ON tm.TicketID = sh.TicketID AND tm.UserID = sh.UserID
            WHERE sh.TicketID = @TicketID AND sh.RecordType = 'C';
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- =================================================================
        -- Reject Forward (on the waiting copy)
        -- =================================================================
        IF @Operation = 'Reject Forward'
        BEGIN
            IF @IsManager = 0 BEGIN SET @State = 1; SET @Message = 'Only ticket admins and team leaders can reject a forward'; RETURN; END
            IF @ticketState <> 3 BEGIN SET @State = 1; SET @Message = 'Ticket State is not Correct '; RETURN; END
            BEGIN TRANSACTION;
            SET @Text = '@' + @FullName + ' has rejected forwarded Ticket #' + CONVERT(nvarchar, @TicketID);
            SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO cha.TicketChatHistory (ChatID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate, AttachmentID, LocalChatID, ChannelID, IsSystem)
            VALUES (@ChatID, @OrginalTicketID, @UserID, @User, @Text, @Text, 0, GETDATE(), 0, 0, @OrginalChannelID, 1);
            DELETE FROM cha.TicketUnreadChat WHERE TicketID = @TicketID;
            DELETE FROM cha.TicketMembers WHERE TicketID = @TicketID;
            DELETE FROM SilaHistory WHERE TicketID = @TicketID AND RecordType = 'C';
            DELETE FROM cha.TicketHistory WHERE TicketID = @TicketID;
            UPDATE cha.TicketHistory SET TicketState = 0, LastMaintDate = GETDATE(), LastMaintByUser = @User WHERE TicketID = @OrginalTicketID;
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;   -- the copy is gone: an empty set, as before
        END

        -- =================================================================
        -- Cancel Ticket (cancel a forward; on the original)
        -- =================================================================
        IF @Operation = 'Cancel Ticket'
        BEGIN
            IF @IsManager = 0 AND @TForwardBy <> @User
            BEGIN SET @State = 1; SET @Message = 'Only ticket admins, team leaders or whoever forwarded it can cancel the forward'; RETURN; END
            IF @ticketState <> 2 BEGIN SET @State = 1; SET @Message = 'Ticket State is not Correct '; RETURN; END
            SELECT TOP (1) @ForwardedTicketID = TicketID FROM cha.TicketHistory WHERE OrginalTicketID = @TicketID AND TicketState = 3 ORDER BY TicketID DESC;
            BEGIN TRANSACTION;
            IF ISNULL(@ForwardedTicketID, 0) <> 0
            BEGIN
                DELETE FROM cha.TicketUnreadChat WHERE TicketID = @ForwardedTicketID;
                DELETE FROM cha.TicketMembers WHERE TicketID = @ForwardedTicketID;
                DELETE FROM SilaHistory WHERE TicketID = @ForwardedTicketID AND RecordType = 'C';
                DELETE FROM cha.TicketHistory WHERE TicketID = @ForwardedTicketID;
            END
            UPDATE cha.TicketHistory SET TicketState = 0, LastMaintDate = GETDATE(), LastMaintByUser = @User WHERE TicketID = @TicketID;
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- =================================================================
        -- Reads (unchanged: they are limited to the caller's own tickets)
        -- =================================================================
        IF @Operation = 'Get Closed Tickets'
            SELECT a.*,
                   (SELECT TOP 1 IsMuted FROM CHA.TicketMembers M WHERE a.TicketID = M.TicketID AND M.UserID = @UserID) AS IsTicketMuted,
                   ISNULL((SELECT TOP 1 UnreadCount FROM cha.TicketMembers x WHERE x.TicketID = a.TicketID AND x.UserID = @UserID), 0) AS UnreadMessages
            FROM CHA.V_TicketHistory a
            WHERE a.TicketID IN (SELECT x.TicketID FROM cha.TicketMembers x WHERE UserID = @UserID AND IsLeft = 0) AND TicketState = 50;

        IF @Operation = 'Get Left Side Ticket'
        BEGIN
            SELECT @Cnt = COUNT(*) FROM UserSyncMaster WHERE UserID = @UserID;
            IF @Cnt = 0
            BEGIN
                INSERT INTO UserSyncMaster (UserID, ForceFullSync, LastForceSyncDate) VALUES (@UserID, 0, GETDATE());
                SET @ForceFullSync = 1;
            END
            ELSE
                SELECT @ForceFullSync = ForceFullSync FROM UserSyncMaster WHERE UserID = @UserID;
            IF @ForceFullSync = 1
            BEGIN
                SET @MaxSeq = 0;
                UPDATE UserSyncMaster SET ForceFullSync = 0, LastForceSyncDate = GETDATE() WHERE UserID = @UserID;
            END
            SELECT @ForceFullSync AS ForceFullSync, a.*,
                   (SELECT TOP 1 IsMuted FROM CHA.TicketMembers M WHERE a.TicketID = M.TicketID AND M.UserID = @UserID) AS IsTicketMuted,
                   ISNULL((SELECT TOP 1 UnreadCount FROM cha.TicketMembers x WHERE x.TicketID = a.TicketID AND x.UserID = @UserID), 0) AS UnreadMessages
            FROM CHA.V_TicketHistory a
            WHERE (@ChannelID = 0 OR a.TicketChannelID = @ChannelID)
              AND a.TicketID IN (SELECT x.TicketID FROM cha.TicketMembers x WHERE UserID = @UserID AND IsLeft = 0);
        END

        -- =================================================================
        -- Get Right Side Ticket (members only; admins-only notes for managers)
        -- =================================================================
        IF @Operation = 'Get Right Side Ticket'
        BEGIN
            SELECT a.ID, a.ChatID, a.TicketID, a.FromUserID, a.FromUserName, a.Text, a.ReplayMsgID, a.IsDeleted, a.OrginalChatID,
                   a.IsEdited, a.CreatedDate, a.LastMaintBy, a.LastMaintDate, a.TextStyle, a.AttachmentID, a.LocalChatID,
                   IsSystem, isadmin, b.FileName, b.FileOrginalName, b.FileSize, b.FileExtension, b.FileURL
            FROM cha.TicketChatHistory a LEFT OUTER JOIN AttachmentHistory b ON a.AttachmentID = b.AttachmentID
            WHERE a.TicketID = @TicketID AND a.ChatID > @LastChatID AND (a.IsAdmin = 0 OR @IsManager = 1)
            ORDER BY a.ChatID DESC;

            SELECT a.*,
                   (SELECT TOP 1 IsMuted FROM CHA.TicketMembers M WHERE a.TicketID = M.TicketID AND M.UserID = @UserID) AS IsTicketMuted,
                   ISNULL((SELECT TOP 1 UnreadCount FROM cha.TicketMembers x WHERE x.TicketID = a.TicketID AND x.UserID = @UserID), 0) AS UnreadMessages
            FROM CHA.V_TicketHistory a WHERE TicketID = @TicketID;

            DELETE FROM cha.TicketUnreadChat WHERE UserID = @UserID AND TicketID = @TicketID;

            SELECT TM.ID, TM.UserID, TM.IsCreatedBy, TM.IsTeamLeader, TM.IsAdmin, TM.IsCC, TM.IsInvited,
                   a.Username, a.FullName, IsMuted AS TicketMuted, TM.IsLeft
            FROM CHA.TicketMembers AS TM LEFT OUTER JOIN UserMaster a ON TM.UserID = a.UserID
            WHERE TM.TicketID = @TicketID AND IsLeft = 0;
        END

        IF @Operation = 'Channel List'
        BEGIN
            SELECT x.ChannelID, x.Name, x.CategoryID, a.CategoryDescription, x.IsPrivate,
                   (SELECT COUNT(*) FROM cha.ChannelUserFavorite z WHERE z.ChannelID = x.ChannelID AND z.UserID = @UserID) IsFavorite
            FROM cha.ChannelMaster x LEFT OUTER JOIN cha.ChannelCategory a ON a.ChannelCategoryID = x.CategoryID;
            SELECT * FROM cha.ChannelMembers x;
        END

        -- =================================================================
        -- New Ticket (LineData = [{TicketSubject, TicketChannelID, TicketText}],
        -- LineMember = people; roles from the channel)
        -- =================================================================
        IF @Operation = 'New Ticket'
        BEGIN
            DECLARE @TicketSubject nvarchar(max), @TicketChannelID int, @TicketText nvarchar(max);
            SELECT TOP 1 @TicketSubject = TicketSubject, @TicketChannelID = TicketChannelID, @TicketText = TicketText
            FROM OPENJSON(CASE WHEN ISJSON(@LineData) = 1 THEN @LineData ELSE '[]' END)
                 WITH (TicketSubject nvarchar(max), TicketChannelID int, TicketText nvarchar(max));
            IF ISNULL(@TicketChannelID, 0) = 0 SET @TicketChannelID = @ChannelID;

            SELECT @Cnt = COUNT(*) FROM cha.TicketHistory WHERE TempTicketID = @TempTicketID AND TempTicketID <> 0;
            IF @Cnt <> 0
                SELECT @RetTicket = TicketID FROM cha.TicketHistory WHERE TempTicketID = @TempTicketID AND CreatedByUser = @User;
            ELSE IF NOT EXISTS (SELECT 1 FROM cha.ChannelMaster WHERE ChannelID = @TicketChannelID AND ISNULL(InActive, 0) = 0)
            BEGIN SET @State = 1; SET @Message = 'Channel not found'; RETURN; END
            ELSE IF LTRIM(RTRIM(ISNULL(@TicketSubject, ''))) = ''
            BEGIN SET @State = 1; SET @Message = 'Ticket subject is required'; RETURN; END
            ELSE
            BEGIN
                DECLARE @NMembers TABLE (UserID int PRIMARY KEY, IsAdmin int, IsTeamLeader int, IsCreatedBy int, IsCC int);
                INSERT INTO @NMembers
                SELECT x.UserID, ISNULL(MAX(cm.IsAdmin), 0), ISNULL(MAX(cm.IsTeamLeader), 0), 0, MAX(CASE WHEN x.IsCC = 1 THEN 1 ELSE 0 END)
                FROM OPENJSON(CASE WHEN ISJSON(@LineMember) = 1 THEN @LineMember ELSE '[]' END)
                     WITH (UserID int, IsAdmin int, IsTeamLeader int, IsCreatedBy int, IsCC int) x
                JOIN UserMaster u ON u.UserID = x.UserID AND u.IsNotActive = 0
                LEFT JOIN cha.ChannelMembers cm ON cm.ChannelID = @TicketChannelID AND cm.UserID = x.UserID
                WHERE x.UserID <> @UserID
                GROUP BY x.UserID;
                INSERT INTO @NMembers
                SELECT @UserID, ISNULL(cm.IsAdmin, 0), ISNULL(cm.IsTeamLeader, 0), 1, 0
                FROM (SELECT 1 AS one) z LEFT JOIN cha.ChannelMembers cm ON cm.ChannelID = @TicketChannelID AND cm.UserID = @UserID;

                BEGIN TRANSACTION;
                SET @TicketID = NEXT VALUE FOR dbo.TicketID;
                INSERT INTO CHA.TicketHistory (TicketID, TicketSubject, TicketChannelID, CreatedDate, CreatedByUser, LastMaintDate, LastMaintByUser, TempTicketID)
                VALUES (@TicketID, @TicketSubject, @TicketChannelID, GETDATE(), @User, GETDATE(), @User, @TempTicketID);
                INSERT INTO cha.TicketMembers (ChannelID, TicketID, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, IsMuted)
                SELECT @TicketChannelID, @TicketID, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, 0 FROM @NMembers;
                SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO cha.TicketChatHistory (ChatID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate, LocalChatID, ChannelID, IsSystem)
                VALUES (@ChatID, @TicketID, @UserID, @User, ISNULL(@TicketText, ''), ISNULL(@TicketText, ''), 0, GETDATE(), 0, @TicketChannelID, 0);
                COMMIT TRANSACTION;
                SET @RetTicket = @TicketID;
            END
        END

        -- =================================================================
        -- Left Member (LineMember = [{UserID}]): yourself, or managers (not the creator)
        -- =================================================================
        IF @Operation = 'Left Member'
        BEGIN
            DECLARE @Leave TABLE (UserID int PRIMARY KEY, FullName nvarchar(max), Username nvarchar(250), IsCreator int);
            INSERT INTO @Leave
            SELECT DISTINCT tm.UserID, ISNULL(NULLIF(u.FullName, ''), u.Username), u.Username,
                   CASE WHEN tm.IsCreatedBy = 1 OR u.Username = @TCreatedBy THEN 1 ELSE 0 END
            FROM OPENJSON(CASE WHEN ISJSON(@LineMember) = 1 THEN @LineMember ELSE '[]' END) WITH (UserID int) x
            JOIN cha.TicketMembers tm ON tm.TicketID = @TicketID AND tm.UserID = x.UserID AND tm.IsLeft = 0
            JOIN UserMaster u ON u.UserID = tm.UserID;
            IF EXISTS (SELECT 1 FROM @Leave WHERE UserID <> @UserID) AND @IsManager = 0
            BEGIN SET @State = 1; SET @Message = 'Only ticket admins and team leaders can remove people'; RETURN; END
            IF EXISTS (SELECT 1 FROM @Leave WHERE UserID <> @UserID AND IsCreator = 1)
            BEGIN SET @State = 1; SET @Message = 'The ticket creator can not be removed'; RETURN; END

            DECLARE @LUser int;
            BEGIN TRANSACTION;
            -- one row per statement: the member triggers handle one row only
            WHILE EXISTS (SELECT 1 FROM @Leave)
            BEGIN
                SELECT TOP (1) @LUser = UserID, @Text = CASE WHEN Username = @User
                       THEN '@' + FullName + ' has left Ticket #' + CONVERT(nvarchar, @TicketID)
                       ELSE '@' + FullName + ' has been removed from this Ticket ' END
                FROM @Leave ORDER BY UserID;
                UPDATE cha.TicketMembers SET IsLeft = 1 WHERE UserID = @LUser AND TicketID = @TicketID;
                SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO cha.TicketChatHistory (ChatID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate, AttachmentID, LocalChatID, ChannelID, IsSystem)
                VALUES (@ChatID, @TicketID, @UserID, @User, @Text, @Text, 0, GETDATE(), 0, 0, @TChannel, 1);
                DELETE FROM @Leave WHERE UserID = @LUser;
            END
            COMMIT TRANSACTION;
        END

        -- =================================================================
        -- Invite Member (LineMember = [{UserID, IsAdmin}]): managers or the creator
        -- =================================================================
        IF @Operation = 'Invite Member'
        BEGIN
            IF @IsManager = 0 AND @IsCreator = 0
            BEGIN SET @State = 1; SET @Message = 'Only ticket admins, team leaders or the creator can invite people'; RETURN; END
            IF @ticketState >= 50 BEGIN SET @State = 1; SET @Message = 'Ticket State is not Correct '; RETURN; END
            DECLARE @Inv TABLE (UserID int PRIMARY KEY, IsAdmin int, FullName nvarchar(max), Existing int);
            INSERT INTO @Inv
            SELECT x.UserID, MAX(CASE WHEN x.IsAdmin = 1 AND @IsManager = 1 THEN 1 ELSE 0 END),
                   MAX(ISNULL(NULLIF(u.FullName, ''), u.Username)),
                   MAX(CASE WHEN tm.UserID IS NULL THEN 0 WHEN tm.IsLeft = 1 THEN 1 ELSE 2 END)
            FROM OPENJSON(CASE WHEN ISJSON(@LineMember) = 1 THEN @LineMember ELSE '[]' END) WITH (UserID int, IsAdmin int) x
            JOIN UserMaster u ON u.UserID = x.UserID AND u.IsNotActive = 0
            LEFT JOIN cha.TicketMembers tm ON tm.TicketID = @TicketID AND tm.UserID = x.UserID
            GROUP BY x.UserID;
            DELETE FROM @Inv WHERE Existing = 2;

            BEGIN TRANSACTION;
            INSERT INTO cha.TicketMembers (ChannelID, TicketID, UserID, IsInvited, IsAdmin)
            SELECT @TChannel, @TicketID, UserID, 1, IsAdmin FROM @Inv WHERE Existing = 0;
            UPDATE tm SET tm.IsLeft = 0 FROM cha.TicketMembers tm JOIN @Inv i ON i.UserID = tm.UserID AND i.Existing = 1
            WHERE tm.TicketID = @TicketID;
            -- a re-invited member gets his Home row back (the update trigger only handles leaving)
            INSERT INTO SilaHistory (RecordType, TicketID, UserID, ChannelID, TicketSubject)
            SELECT 'C', @TicketID, i.UserID, @TChannel, (SELECT TicketSubject FROM cha.TicketHistory WHERE TicketID = @TicketID)
            FROM @Inv i
            WHERE NOT EXISTS (SELECT 1 FROM SilaHistory sh WHERE sh.RecordType = 'C' AND sh.TicketID = @TicketID AND sh.UserID = i.UserID);
            INSERT INTO cha.TicketChatHistory (ChatID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate, AttachmentID, LocalChatID, ChannelID, IsSystem)
            SELECT NEXT VALUE FOR dbo.ChatTicket, @TicketID, @UserID, @User,
                   '@' + i.FullName + ' has been invited to Ticket #' + CONVERT(nvarchar, @TicketID),
                   '@' + i.FullName + ' has been invited to Ticket #' + CONVERT(nvarchar, @TicketID),
                   0, GETDATE(), 0, 0, @TChannel, 1
            FROM @Inv i;
            UPDATE cha.TicketHistory SET
                Members = ISNULL((SELECT STRING_AGG(CAST(x.UserID AS nvarchar(10)), ',') FROM cha.TicketMembers x WHERE x.TicketID = @TicketID AND x.IsLeft = 0), ''),
                LastMaintDate = GETDATE(), LastMaintByUser = @User
            WHERE TicketID = @TicketID;
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- =================================================================
        -- State changes
        -- =================================================================
        IF @Operation IN ('End Ticket', 'Start Ticket', 'Close Ticket', 'Reopen Ticket', 'Hold Ticket')
        BEGIN
            DECLARE @ToState int = CASE @Operation WHEN 'Start Ticket' THEN 1 WHEN 'Hold Ticket' THEN 5 WHEN 'End Ticket' THEN 10
                                                   WHEN 'Reopen Ticket' THEN 1 ELSE 50 END;
            IF NOT ((@Operation = 'Start Ticket' AND @ticketState = 0)
                 OR (@Operation = 'Hold Ticket' AND @ticketState = 1)
                 OR (@Operation = 'End Ticket' AND @ticketState IN (0, 1))
                 OR (@Operation = 'Reopen Ticket' AND @ticketState IN (10, 5))
                 OR (@Operation = 'Close Ticket' AND @ticketState IN (10, 0)))
            BEGIN SET @State = 1; SET @Message = 'Ticket State is not Correct '; RETURN; END
            IF @Operation IN ('Start Ticket', 'Hold Ticket') AND @IsManager = 0
            BEGIN SET @State = 1; SET @Message = 'You do not have a permission to ' + CASE WHEN @Operation = 'Start Ticket' THEN 'start' ELSE 'hold' END + ' Ticket  '; RETURN; END
            IF @Operation IN ('End Ticket', 'Close Ticket', 'Reopen Ticket') AND @IsManager = 0 AND @IsCreator = 0
            BEGIN SET @State = 1; SET @Message = 'Only ticket admins, team leaders or the creator can do that'; RETURN; END

            SET @Text = '@' + @FullName + CASE @Operation
                WHEN 'Start Ticket' THEN ' has started Ticket #' WHEN 'Hold Ticket' THEN ' has holded Ticket #'
                WHEN 'End Ticket' THEN ' has ended Ticket #' WHEN 'Reopen Ticket' THEN ' has re-opened Ticket #'
                ELSE ' has closed Ticket #' END + CONVERT(nvarchar, @TicketID);
            BEGIN TRANSACTION;
            SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO cha.TicketChatHistory (ChatID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate, AttachmentID, LocalChatID, ChannelID, IsSystem)
            VALUES (@ChatID, @TicketID, @UserID, @User, @Text, @Text, 0, GETDATE(), 0, 0, @TChannel, 1);
            UPDATE cha.TicketHistory SET
                TicketState = @ToState,
                StartDate = CASE WHEN @Operation = 'Start Ticket' OR (@Operation = 'End Ticket' AND @ticketState = 0) THEN GETDATE() ELSE StartDate END,
                StartBy   = CASE WHEN @Operation = 'Start Ticket' OR (@Operation = 'End Ticket' AND @ticketState = 0) THEN @User ELSE StartBy END,
                HoldDate  = CASE WHEN @Operation = 'Hold Ticket' THEN GETDATE() ELSE HoldDate END,
                HoldBy    = CASE WHEN @Operation = 'Hold Ticket' THEN @User ELSE HoldBy END,
                EndedDate = CASE WHEN @Operation = 'End Ticket' THEN GETDATE() ELSE EndedDate END,
                EndedBy   = CASE WHEN @Operation = 'End Ticket' THEN @User WHEN @Operation = 'Reopen Ticket' THEN '' ELSE EndedBy END,
                ClosedDate = CASE WHEN @Operation = 'Close Ticket' THEN GETDATE() ELSE ClosedDate END,
                ClosedBy  = CASE WHEN @Operation = 'Close Ticket' THEN @User ELSE ClosedBy END,
                LastMaintDate = GETDATE(), LastMaintByUser = @User
            WHERE TicketID = @TicketID;
            IF @Operation = 'Close Ticket'
                DELETE FROM SilaHistory WHERE TicketID = @TicketID AND RecordType = 'C';
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- =================================================================
        -- New Chat (LineData = [{ChatID, TicketID, Text, TextStyle, ReplayMsgID, LocalChatID, OrginalChatID, IsAdmin}])
        -- =================================================================
        IF @Operation = 'New Chat'
        BEGIN
            SELECT TOP 1 @TicketID = TicketID, @Text = Text, @ReplayMsgID = ReplayMsgID, @TextStyle = TextStyle,
                   @LocalChatID = LocalChatID, @IsAdminChat = CASE WHEN IsAdmin = 1 THEN 1 ELSE 0 END
            FROM OPENJSON(CASE WHEN ISJSON(@LineData) = 1 THEN @LineData ELSE '[]' END)
                 WITH (ChatID int, TicketID int, Text nvarchar(max), TextStyle nvarchar(max), ReplayMsgID int,
                       LocalChatID int, OrginalChatID int, IsAdmin int);
            SELECT @IsMember = 0, @IsManager = 0;
            SELECT @IsMember = 1, @IsManager = CASE WHEN tm.IsAdmin = 1 OR tm.IsTeamLeader = 1 THEN 1 ELSE 0 END,
                   @ticketState = th.TicketState, @TChannel = th.TicketChannelID
            FROM cha.TicketHistory th
            JOIN cha.TicketMembers tm ON tm.TicketID = th.TicketID AND tm.UserID = @UserID AND tm.IsLeft = 0
            WHERE th.TicketID = @TicketID;
            IF @IsMember = 0 BEGIN SET @State = 1; SET @Message = 'Ticket not found'; RETURN; END
            IF @IsAdminChat = 1 AND @IsManager = 0
            BEGIN SET @State = 1; SET @Message = 'Only ticket admins can write admins-only notes'; RETURN; END
            IF @ticketState NOT IN (0, 1) BEGIN SET @Message = 'Ticket State is not correct '; SET @State = 1; RETURN; END
            IF ISNULL(@ReplayMsgID, 0) <> 0 AND NOT EXISTS (SELECT 1 FROM cha.TicketChatHistory WHERE ChatID = @ReplayMsgID AND TicketID = @TicketID)
                SET @ReplayMsgID = 0;
            SET @TextStyle = REPLACE(ISNULL(@TextStyle, ''), 'class="table table-bordered"', 'border="1"');

            BEGIN TRANSACTION;
            IF @ticketState = 0 AND @IsManager = 1 AND @IsAdminChat = 0
                UPDATE cha.TicketHistory SET TicketState = 1, StartDate = GETDATE(), StartBy = @User, LastMaintDate = GETDATE() WHERE TicketID = @TicketID;
            -- one row per message (a re-sent LocalChatID is not saved again)
            IF NOT EXISTS (SELECT 1 FROM CHA.TicketChatHistory WHERE FromUserID = @UserID AND LocalChatID = @LocalChatID AND ISNULL(@LocalChatID, 0) <> 0)
            BEGIN
                SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO CHA.TicketChatHistory (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, ReplayMsgID, CreatedBy, CreatedDate,
                                                   LastMaintBy, LastMaintDate, TextStyle, LocalChatID, OrginalChatID, IsAdmin)
                VALUES (@ChatID, @TChannel, @TicketID, @UserID, @User, ISNULL(@Text, ''), ISNULL(@ReplayMsgID, 0), @User, GETDATE(),
                        @User, GETDATE(), @TextStyle, ISNULL(@LocalChatID, 0), 0, @IsAdminChat);
            END
            COMMIT TRANSACTION;
            SET @RetChats = 1;
        END

        -- =================================================================
        -- Edit Chat / Delete Chat (own, non-system messages)
        -- =================================================================
        IF @Operation IN ('Edit Chat', 'Delete Chat')
        BEGIN
            SELECT TOP 1 @Text = Text, @ReplayMsgID = ReplayMsgID, @TextStyle = TextStyle,
                   @LocalChatID = LocalChatID, @OrginalChatID = OrginalChatID
            FROM OPENJSON(CASE WHEN ISJSON(@LineData) = 1 THEN @LineData ELSE '[]' END)
                 WITH (ChatID int, TicketID int, Text nvarchar(max), TextStyle nvarchar(max), ReplayMsgID int,
                       LocalChatID int, OrginalChatID int, IsAdmin int);
            DECLARE @EFrom int, @ETicket int, @ESystem int, @EDeleted int, @EAdmin int;
            SELECT TOP (1) @EFrom = FromUserID, @ETicket = TicketID, @ESystem = IsSystem, @EDeleted = IsDeleted, @EAdmin = IsAdmin
            FROM CHA.TicketChatHistory WHERE ChatID = @OrginalChatID ORDER BY ID;
            IF @EFrom IS NULL OR @EFrom <> @UserID OR @ESystem <> 0
               OR NOT EXISTS (SELECT 1 FROM cha.TicketMembers WHERE TicketID = @ETicket AND UserID = @UserID AND IsLeft = 0)
            BEGIN SET @State = 1; SET @Message = 'You can only change your own messages'; RETURN; END
            IF @EDeleted <> 0 OR EXISTS (SELECT 1 FROM CHA.TicketChatHistory WHERE TicketID = @ETicket AND OrginalChatID = @OrginalChatID)
            BEGIN SET @State = 1; SET @Message = 'This message was already changed'; RETURN; END
            SET @TextStyle = REPLACE(ISNULL(@TextStyle, ''), 'class="table table-bordered"', 'border="1"');
            IF @Operation = 'Delete Chat' SET @Text = 'Text Is Deleted ********';

            BEGIN TRANSACTION;
            UPDATE CHA.TicketChatHistory SET LastMaintBy = @User, LastMaintDate = GETDATE(),
                   IsEdited = CASE WHEN @Operation = 'Edit Chat' THEN 1 ELSE IsEdited END,
                   IsDeleted = CASE WHEN @Operation = 'Delete Chat' THEN 1 ELSE IsDeleted END
            WHERE ChatID = @OrginalChatID AND TicketID = @ETicket;
            SET @ChatID = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO CHA.TicketChatHistory (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, CreatedDate,
                                               AttachmentID, LocalChatID, OrginalChatID, IsEdited, IsDeleted, LastMaintBy, CreatedBy, LastMaintDate, IsAdmin)
            SELECT TOP (1) @ChatID, ChannelID, TicketID, FromUserID, FromUserName, ISNULL(@Text, ''), @TextStyle, ReplayMsgID, GETDATE(),
                   CASE WHEN @Operation = 'Delete Chat' THEN 0 ELSE AttachmentID END, ISNULL(@LocalChatID, 0), @OrginalChatID,
                   0, CASE WHEN @Operation = 'Delete Chat' THEN 1 ELSE 0 END, @User, @User, GETDATE(), @EAdmin
            FROM CHA.TicketChatHistory WHERE ChatID = @OrginalChatID AND TicketID = @ETicket ORDER BY ID;
            -- the copy is not a new unread message (the old code cleared the GROUP table here)
            DELETE FROM cha.TicketUnreadChat WHERE TicketID = @ETicket AND ChatID IN (@OrginalChatID, @ChatID);
            UPDATE tm SET tm.UnreadCount = (SELECT COUNT(*) FROM cha.TicketUnreadChat u WHERE u.TicketID = tm.TicketID AND u.UserID = tm.UserID)
            FROM cha.TicketMembers tm WHERE tm.TicketID = @ETicket;
            UPDATE sh SET sh.UnreadMessage = tm.UnreadCount
            FROM SilaHistory sh JOIN cha.TicketMembers tm ON tm.TicketID = sh.TicketID AND tm.UserID = sh.UserID
            WHERE sh.TicketID = @ETicket AND sh.RecordType = 'C';
            COMMIT TRANSACTION;
            SELECT @IsManager = CASE WHEN tm.IsAdmin = 1 OR tm.IsTeamLeader = 1 THEN 1 ELSE 0 END
            FROM cha.TicketMembers tm WHERE tm.TicketID = @ETicket AND tm.UserID = @UserID;
            IF ISNULL(@TicketID, 0) = 0 SET @TicketID = @ETicket;
            SET @RetChats = 1;
        END

        -- =================================================================
        -- Result sets, as before
        -- =================================================================
        IF @RetChats = 1
            SELECT * FROM CHA.V_TicketChatHistory
            WHERE TicketID = @TicketID AND ChatID > @LastChatID AND (IsAdmin = 0 OR @IsManager = 1)
            ORDER BY ChatID DESC;

        IF @RetTicket IS NOT NULL
            SELECT a.*,
                   (SELECT TOP 1 IsMuted FROM CHA.TicketMembers M WHERE a.TicketID = M.TicketID AND M.UserID = @UserID) AS IsTicketMuted,
                   ISNULL((SELECT TOP 1 UnreadCount FROM cha.TicketMembers x WHERE x.TicketID = a.TicketID AND x.UserID = @UserID), 0) AS UnreadMessages
            FROM CHA.V_TicketHistory a
            WHERE a.TicketID = @RetTicket;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        SET @State = 1;
        SET @Message = LEFT('SQL Exception: ' + ERROR_MESSAGE() + ' (Line: ' + CAST(ERROR_LINE() AS varchar(10)) + ')', 1000);
    END CATCH
END
GO
