USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [dbo].[APISilaWebOperation] -- the Sila web app's general router, called
-- only through SilaApi /api/v2/exec. dbo.APIGeneralOperation stays the
-- mobile app's router and is not touched.
--
-- Differences from APIGeneralOperation 'Left side' (on purpose):
--   * No UserSyncMaster: the mobile app's ForceFullSync flag is left for the
--     mobile app to consume. The web asks for a full list with MaxSeq = 0.
--   * No app-version gate, no SPUserLog / APIUserFirebaseHistory writes:
--     reads stay reads (the gateway logs every call already).
--   * Reads dbo.SilaHistory directly (V_SilaHistory_1 stays as the mobile
--     app's view) and fixes its two label bugs: mail state is looked up by
--     MailState (the view uses TicketState) and task state by TaskID (the
--     view filters TicketID).
--   * Adds what the web list needs: the other person's Username (matches the
--     live channel's presence), photo URL, job and department.
--
-- Gateway contract (SilaApi ParameterBinder): @Operation, @User (filled from
-- the signed-in token, never from the client), @LineData (JSON object),
-- @State INT OUTPUT, @Message OUTPUT.
--
-- Operations
--   Left side        LineData { MaxSeq?: int }  -> the caller's conversations with
--                    SynSequence > MaxSeq (0 / missing = all), newest first.
--   Chat messages    LineData { SessionID, BeforeChatID?: int, AfterChatID?: int, Top?: int (1-200, default 50) }
--                    AfterChatID = client cache delta: only rows newer than it (incl. edit / delete copies).
--                    One-to-one only; the caller must be one of the session's two users.
--                    List0 = the session (other person: username, name, job, photo;
--                    MeUserID), List1 = messages newest first (ChatID < BeforeChatID
--                    when paging back), with the replied-to message's text.
--                    Read-only: opening a chat does NOT mark it read.
--   Mark chat read   LineData { SessionID }  -> deletes the caller's unread rows for
--                    the session (the One.OneToOneUnreadChat delete trigger then
--                    recounts SilaHistory.UnreadMessage, which bumps SynSequence),
--                    and marks ALL those messages seen -- the trigger only marks one
--                    per delete statement. List0 = { Cleared }.
--   Send chat        LineData { SessionID | ToUserID, Text, LocalChatID, ReplayMsgID?, Html? }
--                    Html (also on Edit chat / Send group chat / Edit group chat): formatted
--                    text, stored in TextStyle (Text stays plain); messages return TextStyle.
--                    (SessionID of the caller's conversation, or ToUserID to start one).
--   Edit chat        LineData { ChatID, Text, LocalChatID }   own messages only.
--   Delete chat      LineData { ChatID, LocalChatID }         own messages only.
--                    All three return the saved message in List0 (Chat messages
--                    columns + SessionID); a re-sent LocalChatID returns the same row.
--   Group messages   LineData { GroupID, BeforeChatID?, AfterChatID?, Top? }  members only.
--                    List0 = the group (name, locked, member count, IsAdmin, MeUserID,
--                    photo), List1 = messages with sender name / photo / job, IsSystem.
--   Group members    LineData { GroupID }  members only; admins first (photo, job, IsAdmin, IsCreator).
--   Lock group chat  LineData { GroupID, Locked: 1|0 }  group admins only; posts a system line.
--   Set group admin  LineData { GroupID, UserID, Admin: 1|0 }  group admins only.
--   Add group members   LineData { GroupID, UserIDs: [int] }  group admins only (max 300).
--   Remove group member LineData { GroupID, UserID }  group admins only; not the creator / self.
--   Leave group         LineData { GroupID }  any member; not the last admin while others remain.
--   My day / Save reminder / Reminder done / Delete reminder / My day count
--                    the caller's own reminders (dbo.SilaReminder) -- see the block's comment
--   User profile     LineData { UserID } or { Username }  the profile card: name, photo, job, department,
--                    user group, mobile, local extension, HR employee id (any signed-in user)
--   Find users       LineData { Search?, UserGroupID?, Top? (default 30; max 100, 300 with a group),
--                    All?: 1 (max 2000: every active user, the app's cached people directory) }
--   Settings channel { ChannelID }  one channel for the details drawer: List0 the channel,
--                    List1 members, List2 tickets per state, List3 the 20 newest tickets;
--                    List0 also has the channel's Purpose / Examples / OfferInAssistant
--   Save channel purpose { ChannelID, Purpose, Examples, OfferInAssistant: 1|0 }  user 'mhd'
--                    only: what the channel handles (dbo.SilaChannelPurpose)
--   Settings channel categories {}  CHA.ChannelCategory for the channel form (mhd only)
--   Save channel sla { ChannelID, FirstReplyMinutes, FinishMinutes }  working minutes, 0 = no
--                    target (dbo.SilaChannelSla; mhd only). Settings channel returns both.
--   Save channel     { ChannelID? (0 = new), Name, CategoryID, IsPrivate, InActive, Purpose?, Examples? }
--                    create or edit a channel (mhd only); returns { ChannelID }
--   Add channel members   { ChannelID, Members: [ { UserID, IsAdmin, IsTeamLeader } ] }  (mhd only)
--   Set channel member    { ChannelID, UserID, IsAdmin, IsTeamLeader }  (mhd only)
--   Remove channel member { ChannelID, UserID }  (mhd only). Existing tickets keep their roles.
--   Settings user group { GroupID }  List0 the Sila user group, List1 its users (mhd only)
--   Save user group  { GroupID? (0 = new), GroupName }  create / rename (mhd only); returns { GroupID }
--   Delete user group { GroupID }  only an empty group (mhd only)
--   Set users group  { GroupID, UserIDs: [int] }  move users into the group (mhd only)
--   Settings chat groups {}  group master: chat groups + type (Group / Broadcast); List1 ActiveUsers (mhd only)
--   Settings chat group { GroupID }  List0 the group, List1 its members (mhd only)
--   Save chat group  { GroupID? (0 = new), Name, Broadcast: 1|0, AdminIDs?: [int] (new only) }
--                    Broadcast = every active user is a member, only admins send
--                    (dbo.SilaGroupType, SQLScript/SilaBroadcastGroup.sql; mhd only)
--   Set chat group admin { GroupID, UserID, Admin: 1|0 }  (mhd only)
--   Settings users / Settings user groups / Settings channels   {}  read-only master
--                    lists for the web System Settings screen -- user 'mhd' ONLY
--                    (checked here; the app only hides the button). No password hash.
--                    active users, not the caller; Search also matches the user group name.
--   User groups      user groups with their active user counts (picker filter).
--   Create group     LineData { Name, Members: [ { UserID, IsAdmin } ] }  caller = creator + admin.
--   Send chat file   LineData { SessionID, AttachmentID, LocalChatID, ReplayMsgID? }
--   Send group chat file  LineData { GroupID, AttachmentID, LocalChatID, ReplayMsgID? }
--                    post a file the caller uploaded to that chat / group through the
--                    Files API (:7500, PLS.V1FileUpload): stored, not posted yet.
--   Mark group read  LineData { GroupID }
--   Send group chat  LineData { GroupID, Text, LocalChatID, ReplayMsgID? }
--   Edit group chat / Delete group chat  LineData { ChatID, Text?, LocalChatID }
--                    own non-system messages; locked groups: admins only.
--
-- Permission rows: the MERGE at the end of this script (deployable with
-- deploy.sh together with the procedure).
-- Idempotent: CREATE OR ALTER + MERGE. Deploy with deploy.sh or in SSMS.
-- =========================================================================
CREATE OR ALTER PROCEDURE [dbo].[APISilaWebOperation]
    @Operation NVARCHAR(100),
    @User      NVARCHAR(250),
    @LineData  NVARCHAR(MAX) = N'',
    @State     INT           = 0  OUTPUT,
    @Message   NVARCHAR(500) = N'' OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET @State = 0;
    SET @Message = N'';

    BEGIN TRY
        IF ISJSON(@LineData) <> 1 SET @LineData = N'{}';

        DECLARE @UserID INT, @Inactive INT;
        SELECT @UserID = UserID, @Inactive = IsNotActive FROM dbo.UserMaster WHERE Username = @User;
        IF @UserID IS NULL OR ISNULL(@Inactive, 1) <> 0
        BEGIN
            SET @State = 9;
            SET @Message = N'User is not active.';
            RETURN;
        END

        -- Formatted text (the composer's rich mode): LineData.Html is stored in
        -- TextStyle -- the column the mobile app's editor already fills with HTML --
        -- while Text keeps the plain text for previews, search and notifications.
        -- The web app sanitizes it before sending and again when showing it.
        DECLARE @WHtml NVARCHAR(MAX);
        SELECT @WHtml = NULLIF(LTRIM(RTRIM(Html)), N'') FROM OPENJSON(@LineData) WITH (Html NVARCHAR(MAX) '$.Html');
        IF @Operation LIKE N'Delete%' SET @WHtml = NULL;
        IF LEN(@WHtml) > 30000
        BEGIN SET @State = 1; SET @Message = N'The formatted message is too long.'; RETURN; END

        -- -----------------------------------------------------------------
        -- Left side
        -- -----------------------------------------------------------------
        IF @Operation = N'Left side'
        BEGIN
            DECLARE @MaxSeq INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.MaxSeq') AS INT), 0);
            -- broadcast groups (dbo.SilaGroupType): the caller joins any he is not in yet;
            -- never blocks the Home list
            IF EXISTS (SELECT 1 FROM dbo.SilaGroupType)
                BEGIN TRY EXEC dbo.SilaSyncBroadcastGroup @UserID = @UserID; END TRY BEGIN CATCH END CATCH

            SELECT
                a.SilaID,
                RTRIM(a.RecordType) AS RecordType,
                CASE RTRIM(a.RecordType)
                    WHEN 'O' THEN 'chat' WHEN 'G' THEN 'group' WHEN 'C' THEN 'ticket'
                    WHEN 'M' THEN 'mail' WHEN 'K' THEN 'task' ELSE 'other' END AS Kind,
                a.SynSequence, a.LastMaintDate, a.LastChatID, a.UnreadMessage, a.LastMessage,
                CASE WHEN EXISTS (SELECT 1 FROM dbo.SilaHideHistory h WHERE h.SilaID = a.SilaID AND h.UserID = a.UserID)
                     THEN 1 ELSE 0 END AS IsHidden,
                -- one-to-one: the other person
                a.SessionID, a.OtherUserID AS FromUserID, ou.Username AS FromUsername, ou.FullName AS FromName,
                oj.JobName AS FromJobName, oj.DepartmentName AS FromDepartmentName, op.FileURL AS FromPhotoURL,
                -- group
                a.GroupID, gm.Name AS GroupName,
                CASE WHEN bt.GroupID IS NULL THEN 0 ELSE 1 END AS IsBroadcast,   -- dbo.SilaGroupType
                -- ticket
                a.TicketID, a.ChannelID, cm.Name AS ChannelName, a.TicketSubject, a.TicketState,
                ts.StateDescription AS TicketStateDescription, tc.FullName AS TicketCreatedBy,
                CASE WHEN tf.TicketID IS NULL THEN 0 ELSE 1 END AS MyFlagged, tf.DueDate AS MyFlagDue, tf.Note AS MyFlagNote,
                ta.UserID AS AssignedUserID, au.Username AS AssignedUsername, ISNULL(NULLIF(au.FullName, N''), au.Username) AS AssignedName,
                sla.FirstReplyDate, sla.ReplyMinutes, sla.ReplyTarget, sla.ReplyState,
                sla.FinishMinutes AS FinishWorkMinutes, sla.FinishTarget, sla.FinishState,
                -- mail
                a.MailID, a.MailSubject, a.MailState, ms.StateDescription AS MailStateDescription,
                mc.FullName AS MailCreatedBy,
                -- task
                a.TaskID, a.TaskSubject, a.TaskState, ks.StateDescription AS TaskStateDescription
            FROM dbo.SilaHistory a
            LEFT JOIN dbo.UserMaster ou           ON ou.UserID = a.OtherUserID AND RTRIM(a.RecordType) = 'O'
            LEFT JOIN dbo.V_SilaUserTitle oj        ON oj.UserID = ou.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = ou.AttachmentID AND ou.AttachmentID <> 0 ORDER BY x.ID DESC) op
            LEFT JOIN grp.GroupMaster gm          ON gm.GroupID = a.GroupID AND RTRIM(a.RecordType) = 'G'
            LEFT JOIN dbo.SilaGroupType bt        ON bt.GroupID = gm.GroupID
            LEFT JOIN cha.ChannelMaster cm        ON cm.ChannelID = a.ChannelID AND RTRIM(a.RecordType) = 'C'
            LEFT JOIN cha.TicketState ts          ON ts.StateID = a.TicketState AND RTRIM(a.RecordType) = 'C'
            LEFT JOIN dbo.SilaTicketFlag tf       ON tf.TicketID = a.TicketID AND tf.UserID = a.UserID AND RTRIM(a.RecordType) = 'C'
            LEFT JOIN dbo.SilaTicketAssignment ta ON ta.TicketID = a.TicketID AND RTRIM(a.RecordType) = 'C'
            LEFT JOIN dbo.UserMaster au           ON au.UserID = ta.UserID
            OUTER APPLY (SELECT x.* FROM dbo.fnSilaTicketSla(a.TicketID) x WHERE RTRIM(a.RecordType) = 'C') sla
            OUTER APPLY (SELECT TOP (1) u.FullName FROM cha.TicketHistory x
                         LEFT JOIN dbo.UserMaster u ON u.Username = x.CreatedByUser
                         WHERE RTRIM(a.RecordType) = 'C' AND x.TicketID = a.TicketID) tc
            LEFT JOIN MAIL.MailState ms           ON ms.StateID = a.MailState AND RTRIM(a.RecordType) = 'M'
            OUTER APPLY (SELECT TOP (1) u.FullName FROM MAIL.MailHistory x
                         LEFT JOIN dbo.UserMaster u ON u.Username = x.CreatedByUser
                         WHERE RTRIM(a.RecordType) = 'M' AND x.MailID = a.MailID) mc
            LEFT JOIN Task.TaskState ks           ON ks.StateID = a.TaskState AND RTRIM(a.RecordType) = 'K'
            WHERE a.UserID = @UserID AND a.SynSequence > @MaxSeq
            ORDER BY a.LastMaintDate DESC;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- One-to-one: the session, after checking the caller is in it
        -- -----------------------------------------------------------------
        DECLARE @SessionID INT, @OtherUserID INT;
        IF @Operation IN (N'Chat messages', N'Mark chat read')
        BEGIN
            SET @SessionID = TRY_CAST(JSON_VALUE(@LineData, '$.SessionID') AS INT);
            SELECT @OtherUserID = CASE WHEN s.UserID1 = @UserID THEN s.UserID2 ELSE s.UserID1 END
            FROM One.OneChatSession s
            WHERE s.SessionID = @SessionID AND (s.UserID1 = @UserID OR s.UserID2 = @UserID);
            IF @OtherUserID IS NULL
            BEGIN
                SET @State = 403;
                SET @Message = N'Conversation not found.';
                RETURN;
            END
        END

        -- -----------------------------------------------------------------
        -- Chat messages (read-only, paged newest first)
        -- -----------------------------------------------------------------
        IF @Operation = N'Chat messages'
        BEGIN
            DECLARE @Before INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.BeforeChatID') AS INT), 0);
            -- AfterChatID (client cache delta): only rows with ChatID > AfterChatID -- new messages and
            -- edit / delete copies (new rows); the client swaps each copy for its OrginalChatID.
            DECLARE @After INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.AfterChatID') AS INT), 0);
            DECLARE @Top INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 50);
            IF @Top < 1 SET @Top = 1;
            IF @Top > 200 SET @Top = 200;

            SELECT @SessionID AS SessionID, @UserID AS MeUserID,
                   ou.UserID AS OtherUserID, ou.Username AS OtherUsername, ou.FullName AS OtherName,
                   oj.JobName AS OtherJobName, oj.DepartmentName AS OtherDepartmentName, op.FileURL AS OtherPhotoURL
            FROM dbo.UserMaster ou
            LEFT JOIN dbo.V_SilaUserTitle oj        ON oj.UserID = ou.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = ou.AttachmentID AND ou.AttachmentID <> 0 ORDER BY x.ID DESC) op
            WHERE ou.UserID = @OtherUserID;

            -- SortID: an edit / delete copy sorts at its original's place (one level:
            -- a copy of a copy sorts at the previous copy -- close enough). Paging
            -- (BeforeChatID) is by SortID.
            SELECT TOP (@Top)
                   CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END AS SortID,
                   m.ChatID, m.FromUserID, m.ToUserID, m.Text, m.TextStyle, m.ReplayMsgID,
                   m.IsDeleted, m.IsEdited, m.OrginalChatID, m.CreatedDate, m.LastMaintDate,
                   m.IsSeen, m.SeenDate, m.LocalChatID,
                   m.AttachmentID, m.FileName, m.FileOrginalName, m.FileExtension, m.FileSize, m.FileURL,
                   r.Text AS ReplyText, r.FromUserID AS ReplyFromUserID
            FROM One.V_ChatHistory_1 m
            -- Edit / Delete add a new row pointing at the old one (OrginalChatID): show only the
            -- latest version of each message. The session's OrginalChatIDs are collected once
            -- (same as groups, where a correlated NOT EXISTS was 100x slower).
            LEFT JOIN (SELECT DISTINCT n.OrginalChatID FROM One.OneToOneChatHistory n
                       WHERE n.SessionID = @SessionID AND n.OrginalChatID > 0) sup ON sup.OrginalChatID = m.ChatID
            LEFT JOIN One.OneToOneChatHistory r ON r.ChatID = m.ReplayMsgID AND m.ReplayMsgID <> 0 AND r.SessionID = m.SessionID
            -- delta mode keeps superseded copies too, so a chain A -> B -> C replays in order on the client
            WHERE m.SessionID = @SessionID AND (sup.OrginalChatID IS NULL OR @After > 0)
              AND (@Before = 0 OR CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END < @Before)
              AND (@After = 0 OR m.ChatID > @After)
            ORDER BY SortID DESC, m.ChatID DESC;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Mark chat read
        -- -----------------------------------------------------------------
        IF @Operation = N'Mark chat read'
        BEGIN
            DECLARE @Cleared INT = 0;
            BEGIN TRANSACTION;
            UPDATE h SET h.IsSeen = 1, h.SeenDate = GETDATE()
            FROM One.OneToOneChatHistory h
            WHERE h.SessionID = @SessionID AND h.ToUserID = @UserID AND ISNULL(h.IsSeen, 0) = 0
              AND h.ChatID IN (SELECT u.ChatID FROM One.OneToOneUnreadChat u
                               WHERE u.SessionID = @SessionID AND u.UserID = @UserID);
            DELETE FROM One.OneToOneUnreadChat WHERE SessionID = @SessionID AND UserID = @UserID;
            SET @Cleared = @@ROWCOUNT;
            COMMIT TRANSACTION;
            SELECT @Cleared AS Cleared;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Send chat / Edit chat / Delete chat (one-to-one). Same storage as the
        -- mobile app (dbo.APIGeneralOperation 'New Chat' / 'Edit Chat' /
        -- 'Delete Chat'): ChatID from dbo.ChatOneToOne, an edit or delete adds
        -- a new row pointing at the old one (OrginalChatID), and the
        -- One.OneToOneChatHistory insert trigger keeps unread rows, SilaHistory
        -- and the session's last message. Differences: only your OWN messages
        -- can be edited / deleted, and the unread row the trigger adds for an
        -- edit / delete copy is removed (no "new message" for a correction).
        -- Each returns the saved message (same columns as Chat messages).
        -- -----------------------------------------------------------------
        DECLARE @RetChatID INT = NULL;

        IF @Operation = N'Send chat'
        BEGIN
            DECLARE @SText NVARCHAR(MAX), @SLocal INT, @SReply INT, @SSession INT, @SToUser INT, @SToName NVARCHAR(250);
            SELECT @SText = [Text], @SLocal = LocalChatID, @SReply = ReplayMsgID, @SSession = SessionID, @SToUser = ToUserID
            FROM OPENJSON(@LineData) WITH ([Text] NVARCHAR(MAX) '$.Text', LocalChatID INT '$.LocalChatID',
                 ReplayMsgID INT '$.ReplayMsgID', SessionID INT '$.SessionID', ToUserID INT '$.ToUserID');
            SET @SText = LTRIM(RTRIM(ISNULL(@SText, N'')));
            IF @SText = N'' BEGIN SET @State = 1; SET @Message = N'Write a message first.'; RETURN; END
            IF LEN(@SText) > 10000 BEGIN SET @State = 1; SET @Message = N'The message is too long.'; RETURN; END
            IF ISNULL(@SLocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END

            -- the conversation: an existing session of the caller, or the pair with ToUserID
            IF ISNULL(@SSession, 0) <> 0
            BEGIN
                -- never fall back to a client-sent ToUserID: not a member = no recipient = 403
                SET @SToUser = NULL;
                SELECT @SToUser = CASE WHEN s.UserID1 = @UserID THEN s.UserID2 ELSE s.UserID1 END
                FROM One.OneChatSession s
                WHERE s.SessionID = @SSession AND (s.UserID1 = @UserID OR s.UserID2 = @UserID);
            END
            ELSE
                SELECT TOP (1) @SSession = s.SessionID
                FROM One.OneChatSession s
                WHERE (s.UserID1 = @UserID AND s.UserID2 = @SToUser) OR (s.UserID2 = @UserID AND s.UserID1 = @SToUser)
                ORDER BY s.SessionID;
            SELECT @SToName = Username FROM dbo.UserMaster WHERE UserID = @SToUser AND IsNotActive = 0;
            IF @SToName IS NULL BEGIN SET @State = 403; SET @Message = N'Conversation not found.'; RETURN; END

            -- a reply must point into the same conversation
            IF ISNULL(@SReply, 0) <> 0 AND NOT EXISTS (SELECT 1 FROM One.OneToOneChatHistory
                                                      WHERE ChatID = @SReply AND SessionID = @SSession)
                SET @SReply = 0;

            -- a re-sent request (same LocalChatID) returns the saved message
            SELECT @RetChatID = ChatID FROM One.OneToOneChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @SLocal AND SessionID = @SSession;

            IF @RetChatID IS NULL
            BEGIN
                BEGIN TRANSACTION;
                IF ISNULL(@SSession, 0) = 0
                BEGIN
                    INSERT INTO One.OneChatSession (UserID1, UserID2, UserName1, UserName2, CreatedBy)
                    VALUES (@UserID, @SToUser, @User, @SToName, @User);
                    SET @SSession = SCOPE_IDENTITY();
                END
                SET @RetChatID = NEXT VALUE FOR dbo.ChatOneToOne;
                INSERT INTO One.OneToOneChatHistory
                    (ChatID, SessionID, FromUserID, FromUserName, ToUserID, ToUserName, Text, ReplayMsgID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, TextStyle, LocalChatID, OrginalChatID)
                VALUES
                    (@RetChatID, @SSession, @UserID, @User, @SToUser, @SToName, @SText, ISNULL(@SReply, 0),
                     @User, GETDATE(), @User, GETDATE(),
                     ISNULL(@WHtml, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@SText, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'),
                             NCHAR(13) + NCHAR(10), N'<br>'), NCHAR(10), N'<br>')),
                     @SLocal, 0);
                COMMIT TRANSACTION;
            END
        END

        -- -----------------------------------------------------------------
        -- Send chat file: post a file uploaded through the Files API
        -- LineData { SessionID, AttachmentID, LocalChatID, ReplayMsgID? }
        -- -----------------------------------------------------------------
        IF @Operation = N'Send chat file'
        BEGIN
            DECLARE @FSession INT, @FAtt INT, @FLocal INT, @FReply INT, @FTo INT, @FToName NVARCHAR(250);
            SELECT @FSession = SessionID, @FAtt = AttachmentID, @FLocal = LocalChatID, @FReply = ReplayMsgID
            FROM OPENJSON(@LineData) WITH (SessionID INT '$.SessionID', AttachmentID INT '$.AttachmentID',
                 LocalChatID INT '$.LocalChatID', ReplayMsgID INT '$.ReplayMsgID');
            SELECT @FTo = CASE WHEN s.UserID1 = @UserID THEN s.UserID2 ELSE s.UserID1 END
            FROM One.OneChatSession s
            WHERE s.SessionID = @FSession AND (s.UserID1 = @UserID OR s.UserID2 = @UserID);
            SELECT @FToName = Username FROM dbo.UserMaster WHERE UserID = @FTo AND IsNotActive = 0;
            IF @FToName IS NULL BEGIN SET @State = 403; SET @Message = N'Conversation not found.'; RETURN; END
            IF ISNULL(@FLocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END

            -- a re-sent request returns the saved message
            SELECT @RetChatID = ChatID FROM One.OneToOneChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @FLocal AND SessionID = @FSession;
            IF @RetChatID IS NULL
            BEGIN
            -- a file the caller uploaded through the Files API (:7500) to THIS conversation,
            -- stored, not deleted, and not posted yet (PLS.V1FileUpload, SQLScript/APIPlusAttachmentOperation.sql)
                IF NOT EXISTS (SELECT 1 FROM [PLS].[V1FileUpload] f
                               WHERE f.AttachmentID = @FAtt AND f.EntityType = 'Chat' AND f.EntityKey = @FSession
                                 AND f.CreatedBy = @User AND f.IsExist = 1 AND f.IsDeleted = 0)
                   OR EXISTS (SELECT 1 FROM One.OneToOneChatHistory WHERE AttachmentID = @FAtt)
                BEGIN SET @State = 409; SET @Message = N'That file can''t be sent here. Upload it again.'; RETURN; END
                IF ISNULL(@FReply, 0) <> 0 AND NOT EXISTS (SELECT 1 FROM One.OneToOneChatHistory WHERE ChatID = @FReply AND SessionID = @FSession)
                    SET @FReply = 0;
                SET @RetChatID = NEXT VALUE FOR dbo.ChatOneToOne;
                INSERT INTO One.OneToOneChatHistory
                    (ChatID, SessionID, FromUserID, FromUserName, ToUserID, ToUserName, Text, ReplayMsgID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, TextStyle, LocalChatID, OrginalChatID, AttachmentID)
                VALUES (@RetChatID, @FSession, @UserID, @User, @FTo, @FToName, N'', ISNULL(@FReply, 0),
                        @User, GETDATE(), @User, GETDATE(), N'', @FLocal, 0, @FAtt);
            END
        END

        IF @Operation IN (N'Edit chat', N'Delete chat')
        BEGIN
            DECLARE @EChat INT, @EText NVARCHAR(MAX), @ELocal INT, @EFrom INT, @ESession INT, @EDeleted INT;
            SELECT @EChat = ChatID, @EText = [Text], @ELocal = LocalChatID
            FROM OPENJSON(@LineData) WITH (ChatID INT '$.ChatID', [Text] NVARCHAR(MAX) '$.Text', LocalChatID INT '$.LocalChatID');
            SELECT @EFrom = FromUserID, @ESession = SessionID, @EDeleted = ISNULL(IsDeleted, 0)
            FROM One.OneToOneChatHistory WHERE ChatID = @EChat;

            IF @EFrom IS NULL OR @EFrom <> @UserID
            BEGIN SET @State = 403; SET @Message = N'You can only change your own messages.'; RETURN; END
            IF @EDeleted <> 0 OR EXISTS (SELECT 1 FROM One.OneToOneChatHistory WHERE SessionID = @ESession AND OrginalChatID = @EChat)
            BEGIN SET @State = 1; SET @Message = N'This message was already changed. Reload the conversation.'; RETURN; END
            IF ISNULL(@ELocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END

            IF @Operation = N'Edit chat'
            BEGIN
                SET @EText = LTRIM(RTRIM(ISNULL(@EText, N'')));
                IF @EText = N'' BEGIN SET @State = 1; SET @Message = N'Write a message first.'; RETURN; END
                IF LEN(@EText) > 10000 BEGIN SET @State = 1; SET @Message = N'The message is too long.'; RETURN; END
            END
            ELSE
                SET @EText = N'Text Is Deleted ********';   -- the mobile app's placeholder

            -- a re-sent request returns the saved copy
            SELECT @RetChatID = ChatID FROM One.OneToOneChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @ELocal AND OrginalChatID = @EChat;

            IF @RetChatID IS NULL
            BEGIN
                DECLARE @IsDel BIT = CASE WHEN @Operation = N'Delete chat' THEN 1 ELSE 0 END;
                BEGIN TRANSACTION;
                UPDATE One.OneToOneChatHistory
                SET LastMaintBy = @User, LastMaintDate = GETDATE(), IsSeen = 1,
                    IsEdited = CASE WHEN @IsDel = 0 THEN 1 ELSE IsEdited END,
                    IsDeleted = CASE WHEN @IsDel = 1 THEN 1 ELSE IsDeleted END
                WHERE ChatID = @EChat;
                DELETE FROM One.OneToOneUnreadChat WHERE ChatID = @EChat;

                SET @RetChatID = NEXT VALUE FOR dbo.ChatOneToOne;
                INSERT INTO One.OneToOneChatHistory
                    (ChatID, SessionID, FromUserID, ToUserID, FromUserName, ToUserName, Text, TextStyle, ReplayMsgID,
                     CreatedDate, AttachmentID, LocalChatID, OrginalChatID, IsEdited, IsDeleted, CreatedBy, LastMaintBy, LastMaintDate)
                SELECT @RetChatID, SessionID, FromUserID, ToUserID, FromUserName, ToUserName, @EText,
                       ISNULL(@WHtml, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@EText, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'),
                               NCHAR(13) + NCHAR(10), N'<br>'), NCHAR(10), N'<br>')),
                       ReplayMsgID, GETDATE(), CASE WHEN @IsDel = 1 THEN 0 ELSE AttachmentID END,
                       @ELocal, @EChat, 0, @IsDel, @User, @User, GETDATE()
                FROM One.OneToOneChatHistory WHERE ChatID = @EChat;

                -- the insert trigger counted the copy as a new unread message: undo that
                DELETE FROM One.OneToOneUnreadChat WHERE ChatID = @RetChatID;
                COMMIT TRANSACTION;
            END
        END

        IF @RetChatID IS NOT NULL
        BEGIN
            SELECT m.SessionID, CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END AS SortID,
                   m.ChatID, m.FromUserID, m.ToUserID, m.Text, m.TextStyle, m.ReplayMsgID,
                   m.IsDeleted, m.IsEdited, m.OrginalChatID, m.CreatedDate, m.LastMaintDate,
                   m.IsSeen, m.SeenDate, m.LocalChatID,
                   m.AttachmentID, m.FileName, m.FileOrginalName, m.FileExtension, m.FileSize, m.FileURL,
                   r.Text AS ReplyText, r.FromUserID AS ReplyFromUserID
            FROM One.V_ChatHistory_1 m
            LEFT JOIN One.OneToOneChatHistory r ON r.ChatID = m.ReplayMsgID AND m.ReplayMsgID <> 0 AND r.SessionID = m.SessionID
            WHERE m.ChatID = @RetChatID;
            RETURN;
        END

        -- =================================================================
        -- GROUPS. Same storage as the mobile app (GRP.APIGroupChatOperation):
        -- ChatID from dbo.ChatGroup; an edit / delete adds a new row pointing
        -- at the old one. GRP.TrgGroupChatHistoryafterInsertUpdate fires on
        -- INSERT *and* UPDATE: it adds unread rows for every member except the
        -- sender, refreshes GroupMaster / SilaHistory, so after flagging the
        -- original and inserting the copy, the unread rows it created for both
        -- are removed (GRP.TrgGroupUnreadChatafterDelete then recounts).
        -- Rules: members only; a locked group (ChatIsLocked) takes messages
        -- from its admins only; edit / delete your own, non-system messages.
        -- =================================================================
        DECLARE @GroupID INT, @GIsAdmin INT, @GLocked INT, @GRet INT = NULL;
        IF @Operation IN (N'Group messages', N'Mark group read', N'Send group chat', N'Send group chat file', N'Group members', N'Lock group chat', N'Set group admin',
                          N'Add group members', N'Remove group member', N'Leave group')
        BEGIN
            SET @GroupID = TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT);
            SELECT @GIsAdmin = ISNULL(gm.IsAdmin, 0) FROM GRP.GroupMembers gm WHERE gm.GroupID = @GroupID AND gm.UserID = @UserID;
            IF @GIsAdmin IS NULL
            BEGIN
                SET @State = 403;
                SET @Message = N'Group not found.';
                RETURN;
            END
            SELECT @GLocked = ISNULL(ChatIsLocked, 0) FROM GRP.GroupMaster WHERE GroupID = @GroupID;
            -- a broadcast group: every active user is in it, only its admins send
            DECLARE @GBroadcast BIT = CASE WHEN EXISTS (SELECT 1 FROM dbo.SilaGroupType WHERE GroupID = @GroupID AND GroupType = 'Broadcast')
                                           THEN 1 ELSE 0 END;
            IF @GBroadcast = 1 SET @GLocked = 1;
            IF @GBroadcast = 1 AND @Operation IN (N'Add group members', N'Remove group member', N'Leave group')
            BEGIN SET @State = 1; SET @Message = N'Everyone is in a broadcast group: people can''t be added, removed or leave.'; RETURN; END
            IF @GBroadcast = 1 AND @Operation = N'Lock group chat' AND ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Locked') AS INT), 0) <> 1
            BEGIN SET @State = 1; SET @Message = N'A broadcast group stays locked: only its admins send.'; RETURN; END
            -- before an admin sends: everyone active is in, so the message reaches them all
            IF @GBroadcast = 1 AND @GIsAdmin = 1 AND @Operation IN (N'Send group chat', N'Send group chat file')
                EXEC dbo.SilaSyncBroadcastGroup @GroupID = @GroupID;
        END

        -- -----------------------------------------------------------------
        -- Group messages (read-only, paged newest first, SortID like one-to-one)
        -- -----------------------------------------------------------------
        IF @Operation = N'Group messages'
        BEGIN
            DECLARE @GBefore INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.BeforeChatID') AS INT), 0);
            DECLARE @GAfter INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.AfterChatID') AS INT), 0);   -- cache delta, as Chat messages
            DECLARE @GTop INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 50);
            IF @GTop < 1 SET @GTop = 1;
            IF @GTop > 200 SET @GTop = 200;

            SELECT g.GroupID, g.Name AS GroupName, ISNULL(g.ChatIsLocked, 0) AS ChatIsLocked, @UserID AS MeUserID,
                   @GIsAdmin AS IsAdmin, (SELECT COUNT(*) FROM GRP.GroupMembers x WHERE x.GroupID = g.GroupID) AS MemberCount,
                   gp.FileURL AS GroupPhotoURL, CAST(@GBroadcast AS INT) AS IsBroadcast
            FROM GRP.GroupMaster g
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = g.AttachmentID AND g.AttachmentID <> 0 ORDER BY x.ID DESC) gp
            WHERE g.GroupID = @GroupID;

            SELECT TOP (@GTop)
                   CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END AS SortID,
                   m.ChatID, m.FromUserID, fu.Username AS FromUsername, ISNULL(fu.FullName, m.FromUserName) AS FromName,
                   fj.JobName AS FromJobName, fp.FileURL AS FromPhotoURL,
                   m.Text, m.TextStyle, m.ReplayMsgID, ISNULL(m.IsSystem, 0) AS IsSystem,
                   m.IsDeleted, m.IsEdited, m.OrginalChatID, m.CreatedDate, m.LastMaintDate, m.LocalChatID,
                   m.AttachmentID, t.FileName, t.FileOrginalName, t.FileExtension, t.FileSize, t.FileURL,
                   r.Text AS ReplyText, r.FromUserID AS ReplyFromUserID, ISNULL(ru.FullName, r.FromUserName) AS ReplyFromName
            FROM GRP.GroupChatHistory m
            -- replaced versions: the group's OrginalChatIDs, collected once (a correlated
            -- NOT EXISTS re-read the group per message: 1.75 s on a 1,600-message group, this 16 ms)
            LEFT JOIN (SELECT DISTINCT n.OrginalChatID FROM GRP.GroupChatHistory n
                       WHERE n.GroupID = @GroupID AND n.OrginalChatID > 0) sup ON sup.OrginalChatID = m.ChatID
            LEFT JOIN dbo.AttachmentHistory t  ON t.AttachmentID = m.AttachmentID AND m.AttachmentID <> 0
            LEFT JOIN dbo.UserMaster fu        ON fu.UserID = m.FromUserID
            LEFT JOIN dbo.V_SilaUserTitle fj     ON fj.UserID = fu.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = fu.AttachmentID AND fu.AttachmentID <> 0 ORDER BY x.ID DESC) fp
            -- TOP 1: the old mobile 'Delete Chat' took ChatIDs from the one-to-one sequence, so a group ChatID may repeat
            OUTER APPLY (SELECT TOP (1) x.Text, x.FromUserID, x.FromUserName FROM GRP.GroupChatHistory x
                         WHERE x.ChatID = m.ReplayMsgID AND m.ReplayMsgID <> 0 AND x.GroupID = m.GroupID ORDER BY x.ID DESC) r
            LEFT JOIN dbo.UserMaster ru        ON ru.UserID = r.FromUserID
            WHERE m.GroupID = @GroupID AND (sup.OrginalChatID IS NULL OR @GAfter > 0)
              AND (@GBefore = 0 OR CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END < @GBefore)
              AND (@GAfter = 0 OR m.ChatID > @GAfter)
            ORDER BY SortID DESC, m.ChatID DESC;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Group members (read-only; the group details panel). Admins first.
        -- List0 = members; List1 = the group's creator (GroupMaster.CreatedBy /
        -- CreatedDate -- set for every group, unlike GroupMembers.IsCreated).
        -- A member is the creator when IsCreated = 1 or he is CreatedBy.
        -- -----------------------------------------------------------------
        IF @Operation = N'Group members'
        BEGIN
            DECLARE @GCreatedBy NVARCHAR(50), @GCreatedDate DATETIME;
            SELECT @GCreatedBy = CreatedBy, @GCreatedDate = CreatedDate FROM GRP.GroupMaster WHERE GroupID = @GroupID;

            SELECT gm.UserID, u.Username, u.FullName, j.JobName, j.DepartmentName, p.FileURL AS PhotoURL,
                   ISNULL(gm.IsAdmin, 0) AS IsAdmin,
                   CASE WHEN ISNULL(gm.IsCreated, 0) = 1 OR u.Username = @GCreatedBy THEN 1 ELSE 0 END AS IsCreator,
                   gm.CreatedDate AS JoinedDate,
                   CASE WHEN gm.UserID = @UserID THEN 1 ELSE 0 END AS IsMe
            FROM GRP.GroupMembers gm
            JOIN dbo.UserMaster u                ON u.UserID = gm.UserID
            LEFT JOIN dbo.V_SilaUserTitle j        ON j.UserID = u.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
            WHERE gm.GroupID = @GroupID
            ORDER BY ISNULL(gm.IsAdmin, 0) DESC,
                     CASE WHEN ISNULL(gm.IsCreated, 0) = 1 OR u.Username = @GCreatedBy THEN 1 ELSE 0 END DESC, u.FullName;

            -- the creator, member or not (he may have left the group)
            SELECT @GCreatedBy AS CreatedByUsername, cu.FullName AS CreatedByName, @GCreatedDate AS CreatedDate,
                   cp.FileURL AS CreatedByPhotoURL,
                   CASE WHEN EXISTS (SELECT 1 FROM GRP.GroupMembers x WHERE x.GroupID = @GroupID AND x.UserID = cu.UserID)
                        THEN 1 ELSE 0 END AS CreatorIsMember
            FROM (SELECT 1 AS one) z
            LEFT JOIN dbo.UserMaster cu ON cu.Username = @GCreatedBy
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = cu.AttachmentID AND cu.AttachmentID <> 0 ORDER BY x.ID DESC) cp;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Lock group chat (admins only). Same flag as the mobile app's
        -- Lock / UNLock (GroupMaster.ChatIsLocked), which checked nobody.
        -- Posts a system line so members see why they can't send; the line is
        -- not an unread message (its unread rows are removed).
        -- -----------------------------------------------------------------
        IF @Operation = N'Lock group chat'
        BEGIN
            IF @GIsAdmin = 0
            BEGIN SET @State = 403; SET @Message = N'Only group admins can lock or unlock the chat.'; RETURN; END
            DECLARE @GLockTo INT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Locked') AS INT) = 1 THEN 1 ELSE 0 END;
            DECLARE @GSysID INT = NULL;
            IF @GLockTo <> ISNULL(@GLocked, 0)
            BEGIN
                DECLARE @GFull NVARCHAR(MAX) = (SELECT FullName FROM dbo.UserMaster WHERE UserID = @UserID);
                DECLARE @GSysText NVARCHAR(MAX) = N'@' + ISNULL(@GFull, @User)
                    + CASE WHEN @GLockTo = 1 THEN N' locked the chat: only admins can send messages'
                           ELSE N' unlocked the chat: everyone can send messages' END;
                BEGIN TRANSACTION;
                UPDATE GRP.GroupMaster SET ChatIsLocked = @GLockTo, LastMaintBy = @User, LastMaintDate = GETDATE()
                WHERE GroupID = @GroupID;
                SET @GSysID = NEXT VALUE FOR dbo.ChatGroup;
                INSERT INTO GRP.GroupChatHistory
                    (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                VALUES (@GSysID, @GroupID, @UserID, @User, @GSysText, @GSysText, 0, 0,
                        @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1);
                DELETE FROM GRP.GroupUnreadChat WHERE ChatID = @GSysID AND GroupID = @GroupID;
                COMMIT TRANSACTION;
            END
            SELECT @GroupID AS GroupID, @GLockTo AS ChatIsLocked, @GSysID AS SystemChatID,
                   (SELECT Text FROM GRP.GroupChatHistory WHERE ChatID = @GSysID AND GroupID = @GroupID) AS SystemText;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Set group admin (admins only): make a member an admin / dismiss.
        -- The mobile app's 'add admin' checked nobody. Rules: the target must
        -- be a member; the creator (IsCreated or GroupMaster.CreatedBy) can
        -- only step down himself; a group keeps at least one admin. Posts a
        -- system line (not an unread message).
        -- -----------------------------------------------------------------
        IF @Operation = N'Set group admin'
        BEGIN
            IF @GIsAdmin = 0
            BEGIN SET @State = 403; SET @Message = N'Only group admins can add or remove admins.'; RETURN; END
            DECLARE @GATarget INT = TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT);
            DECLARE @GAMake INT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Admin') AS INT) = 1 THEN 1 ELSE 0 END;
            DECLARE @GAIsAdmin INT, @GAIsCreator INT, @GAName NVARCHAR(MAX), @GASysID INT = NULL;
            SELECT @GAIsAdmin = ISNULL(gm.IsAdmin, 0), @GAName = ISNULL(u.FullName, u.Username),
                   @GAIsCreator = CASE WHEN ISNULL(gm.IsCreated, 0) = 1 OR u.Username = g.CreatedBy THEN 1 ELSE 0 END
            FROM GRP.GroupMembers gm
            JOIN dbo.UserMaster u ON u.UserID = gm.UserID
            JOIN GRP.GroupMaster g ON g.GroupID = gm.GroupID
            WHERE gm.GroupID = @GroupID AND gm.UserID = @GATarget;
            IF @GAIsAdmin IS NULL
            BEGIN SET @State = 1; SET @Message = N'That person is not a member of this group.'; RETURN; END
            IF @GAMake = 0 AND @GAIsAdmin = 1
            BEGIN
                IF @GAIsCreator = 1 AND @GATarget <> @UserID
                BEGIN SET @State = 403; SET @Message = N'The group creator can''t be dismissed as admin.'; RETURN; END
                IF (SELECT COUNT(*) FROM GRP.GroupMembers WHERE GroupID = @GroupID AND ISNULL(IsAdmin, 0) = 1) <= 1
                BEGIN SET @State = 1; SET @Message = N'A group needs at least one admin.'; RETURN; END
            END

            IF @GAIsAdmin <> @GAMake
            BEGIN
                DECLARE @GAFull NVARCHAR(MAX) = (SELECT FullName FROM dbo.UserMaster WHERE UserID = @UserID);
                DECLARE @GASysText NVARCHAR(MAX) = CASE
                    WHEN @GATarget = @UserID AND @GAMake = 0 THEN N'@' + ISNULL(@GAFull, @User) + N' is no longer an admin'
                    WHEN @GAMake = 1 THEN N'@' + ISNULL(@GAFull, @User) + N' made @' + @GAName + N' an admin'
                    ELSE N'@' + ISNULL(@GAFull, @User) + N' dismissed @' + @GAName + N' as admin' END;
                BEGIN TRANSACTION;
                UPDATE GRP.GroupMembers SET IsAdmin = @GAMake WHERE GroupID = @GroupID AND UserID = @GATarget;
                SET @GASysID = NEXT VALUE FOR dbo.ChatGroup;
                INSERT INTO GRP.GroupChatHistory
                    (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                VALUES (@GASysID, @GroupID, @UserID, @User, @GASysText, @GASysText, 0, 0,
                        @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1);
                DELETE FROM GRP.GroupUnreadChat WHERE ChatID = @GASysID AND GroupID = @GroupID;
                COMMIT TRANSACTION;
            END
            SELECT @GATarget AS UserID, @GAMake AS IsAdmin, @GASysID AS SystemChatID,
                   (SELECT Text FROM GRP.GroupChatHistory WHERE ChatID = @GASysID AND GroupID = @GroupID) AS SystemText;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Group membership. Admins add members (active users, not yet in) and
        -- remove them (not the creator, not themselves -- that is Leave); any
        -- member leaves, except the last admin while others remain (make
        -- someone admin first). The mobile app's 'add members' / 'remove member'
        -- / 'Left Group' checked nobody. Each change posts one system line (not
        -- an unread message). GRP.GroupMembers triggers keep SilaHistory 'G'
        -- rows: the insert trigger is set-based, the delete trigger handles ONE
        -- row per statement -- so members are removed one row at a time.
        -- -----------------------------------------------------------------
        IF @Operation IN (N'Add group members', N'Remove group member', N'Leave group')
        BEGIN
            DECLARE @MSysID INT = NULL, @MSysText NVARCHAR(MAX), @MCount INT = 0;
            DECLARE @MMe NVARCHAR(MAX) = N'@' + ISNULL((SELECT FullName FROM dbo.UserMaster WHERE UserID = @UserID), @User);
            DECLARE @MCreator NVARCHAR(50) = (SELECT CreatedBy FROM GRP.GroupMaster WHERE GroupID = @GroupID);

            IF @Operation = N'Add group members'
            BEGIN
                IF @GIsAdmin = 0
                BEGIN SET @State = 403; SET @Message = N'Only group admins can add members.'; RETURN; END
                DECLARE @MAdd TABLE (UserID INT PRIMARY KEY, Name NVARCHAR(MAX));
                INSERT INTO @MAdd (UserID, Name)
                SELECT DISTINCT u.UserID, ISNULL(u.FullName, u.Username)
                FROM OPENJSON(@LineData, '$.UserIDs') j
                JOIN dbo.UserMaster u ON u.UserID = TRY_CAST(j.[value] AS INT) AND u.IsNotActive = 0
                WHERE NOT EXISTS (SELECT 1 FROM GRP.GroupMembers gm WHERE gm.GroupID = @GroupID AND gm.UserID = u.UserID);
                SET @MCount = (SELECT COUNT(*) FROM @MAdd);
                IF @MCount = 0
                BEGIN SET @State = 1; SET @Message = N'Pick people who are not in the group yet.'; RETURN; END
                IF @MCount > 300
                BEGIN SET @State = 1; SET @Message = N'Add at most 300 people at a time.'; RETURN; END
                SET @MSysText = @MMe + N' added ' + CASE WHEN @MCount <= 5
                    THEN (SELECT STRING_AGG(N'@' + Name, N', ') FROM @MAdd)
                    ELSE CAST(@MCount AS NVARCHAR(10)) + N' members' END;
                BEGIN TRANSACTION;
                INSERT INTO GRP.GroupMembers (GroupID, UserID, IsAdmin, IsCreated, CreatedDate, UnreadCount)
                SELECT @GroupID, UserID, 0, 0, GETDATE(), 0 FROM @MAdd;
            END
            ELSE
            BEGIN
                DECLARE @MTarget INT = CASE WHEN @Operation = N'Leave group' THEN @UserID ELSE TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT) END;
                DECLARE @MTIsAdmin INT, @MTName NVARCHAR(MAX), @MTIsCreator INT;
                SELECT @MTIsAdmin = ISNULL(gm.IsAdmin, 0), @MTName = ISNULL(u.FullName, u.Username),
                       @MTIsCreator = CASE WHEN ISNULL(gm.IsCreated, 0) = 1 OR u.Username = @MCreator THEN 1 ELSE 0 END
                FROM GRP.GroupMembers gm JOIN dbo.UserMaster u ON u.UserID = gm.UserID
                WHERE gm.GroupID = @GroupID AND gm.UserID = @MTarget;
                IF @MTIsAdmin IS NULL
                BEGIN SET @State = 1; SET @Message = N'That person is not a member of this group.'; RETURN; END

                IF @Operation = N'Remove group member'
                BEGIN
                    IF @GIsAdmin = 0
                    BEGIN SET @State = 403; SET @Message = N'Only group admins can remove members.'; RETURN; END
                    IF @MTarget = @UserID
                    BEGIN SET @State = 1; SET @Message = N'Use Leave group to leave it yourself.'; RETURN; END
                    IF @MTIsCreator = 1
                    BEGIN SET @State = 403; SET @Message = N'The group creator can''t be removed.'; RETURN; END
                    SET @MSysText = @MMe + N' removed @' + @MTName;
                END
                ELSE
                BEGIN
                    IF @MTIsAdmin = 1
                       AND (SELECT COUNT(*) FROM GRP.GroupMembers WHERE GroupID = @GroupID AND ISNULL(IsAdmin, 0) = 1) <= 1
                       AND (SELECT COUNT(*) FROM GRP.GroupMembers WHERE GroupID = @GroupID) > 1
                    BEGIN SET @State = 1; SET @Message = N'You are the only admin. Make someone else an admin before you leave.'; RETURN; END
                    SET @MSysText = @MMe + N' left the group';
                END
                SET @MCount = 1;
                BEGIN TRANSACTION;
                -- one row per statement (the delete trigger reads one row)
                DELETE FROM GRP.GroupMembers WHERE GroupID = @GroupID AND UserID = @MTarget;
            END

            SET @MSysID = NEXT VALUE FOR dbo.ChatGroup;
            INSERT INTO GRP.GroupChatHistory
                (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
            VALUES (@MSysID, @GroupID, @UserID, @User, @MSysText, @MSysText, 0, 0,
                    @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1);
            DELETE FROM GRP.GroupUnreadChat WHERE ChatID = @MSysID AND GroupID = @GroupID;
            COMMIT TRANSACTION;
            SELECT @GroupID AS GroupID, @MCount AS Changed, @MSysID AS SystemChatID, @MSysText AS SystemText,
                   (SELECT COUNT(*) FROM GRP.GroupMembers WHERE GroupID = @GroupID) AS MemberCount;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Mark group read
        -- -----------------------------------------------------------------
        IF @Operation = N'Mark group read'
        BEGIN
            DELETE FROM GRP.GroupUnreadChat WHERE GroupID = @GroupID AND UserID = @UserID;
            SELECT @@ROWCOUNT AS Cleared;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Send group chat
        -- -----------------------------------------------------------------
        IF @Operation = N'Send group chat'
        BEGIN
            DECLARE @GText NVARCHAR(MAX), @GLocal BIGINT, @GReply INT;
            SELECT @GText = [Text], @GLocal = LocalChatID, @GReply = ReplayMsgID
            FROM OPENJSON(@LineData) WITH ([Text] NVARCHAR(MAX) '$.Text', LocalChatID BIGINT '$.LocalChatID', ReplayMsgID INT '$.ReplayMsgID');
            SET @GText = LTRIM(RTRIM(ISNULL(@GText, N'')));
            IF @GText = N'' BEGIN SET @State = 1; SET @Message = N'Write a message first.'; RETURN; END
            IF LEN(@GText) > 10000 BEGIN SET @State = 1; SET @Message = N'The message is too long.'; RETURN; END
            IF ISNULL(@GLocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END
            IF @GLocked = 1 AND @GIsAdmin = 0
            BEGIN SET @State = 403; SET @Message = N'Only admins can send messages in this group.'; RETURN; END
            IF ISNULL(@GReply, 0) <> 0 AND NOT EXISTS (SELECT 1 FROM GRP.GroupChatHistory WHERE ChatID = @GReply AND GroupID = @GroupID)
                SET @GReply = 0;

            SELECT @GRet = ChatID FROM GRP.GroupChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @GLocal AND GroupID = @GroupID;
            IF @GRet IS NULL
            BEGIN
                BEGIN TRANSACTION;
                SET @GRet = NEXT VALUE FOR dbo.ChatGroup;
                INSERT INTO GRP.GroupChatHistory
                    (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                VALUES
                    (@GRet, @GroupID, @UserID, @User, @GText,
                     ISNULL(@WHtml, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@GText, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'),
                             NCHAR(13) + NCHAR(10), N'<br>'), NCHAR(10), N'<br>')),
                     ISNULL(@GReply, 0), 0, @User, GETDATE(), @User, GETDATE(), @GLocal, 0, 0, 0, 0);
                COMMIT TRANSACTION;
            END
        END

        -- -----------------------------------------------------------------
        -- Edit group chat / Delete group chat
        -- -----------------------------------------------------------------
        -- -----------------------------------------------------------------
        -- Send group chat file: post a file uploaded through the Files API
        -- LineData { GroupID, AttachmentID, LocalChatID, ReplayMsgID? }
        -- -----------------------------------------------------------------
        IF @Operation = N'Send group chat file'
        BEGIN
            DECLARE @GFAtt INT, @GFLocal BIGINT, @GFReply INT;
            SELECT @GFAtt = AttachmentID, @GFLocal = LocalChatID, @GFReply = ReplayMsgID
            FROM OPENJSON(@LineData) WITH (AttachmentID INT '$.AttachmentID', LocalChatID BIGINT '$.LocalChatID', ReplayMsgID INT '$.ReplayMsgID');
            IF ISNULL(@GFLocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END
            IF @GLocked = 1 AND @GIsAdmin = 0
            BEGIN SET @State = 403; SET @Message = N'Only admins can send messages in this group.'; RETURN; END

            SELECT @GRet = ChatID FROM GRP.GroupChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @GFLocal AND GroupID = @GroupID;
            IF @GRet IS NULL
            BEGIN
            -- a file the caller uploaded through the Files API (:7500) to THIS conversation,
            -- stored, not deleted, and not posted yet (PLS.V1FileUpload, SQLScript/APIPlusAttachmentOperation.sql)
                IF NOT EXISTS (SELECT 1 FROM [PLS].[V1FileUpload] f
                               WHERE f.AttachmentID = @GFAtt AND f.EntityType = 'Group' AND f.EntityKey = @GroupID
                                 AND f.CreatedBy = @User AND f.IsExist = 1 AND f.IsDeleted = 0)
                   OR EXISTS (SELECT 1 FROM GRP.GroupChatHistory WHERE AttachmentID = @GFAtt AND GroupID = @GroupID)
                BEGIN SET @State = 409; SET @Message = N'That file can''t be sent here. Upload it again.'; RETURN; END
                IF ISNULL(@GFReply, 0) <> 0 AND NOT EXISTS (SELECT 1 FROM GRP.GroupChatHistory WHERE ChatID = @GFReply AND GroupID = @GroupID)
                    SET @GFReply = 0;
                SET @GRet = NEXT VALUE FOR dbo.ChatGroup;
                INSERT INTO GRP.GroupChatHistory
                    (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                VALUES (@GRet, @GroupID, @UserID, @User, N'', N'', ISNULL(@GFReply, 0), @GFAtt,
                        @User, GETDATE(), @User, GETDATE(), @GFLocal, 0, 0, 0, 0);
            END
        END

        IF @Operation IN (N'Edit group chat', N'Delete group chat')
        BEGIN
            DECLARE @GEChat INT, @GEText NVARCHAR(MAX), @GELocal BIGINT, @GEFrom INT, @GEGroup INT, @GEDeleted INT, @GESystem INT;
            SELECT @GEChat = ChatID, @GEText = [Text], @GELocal = LocalChatID
            FROM OPENJSON(@LineData) WITH (ChatID INT '$.ChatID', [Text] NVARCHAR(MAX) '$.Text', LocalChatID BIGINT '$.LocalChatID');
            SELECT @GEFrom = FromUserID, @GEGroup = GroupID, @GEDeleted = ISNULL(IsDeleted, 0), @GESystem = ISNULL(IsSystem, 0)
            FROM GRP.GroupChatHistory WHERE ChatID = @GEChat;

            IF @GEFrom IS NULL OR @GEFrom <> @UserID OR @GESystem <> 0
               OR NOT EXISTS (SELECT 1 FROM GRP.GroupMembers WHERE GroupID = @GEGroup AND UserID = @UserID)
            BEGIN SET @State = 403; SET @Message = N'You can only change your own messages.'; RETURN; END
            IF EXISTS (SELECT 1 FROM GRP.GroupMaster g JOIN GRP.GroupMembers gm ON gm.GroupID = g.GroupID AND gm.UserID = @UserID
                       WHERE g.GroupID = @GEGroup AND ISNULL(g.ChatIsLocked, 0) = 1 AND ISNULL(gm.IsAdmin, 0) = 0)
            BEGIN SET @State = 403; SET @Message = N'This group is locked: only admins can change messages.'; RETURN; END
            IF @GEDeleted <> 0 OR EXISTS (SELECT 1 FROM GRP.GroupChatHistory WHERE GroupID = @GEGroup AND OrginalChatID = @GEChat)
            BEGIN SET @State = 1; SET @Message = N'This message was already changed. Reload the conversation.'; RETURN; END
            IF ISNULL(@GELocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END

            IF @Operation = N'Edit group chat'
            BEGIN
                SET @GEText = LTRIM(RTRIM(ISNULL(@GEText, N'')));
                IF @GEText = N'' BEGIN SET @State = 1; SET @Message = N'Write a message first.'; RETURN; END
                IF LEN(@GEText) > 10000 BEGIN SET @State = 1; SET @Message = N'The message is too long.'; RETURN; END
            END
            ELSE
                SET @GEText = N'Text Is Deleted ********';

            SELECT @GRet = ChatID FROM GRP.GroupChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @GELocal AND OrginalChatID = @GEChat;
            IF @GRet IS NULL
            BEGIN
                DECLARE @GIsDel BIT = CASE WHEN @Operation = N'Delete group chat' THEN 1 ELSE 0 END;
                BEGIN TRANSACTION;
                UPDATE GRP.GroupChatHistory
                SET LastMaintBy = @User, LastMaintDate = GETDATE(),
                    IsEdited = CASE WHEN @GIsDel = 0 THEN 1 ELSE IsEdited END,
                    IsDeleted = CASE WHEN @GIsDel = 1 THEN 1 ELSE IsDeleted END
                WHERE ChatID = @GEChat;
                SET @GRet = NEXT VALUE FOR dbo.ChatGroup;
                INSERT INTO GRP.GroupChatHistory
                    (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                SELECT @GRet, GroupID, FromUserID, FromUserName, @GEText,
                       ISNULL(@WHtml, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@GEText, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'),
                               NCHAR(13) + NCHAR(10), N'<br>'), NCHAR(10), N'<br>')),
                       ReplayMsgID, CASE WHEN @GIsDel = 1 THEN 0 ELSE AttachmentID END,
                       @User, GETDATE(), @User, GETDATE(), @GELocal, @GEChat, 0, @GIsDel, 0
                FROM GRP.GroupChatHistory WHERE ChatID = @GEChat;
                -- the trigger (insert + update) counted both rows as new unread messages: undo that
                DELETE FROM GRP.GroupUnreadChat WHERE ChatID IN (@GEChat, @GRet) AND GroupID = @GEGroup;
                COMMIT TRANSACTION;
            END
        END

        -- -----------------------------------------------------------------
        -- My Day (dbo.SilaReminder, SQLScript/SilaReminder.sql): the caller's own
        -- reminders and notes -- private, nobody else reads or changes them --
        -- plus his ticket flags on open tickets (dbo.SilaTicketFlag).
        --   My day          {}  List0 reminders (open, and those done in the last
        --                   day), List1 flags.
        --   Save reminder   { ReminderID? (0 = new), Title, Note?, DueDate?
        --                   (yyyy-mm-dd), DueTime? (HH:mm), Repeat? (day | week |
        --                   month, needs a date), Push? 1|0, LinkKind? (chat |
        --                   group | ticket) + LinkID (SessionID | GroupID |
        --                   TicketID; the caller must be in it), ChatID? (a
        --                   message of that conversation) }  -> List0 the row.
        --   Reminder done   { ReminderID, Done: 1|0 }  a repeating one moves to
        --                   its next date instead.  -> List0 the row.
        --   Delete reminder { ReminderID }
        --   My day count    {}  { Due }: open reminders and flags due today or
        --                   earlier (the rail badge).
        -- A time already passed never fires: saving or reopening one marks it fired.
        -- -----------------------------------------------------------------
        IF @Operation IN (N'My day', N'Save reminder', N'Reminder done', N'Delete reminder', N'My day count')
        BEGIN
            DECLARE @RID INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.ReminderID') AS INT), 0);
            DECLARE @RNow DATETIME = GETDATE();
            IF @RID <> 0 AND NOT EXISTS (SELECT 1 FROM dbo.SilaReminder WHERE ReminderID = @RID AND UserID = @UserID)
            BEGIN SET @State = 404; SET @Message = N'Reminder not found.'; RETURN; END

            IF @Operation = N'My day count'
            BEGIN
                SELECT (SELECT COUNT(*) FROM dbo.SilaReminder r
                        WHERE r.UserID = @UserID AND r.DoneAt IS NULL AND r.DueDate <= CAST(@RNow AS DATE))
                     + (SELECT COUNT(*) FROM dbo.SilaTicketFlag f
                        JOIN CHA.TicketHistory th ON th.TicketID = f.TicketID AND th.TicketState < 50
                        JOIN CHA.TicketMembers tm ON tm.TicketID = f.TicketID AND tm.UserID = @UserID AND tm.IsLeft = 0
                        WHERE f.UserID = @UserID AND f.DueDate <= CAST(@RNow AS DATE)) AS Due;
                RETURN;
            END

            IF @Operation = N'Delete reminder'
            BEGIN
                IF @RID = 0 BEGIN SET @State = 404; SET @Message = N'Reminder not found.'; RETURN; END
                DELETE FROM dbo.SilaReminder WHERE ReminderID = @RID AND UserID = @UserID;
                SELECT @RID AS ReminderID, 1 AS Deleted;
                RETURN;
            END

            IF @Operation = N'Reminder done'
            BEGIN
                IF @RID = 0 BEGIN SET @State = 404; SET @Message = N'Reminder not found.'; RETURN; END
                DECLARE @RDone BIT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Done') AS INT) = 1 THEN 1 ELSE 0 END;
                UPDATE r SET
                    r.DoneAt = CASE WHEN @RDone = 1 AND r.RepeatKind IS NULL THEN @RNow WHEN @RDone = 0 THEN NULL ELSE r.DoneAt END,
                    -- a repeating one skips to the occurrence after this one (or after now)
                    r.DueDate = CASE WHEN @RDone = 1 AND r.RepeatKind IS NOT NULL
                                     THEN dbo.fnSilaReminderNext(r.DueDate, r.DueTime, r.RepeatKind, CASE WHEN r.DueAt > @RNow THEN r.DueAt ELSE @RNow END)
                                     ELSE r.DueDate END,
                    r.NotifiedAt = CASE WHEN @RDone = 1 AND r.RepeatKind IS NOT NULL THEN NULL
                                        WHEN @RDone = 0 AND r.DueAt <= @RNow THEN ISNULL(r.NotifiedAt, @RNow)
                                        ELSE r.NotifiedAt END,
                    r.LastMaintDate = @RNow
                FROM dbo.SilaReminder r WHERE r.ReminderID = @RID AND r.UserID = @UserID;
            END

            IF @Operation = N'Save reminder'
            BEGIN
                DECLARE @RTitle NVARCHAR(MAX) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Title'), N'')));
                DECLARE @RNote NVARCHAR(MAX) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Note'), N'')));
                DECLARE @RDateText NVARCHAR(20) = NULLIF(LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.DueDate'), N''))), N'');
                DECLARE @RTimeText NVARCHAR(20) = NULLIF(LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.DueTime'), N''))), N'');
                DECLARE @RDate DATE = TRY_CONVERT(DATE, @RDateText, 23);
                DECLARE @RTime TIME(0) = TRY_CONVERT(TIME(0), @RTimeText, 108);
                DECLARE @RRepeat VARCHAR(10) = NULLIF(LOWER(LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Repeat'), '')))), '');
                DECLARE @RPush BIT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Push') AS INT) = 0 THEN 0 ELSE 1 END;
                DECLARE @RLinkKind VARCHAR(10) = NULLIF(LOWER(LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.LinkKind'), '')))), '');
                DECLARE @RLinkID INT = NULLIF(TRY_CAST(JSON_VALUE(@LineData, '$.LinkID') AS INT), 0);
                DECLARE @RChatID INT = NULLIF(TRY_CAST(JSON_VALUE(@LineData, '$.ChatID') AS INT), 0);
                IF @RTitle = N'' BEGIN SET @State = 1; SET @Message = N'Write what to remember.'; RETURN; END
                IF LEN(@RTitle) > 200 BEGIN SET @State = 1; SET @Message = N'The title can be at most 200 characters.'; RETURN; END
                IF LEN(@RNote) > 1000 BEGIN SET @State = 1; SET @Message = N'The note can be at most 1000 characters.'; RETURN; END
                IF @RDateText IS NOT NULL AND @RDate IS NULL BEGIN SET @State = 1; SET @Message = N'The date is not valid.'; RETURN; END
                IF @RTimeText IS NOT NULL AND @RTime IS NULL BEGIN SET @State = 1; SET @Message = N'The time is not valid.'; RETURN; END
                IF @RTime IS NOT NULL AND @RDate IS NULL BEGIN SET @State = 1; SET @Message = N'Pick a date for the time.'; RETURN; END
                IF @RRepeat IS NOT NULL AND @RRepeat NOT IN ('day', 'week', 'month') BEGIN SET @State = 1; SET @Message = N'Repeat must be every day, week or month.'; RETURN; END
                IF @RRepeat IS NOT NULL AND @RDate IS NULL BEGIN SET @State = 1; SET @Message = N'A repeating reminder needs a date.'; RETURN; END
                IF @RLinkKind IS NOT NULL AND @RLinkKind NOT IN ('chat', 'group', 'ticket') SET @RLinkKind = NULL;
                IF @RLinkKind IS NULL SELECT @RLinkID = NULL, @RChatID = NULL;
                -- a link only to a conversation the caller is in
                IF @RLinkKind IS NOT NULL AND NOT (
                       (@RLinkKind = 'chat' AND EXISTS (SELECT 1 FROM One.OneChatSession x WHERE x.SessionID = @RLinkID AND (x.UserID1 = @UserID OR x.UserID2 = @UserID)))
                    OR (@RLinkKind = 'group' AND EXISTS (SELECT 1 FROM GRP.GroupMembers x WHERE x.GroupID = @RLinkID AND x.UserID = @UserID))
                    OR (@RLinkKind = 'ticket' AND EXISTS (SELECT 1 FROM CHA.TicketMembers x WHERE x.TicketID = @RLinkID AND x.UserID = @UserID AND x.IsLeft = 0)))
                BEGIN SET @State = 403; SET @Message = N'You can only link a conversation you are in.'; RETURN; END
                IF @RChatID IS NOT NULL AND NOT (
                       (@RLinkKind = 'chat' AND EXISTS (SELECT 1 FROM One.OneToOneChatHistory x WHERE x.ChatID = @RChatID AND x.SessionID = @RLinkID))
                    OR (@RLinkKind = 'group' AND EXISTS (SELECT 1 FROM GRP.GroupChatHistory x WHERE x.ChatID = @RChatID AND x.GroupID = @RLinkID))
                    OR (@RLinkKind = 'ticket' AND EXISTS (SELECT 1 FROM CHA.TicketChatHistory x WHERE x.ChatID = @RChatID AND x.TicketID = @RLinkID)))
                    SET @RChatID = NULL;
                -- a repeating one whose first time has passed starts at its next time
                IF @RRepeat IS NOT NULL SET @RDate = dbo.fnSilaReminderNext(@RDate, @RTime, @RRepeat, DATEADD(MINUTE, -1, @RNow));
                DECLARE @RDueAt DATETIME = CASE WHEN @RDate IS NULL THEN NULL
                    ELSE DATEADD(MINUTE, ISNULL(DATEPART(HOUR, @RTime) * 60 + DATEPART(MINUTE, @RTime), 540), CAST(@RDate AS DATETIME)) END;
                IF @RID = 0
                BEGIN
                    INSERT INTO dbo.SilaReminder (UserID, Title, Note, DueDate, DueTime, RepeatKind, LinkKind, LinkID, ChatID, Push, NotifiedAt)
                    VALUES (@UserID, @RTitle, @RNote, @RDate, @RTime, @RRepeat, @RLinkKind, @RLinkID, @RChatID, @RPush,
                            CASE WHEN @RDueAt <= @RNow AND @RRepeat IS NULL THEN @RNow END);
                    SET @RID = SCOPE_IDENTITY();
                END
                ELSE
                    UPDATE dbo.SilaReminder SET Title = @RTitle, Note = @RNote, DueDate = @RDate, DueTime = @RTime, RepeatKind = @RRepeat,
                           LinkKind = @RLinkKind, LinkID = @RLinkID, ChatID = @RChatID, Push = @RPush,
                           NotifiedAt = CASE WHEN @RDueAt <= @RNow AND @RRepeat IS NULL THEN @RNow END, LastMaintDate = @RNow
                    WHERE ReminderID = @RID AND UserID = @UserID;
            END

            -- the reminders (one after a write, else all open + done in the last day)
            SELECT r.ReminderID, r.Title, r.Note, CONVERT(VARCHAR(10), r.DueDate, 23) AS DueDate,
                   CONVERT(VARCHAR(5), r.DueTime, 108) AS DueTime, r.DueAt, ISNULL(r.RepeatKind, '') AS RepeatKind,
                   ISNULL(r.LinkKind, '') AS LinkKind, ISNULL(r.LinkID, 0) AS LinkID, ISNULL(r.ChatID, 0) AS ChatID,
                   r.Push, r.DoneAt, r.LastFiredAt, r.CreatedDate,
                   CASE r.LinkKind WHEN 'chat' THEN ISNULL(NULLIF(ou.FullName, N''), ou.Username) WHEN 'group' THEN g.Name
                                   WHEN 'ticket' THEN th.TicketSubject END AS LinkTitle,
                   CASE r.LinkKind WHEN 'ticket' THEN N'# ' + ISNULL(cm.Name, N'') + N' · #' + CAST(th.TicketID AS NVARCHAR(20)) ELSE N'' END AS LinkSub
            FROM dbo.SilaReminder r
            LEFT JOIN One.OneChatSession cs ON r.LinkKind = 'chat' AND cs.SessionID = r.LinkID
            LEFT JOIN dbo.UserMaster ou ON ou.UserID = CASE WHEN cs.UserID1 = @UserID THEN cs.UserID2 ELSE cs.UserID1 END
            LEFT JOIN GRP.GroupMaster g ON r.LinkKind = 'group' AND g.GroupID = r.LinkID
            LEFT JOIN CHA.TicketHistory th ON r.LinkKind = 'ticket' AND th.TicketID = r.LinkID
            LEFT JOIN CHA.ChannelMaster cm ON cm.ChannelID = th.TicketChannelID
            WHERE r.UserID = @UserID
              AND (CASE WHEN @Operation = N'My day' THEN 0 ELSE r.ReminderID END = CASE WHEN @Operation = N'My day' THEN 0 ELSE @RID END)
              AND (@Operation <> N'My day' OR r.DoneAt IS NULL OR r.DoneAt >= DATEADD(DAY, -1, @RNow))
            ORDER BY CASE WHEN r.DueAt IS NULL THEN 1 ELSE 0 END, r.DueAt, r.ReminderID;

            IF @Operation = N'My day'
                SELECT f.TicketID, CONVERT(VARCHAR(10), f.DueDate, 23) AS DueDate, f.Note, f.CreatedDate, f.LastMaintDate,
                       th.TicketSubject, th.TicketState, ts.StateDescription, cm.Name AS ChannelName
                FROM dbo.SilaTicketFlag f
                JOIN CHA.TicketHistory th ON th.TicketID = f.TicketID AND th.TicketState < 50
                JOIN CHA.TicketMembers tm ON tm.TicketID = f.TicketID AND tm.UserID = @UserID AND tm.IsLeft = 0
                LEFT JOIN CHA.TicketState ts ON ts.StateID = th.TicketState
                LEFT JOIN CHA.ChannelMaster cm ON cm.ChannelID = th.TicketChannelID
                WHERE f.UserID = @UserID
                ORDER BY CASE WHEN f.DueDate IS NULL THEN 1 ELSE 0 END, f.DueDate, f.TicketID;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- User profile (read-only): one person's card -- name, photo, job,
        -- department, user group, mobile, local extension and HR employee id.
        -- LineData { UserID } or { Username }. Any signed-in user, like the
        -- mobile app's dbo.V_UserMaster_1 (the same view); the employee id is
        -- quick.QUK.UserMaster.EmployeeID, the link that view joins HR on.
        -- -----------------------------------------------------------------
        IF @Operation = N'User profile'
        BEGIN
            DECLARE @PUId INT = TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT);
            DECLARE @PUName NVARCHAR(50) = NULLIF(LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Username'), N''))), N'');
            IF @PUId IS NULL AND @PUName IS NOT NULL
                SELECT @PUId = UserID FROM dbo.UserMaster WHERE Username = @PUName;
            IF @PUId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.UserMaster WHERE UserID = @PUId)
            BEGIN SET @State = 404; SET @Message = N'User not found.'; RETURN; END
            SELECT TOP (1) v.UserID, v.Username, v.FullName, v.MobileNumber, v.LocalNumber, v.JobName, v.DepartmentName,
                   v.GroupName AS UserGroupName, v.IsNotActive, v.FileURL AS PhotoURL, q.EmployeeID
            FROM dbo.V_UserMaster_1 v
            OUTER APPLY (SELECT TOP (1) x.EmployeeID FROM quick.QUK.UserMaster x WHERE x.UserID = v.UserID) q
            WHERE v.UserID = @PUId
            ORDER BY CASE WHEN v.FileURL IS NULL THEN 1 ELSE 0 END;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Find users (read-only): active users for pickers (new group, new
        -- chat). Any signed-in user may search the directory, as the mobile
        -- app's 'System Users and Groups' already returns every user.
        -- -----------------------------------------------------------------
        IF @Operation = N'Find users'
        BEGIN
            -- Search matches name, username or user group; UserGroupID narrows to one
            -- user group (then up to 300, for "add all"). User groups, jobs and
            -- departments come from quick / HR through dbo.V_SilaUserTitle.
            DECLARE @FUSearch NVARCHAR(100) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Search'), N'')));
            DECLARE @FUGroup INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.UserGroupID') AS INT), 0);
            DECLARE @FUTop INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 30);
            DECLARE @FUMax INT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.All') AS INT) = 1 THEN 2000
                                      WHEN @FUGroup <> 0 THEN 300 ELSE 100 END;
            IF @FUTop < 1 SET @FUTop = 1;
            IF @FUTop > @FUMax SET @FUTop = @FUMax;
            SELECT TOP (@FUTop) u.UserID, u.Username, u.FullName, j.JobName, j.DepartmentName, p.FileURL AS PhotoURL,
                   j.UserGroupID, j.UserGroupName
            FROM dbo.UserMaster u
            LEFT JOIN dbo.V_SilaUserTitle j        ON j.UserID = u.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
            WHERE u.IsNotActive = 0 AND u.UserID <> @UserID
              AND (@FUGroup = 0 OR j.UserGroupID = @FUGroup)
              AND (@FUSearch = N'' OR u.FullName LIKE N'%' + @FUSearch + N'%' OR u.Username LIKE N'%' + @FUSearch + N'%'
                   OR j.UserGroupName LIKE N'%' + @FUSearch + N'%')
            ORDER BY CASE WHEN u.FullName LIKE @FUSearch + N'%' OR u.Username LIKE @FUSearch + N'%' THEN 0 ELSE 1 END, u.FullName;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- System settings (read-only): user master, Sila's user group master and
        -- the channel master. Only the user 'mhd' -- enforced here, not by the app.
        -- -----------------------------------------------------------------
        IF @Operation IN (N'Settings users', N'Settings user groups', N'Settings channels', N'Settings channel',
                          N'Save channel purpose', N'Settings channel categories', N'Save channel',
                          N'Add channel members', N'Set channel member', N'Remove channel member',
                          N'Settings user group', N'Save user group', N'Delete user group', N'Set users group',
                          N'Save channel sla', N'Settings chat groups', N'Settings chat group', N'Save chat group',
                          N'Set chat group admin')
        BEGIN
            IF LOWER(@User) <> N'mhd'
            BEGIN SET @State = 403; SET @Message = N'System settings are not available for this user.'; RETURN; END

            IF @Operation = N'Settings users'
            BEGIN
                -- never the Hash column
                SELECT u.UserID, u.Username, u.FullName, t.JobName, t.DepartmentName, t.UserGroupName AS QuickGroupName,
                       u.GroupID AS SilaGroupID, g.GroupName AS SilaGroupName, u.MobileNumber, u.LocalNumber,
                       u.IsAdmin, u.IsDeveloper, u.IsNotActive, u.ForceLogout, u.CreatedDate, u.CreatedBy,
                       u.ChangePasswordDate, p.FileURL AS PhotoURL
                FROM dbo.UserMaster u
                LEFT JOIN dbo.V_SilaUserTitle t  ON t.UserID = u.UserID
                LEFT JOIN dbo.UserGroupMaster g  ON g.GroupID = u.GroupID
                OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                             WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
                ORDER BY u.IsNotActive, u.FullName;
                RETURN;
            END

            IF @Operation = N'Settings user groups'
            BEGIN
                SELECT g.GroupID, g.GroupName, g.CreatedBy, g.CreatedDate, g.LastMintBy, g.LastMintDate,
                       SUM(CASE WHEN u.UserID IS NOT NULL AND u.IsNotActive = 0 THEN 1 ELSE 0 END) AS ActiveUsers,
                       COUNT(u.UserID) AS AllUsers
                FROM dbo.UserGroupMaster g
                LEFT JOIN dbo.UserMaster u ON u.GroupID = g.GroupID
                GROUP BY g.GroupID, g.GroupName, g.CreatedBy, g.CreatedDate, g.LastMintBy, g.LastMintDate
                ORDER BY g.GroupName;
                -- users whose GroupID points at no group in this table
                SELECT COUNT(*) AS OrphanUsers,
                       SUM(CASE WHEN u.IsNotActive = 0 THEN 1 ELSE 0 END) AS OrphanActiveUsers,
                       COUNT(DISTINCT u.GroupID) AS OrphanGroupIDs
                FROM dbo.UserMaster u
                WHERE NOT EXISTS (SELECT 1 FROM dbo.UserGroupMaster g WHERE g.GroupID = u.GroupID);
                RETURN;
            END

            -- -------------------------------------------------------------
            -- Group master: the chat groups (GRP.GroupMaster) with their type
            -- (dbo.SilaGroupType: Broadcast = every active user, admins send).
            -- -------------------------------------------------------------
            IF @Operation = N'Settings chat groups'
            BEGIN
                SELECT g.GroupID, g.Name, ISNULL(g.Inactive, 0) AS Inactive, ISNULL(g.ChatIsLocked, 0) AS ChatIsLocked,
                       CASE WHEN t.GroupID IS NULL THEN 'Group' ELSE t.GroupType END AS GroupType,
                       g.CreatedBy, g.CreatedDate, g.LastMaintDate, ISNULL(mc.Members, 0) AS Members, ISNULL(mc.Admins, 0) AS Admins
                FROM GRP.GroupMaster g
                LEFT JOIN dbo.SilaGroupType t ON t.GroupID = g.GroupID
                LEFT JOIN (SELECT GroupID, COUNT(*) AS Members, SUM(CASE WHEN IsAdmin = 1 THEN 1 ELSE 0 END) AS Admins
                           FROM GRP.GroupMembers GROUP BY GroupID) mc ON mc.GroupID = g.GroupID
                ORDER BY CASE WHEN t.GroupID IS NULL THEN 1 ELSE 0 END, g.Name;
                SELECT COUNT(*) AS ActiveUsers FROM dbo.UserMaster WHERE IsNotActive = 0;
                RETURN;
            END

            IF @Operation = N'Settings chat group'
            BEGIN
                DECLARE @SCGId INT = TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT);
                IF NOT EXISTS (SELECT 1 FROM GRP.GroupMaster WHERE GroupID = @SCGId)
                BEGIN SET @State = 404; SET @Message = N'Group not found.'; RETURN; END
                SELECT g.GroupID, g.Name, ISNULL(g.ChatIsLocked, 0) AS ChatIsLocked,
                       CASE WHEN t.GroupID IS NULL THEN 'Group' ELSE t.GroupType END AS GroupType,
                       g.CreatedBy, cu.FullName AS CreatedByName, g.CreatedDate, g.LastMaintDate,
                       (SELECT COUNT(*) FROM dbo.UserMaster WHERE IsNotActive = 0) AS ActiveUsers,
                       (SELECT COUNT(*) FROM GRP.GroupMembers m JOIN dbo.UserMaster u ON u.UserID = m.UserID
                        WHERE m.GroupID = g.GroupID AND u.IsNotActive = 0) AS ActiveMembers
                FROM GRP.GroupMaster g
                LEFT JOIN dbo.SilaGroupType t ON t.GroupID = g.GroupID
                LEFT JOIN dbo.UserMaster cu ON cu.Username = g.CreatedBy
                WHERE g.GroupID = @SCGId;
                SELECT gm.UserID, u.Username, u.FullName, j.JobName, j.DepartmentName, p.FileURL AS PhotoURL,
                       ISNULL(gm.IsAdmin, 0) AS IsAdmin, u.IsNotActive,
                       CASE WHEN ISNULL(gm.IsCreated, 0) = 1 OR u.Username = g.CreatedBy THEN 1 ELSE 0 END AS IsCreator
                FROM GRP.GroupMembers gm
                JOIN GRP.GroupMaster g ON g.GroupID = gm.GroupID
                JOIN dbo.UserMaster u ON u.UserID = gm.UserID
                LEFT JOIN dbo.V_SilaUserTitle j ON j.UserID = u.UserID
                OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                             WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
                WHERE gm.GroupID = @SCGId
                ORDER BY ISNULL(gm.IsAdmin, 0) DESC, u.IsNotActive, u.FullName;
                RETURN;
            END

            -- new group (GroupID 0) or edit one: Name, Broadcast (0/1); a new one also
            -- AdminIDs (the caller is always creator + admin). Making it a broadcast group
            -- locks it and adds every active user; making it a normal group again unlocks
            -- it and keeps its members. Posts a system line (not an unread message).
            IF @Operation = N'Save chat group'
            BEGIN
                DECLARE @SCId INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT), 0);
                DECLARE @SCName NVARCHAR(MAX) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Name'), N'')));
                DECLARE @SCBroadcast BIT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Broadcast') AS INT) = 1 THEN 1 ELSE 0 END;
                IF @SCName = N'' BEGIN SET @State = 1; SET @Message = N'Give the group a name.'; RETURN; END
                IF LEN(@SCName) > 50 BEGIN SET @State = 1; SET @Message = N'The group name can be at most 50 characters.'; RETURN; END
                IF @SCId <> 0 AND NOT EXISTS (SELECT 1 FROM GRP.GroupMaster WHERE GroupID = @SCId)
                BEGIN SET @State = 404; SET @Message = N'Group not found.'; RETURN; END

                -- a new group: a retried request (lost answer) returns the group it already
                -- created (same creator + name, last 10 minutes); broadcast names are unique
                IF @SCId = 0
                BEGIN
                    DECLARE @SCDup INT = (SELECT TOP (1) GroupID FROM GRP.GroupMaster
                                          WHERE CreatedBy = @User AND Name = @SCName AND CreatedDate >= DATEADD(MINUTE, -10, GETDATE())
                                          ORDER BY GroupID DESC);
                    IF @SCDup IS NOT NULL
                    BEGIN
                        SELECT @SCDup AS GroupID, 0 AS Added, 0 AS Removed,
                               (SELECT COUNT(*) FROM GRP.GroupMembers WHERE GroupID = @SCDup) AS MemberCount;
                        RETURN;
                    END
                END
                IF @SCBroadcast = 1 AND EXISTS (SELECT 1 FROM GRP.GroupMaster g JOIN dbo.SilaGroupType t ON t.GroupID = g.GroupID
                                                WHERE LTRIM(RTRIM(g.Name)) = @SCName AND g.GroupID <> @SCId)
                BEGIN SET @State = 1; SET @Message = N'A broadcast group with this name already exists.'; RETURN; END
                DECLARE @SCWas BIT = CASE WHEN EXISTS (SELECT 1 FROM dbo.SilaGroupType WHERE GroupID = @SCId) THEN 1 ELSE 0 END;
                DECLARE @SCOldName NVARCHAR(MAX) = (SELECT Name FROM GRP.GroupMaster WHERE GroupID = @SCId);
                DECLARE @SCMe NVARCHAR(MAX) = N'@' + ISNULL((SELECT FullName FROM dbo.UserMaster WHERE UserID = @UserID), @User);
                DECLARE @SCText NVARCHAR(MAX) = CASE
                    WHEN @SCId = 0 AND @SCBroadcast = 1 THEN @SCMe + N' created the broadcast group "' + @SCName + N'": only admins send, everyone receives'
                    WHEN @SCId = 0 THEN @SCMe + N' created the group "' + @SCName + N'"'
                    WHEN @SCBroadcast = 1 AND @SCWas = 0 THEN @SCMe + N' made this a broadcast group: only admins send, everyone receives'
                    WHEN @SCBroadcast = 0 AND @SCWas = 1 THEN @SCMe + N' made this a normal group: everyone can send messages'
                    WHEN @SCName <> @SCOldName THEN @SCMe + N' renamed the group to "' + @SCName + N'"'
                    END;
                DECLARE @SCSysID INT;
                BEGIN TRANSACTION;
                IF @SCId = 0
                BEGIN
                    INSERT INTO GRP.GroupMaster (Name, Inactive, ChatIsLocked, AttachmentID, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate)
                    VALUES (@SCName, 0, @SCBroadcast, 0, @User, GETDATE(), @User, GETDATE());
                    SET @SCId = SCOPE_IDENTITY();
                    INSERT INTO GRP.GroupMembers (GroupID, UserID, IsAdmin, IsCreated, CreatedDate, UnreadCount)
                    SELECT @SCId, @UserID, 1, 1, GETDATE(), 0
                    UNION ALL
                    SELECT DISTINCT @SCId, u.UserID, 1, 0, GETDATE(), 0
                    FROM OPENJSON(@LineData, '$.AdminIDs') j
                    JOIN dbo.UserMaster u ON u.UserID = TRY_CAST(j.[value] AS INT) AND u.IsNotActive = 0
                    WHERE u.UserID <> @UserID;
                END
                ELSE
                    UPDATE GRP.GroupMaster SET Name = @SCName, LastMaintBy = @User, LastMaintDate = GETDATE(),
                           ChatIsLocked = CASE WHEN @SCBroadcast = 1 THEN 1 WHEN @SCWas = 1 THEN 0 ELSE ChatIsLocked END
                    WHERE GroupID = @SCId;
                IF @SCBroadcast = 1 AND @SCWas = 0
                    INSERT INTO dbo.SilaGroupType (GroupID, GroupType, LastMaintBy) VALUES (@SCId, 'Broadcast', @User);
                IF @SCBroadcast = 0 AND @SCWas = 1
                    DELETE FROM dbo.SilaGroupType WHERE GroupID = @SCId;
                IF @SCText IS NOT NULL
                BEGIN
                    SET @SCSysID = NEXT VALUE FOR dbo.ChatGroup;
                    INSERT INTO GRP.GroupChatHistory
                        (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                         CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                    VALUES (@SCSysID, @SCId, @UserID, @User, @SCText, @SCText, 0, 0,
                            @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1);
                    DELETE FROM GRP.GroupUnreadChat WHERE ChatID = @SCSysID AND GroupID = @SCId;
                END
                COMMIT TRANSACTION;
                -- everyone active joins (after the commit: hundreds of member rows)
                DECLARE @SCAdded INT = 0, @SCRemoved INT = 0;
                IF @SCBroadcast = 1
                    EXEC dbo.SilaSyncBroadcastGroup @GroupID = @SCId, @Added = @SCAdded OUTPUT, @Removed = @SCRemoved OUTPUT;
                SELECT @SCId AS GroupID, @SCAdded AS Added, @SCRemoved AS Removed,
                       (SELECT COUNT(*) FROM GRP.GroupMembers WHERE GroupID = @SCId) AS MemberCount;
                RETURN;
            END

            -- make a member a group admin or not; a group keeps at least one admin
            IF @Operation = N'Set chat group admin'
            BEGIN
                DECLARE @SAGId INT = TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT);
                DECLARE @SAUser INT = TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT);
                DECLARE @SAMake INT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Admin') AS INT) = 1 THEN 1 ELSE 0 END;
                DECLARE @SANow INT, @SAName NVARCHAR(MAX);
                SELECT @SANow = ISNULL(gm.IsAdmin, 0), @SAName = ISNULL(u.FullName, u.Username)
                FROM GRP.GroupMembers gm JOIN dbo.UserMaster u ON u.UserID = gm.UserID
                WHERE gm.GroupID = @SAGId AND gm.UserID = @SAUser;
                IF @SANow IS NULL BEGIN SET @State = 1; SET @Message = N'That person is not in this group.'; RETURN; END
                IF @SAMake = 0 AND @SANow = 1
                   AND (SELECT COUNT(*) FROM GRP.GroupMembers WHERE GroupID = @SAGId AND ISNULL(IsAdmin, 0) = 1) <= 1
                BEGIN SET @State = 1; SET @Message = N'A group needs at least one admin.'; RETURN; END
                IF @SANow <> @SAMake
                BEGIN
                    DECLARE @SAText NVARCHAR(MAX) = N'@' + ISNULL((SELECT FullName FROM dbo.UserMaster WHERE UserID = @UserID), @User)
                        + CASE WHEN @SAMake = 1 THEN N' made @' + @SAName + N' an admin' ELSE N' dismissed @' + @SAName + N' as admin' END;
                    DECLARE @SASysID INT = NEXT VALUE FOR dbo.ChatGroup;
                    BEGIN TRANSACTION;
                    UPDATE GRP.GroupMembers SET IsAdmin = @SAMake WHERE GroupID = @SAGId AND UserID = @SAUser;
                    INSERT INTO GRP.GroupChatHistory
                        (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                         CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                    VALUES (@SASysID, @SAGId, @UserID, @User, @SAText, @SAText, 0, 0,
                            @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1);
                    DELETE FROM GRP.GroupUnreadChat WHERE ChatID = @SASysID AND GroupID = @SAGId;
                    COMMIT TRANSACTION;
                END
                SELECT @SAGId AS GroupID, @SAUser AS UserID, @SAMake AS IsAdmin;
                RETURN;
            END

            -- -------------------------------------------------------------
            -- Sila user groups (dbo.UserGroupMaster; a user's group is
            -- UserMaster.GroupID -- the mobile control panel uses the same).
            -- -------------------------------------------------------------
            IF @Operation = N'Settings user group'
            BEGIN
                DECLARE @UGId INT = TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT);
                IF NOT EXISTS (SELECT 1 FROM dbo.UserGroupMaster WHERE GroupID = @UGId)
                BEGIN SET @State = 404; SET @Message = N'Group not found.'; RETURN; END
                SELECT g.GroupID, g.GroupName, g.CreatedBy, g.CreatedDate, g.LastMintBy, g.LastMintDate
                FROM dbo.UserGroupMaster g WHERE g.GroupID = @UGId;
                SELECT u.UserID, u.Username, u.FullName, t.JobName, t.DepartmentName, p.FileURL AS PhotoURL, u.IsNotActive
                FROM dbo.UserMaster u
                LEFT JOIN dbo.V_SilaUserTitle t ON t.UserID = u.UserID
                OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                             WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
                WHERE u.GroupID = @UGId
                ORDER BY u.IsNotActive, u.FullName;
                RETURN;
            END

            -- new group (GroupID 0 / missing) or rename one; names are unique
            IF @Operation = N'Save user group'
            BEGIN
                DECLARE @SGId INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT), 0);
                DECLARE @SGName NVARCHAR(MAX) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.GroupName'), N'')));
                IF @SGName = N'' BEGIN SET @State = 1; SET @Message = N'Give the group a name.'; RETURN; END
                IF LEN(@SGName) > 100 BEGIN SET @State = 1; SET @Message = N'The name can be at most 100 characters.'; RETURN; END
                IF @SGId <> 0 AND NOT EXISTS (SELECT 1 FROM dbo.UserGroupMaster WHERE GroupID = @SGId)
                BEGIN SET @State = 404; SET @Message = N'Group not found.'; RETURN; END
                IF EXISTS (SELECT 1 FROM dbo.UserGroupMaster WHERE LTRIM(RTRIM(GroupName)) = @SGName AND GroupID <> @SGId)
                BEGIN SET @State = 1; SET @Message = N'Another group already has this name.'; RETURN; END
                IF @SGId = 0
                BEGIN
                    INSERT INTO dbo.UserGroupMaster (GroupName, CreatedBy, CreatedDate, LastMintBy, LastMintDate)
                    VALUES (@SGName, @User, GETDATE(), @User, GETDATE());
                    SET @SGId = SCOPE_IDENTITY();
                END
                ELSE
                    UPDATE dbo.UserGroupMaster SET GroupName = @SGName, LastMintBy = @User, LastMintDate = GETDATE()
                    WHERE GroupID = @SGId;
                SELECT @SGId AS GroupID;
                RETURN;
            END

            -- only an empty group (no user, active or not, points at it)
            IF @Operation = N'Delete user group'
            BEGIN
                DECLARE @DGId INT = TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT);
                IF NOT EXISTS (SELECT 1 FROM dbo.UserGroupMaster WHERE GroupID = @DGId)
                BEGIN SET @State = 404; SET @Message = N'Group not found.'; RETURN; END
                IF EXISTS (SELECT 1 FROM dbo.UserMaster WHERE GroupID = @DGId)
                BEGIN SET @State = 1; SET @Message = N'Move its users to another group first.'; RETURN; END
                DELETE FROM dbo.UserGroupMaster WHERE GroupID = @DGId;
                SELECT @@ROWCOUNT AS Deleted;
                RETURN;
            END

            -- move users into a group (their UserMaster.GroupID)
            IF @Operation = N'Set users group'
            BEGIN
                DECLARE @MGId INT = TRY_CAST(JSON_VALUE(@LineData, '$.GroupID') AS INT);
                IF NOT EXISTS (SELECT 1 FROM dbo.UserGroupMaster WHERE GroupID = @MGId)
                BEGIN SET @State = 404; SET @Message = N'Group not found.'; RETURN; END
                UPDATE u SET u.GroupID = @MGId
                FROM dbo.UserMaster u
                JOIN (SELECT DISTINCT CAST([value] AS INT) AS UserID FROM OPENJSON(@LineData, '$.UserIDs')
                      WHERE TRY_CAST([value] AS INT) IS NOT NULL) x ON x.UserID = u.UserID
                WHERE ISNULL(u.GroupID, 0) <> @MGId;
                SELECT @@ROWCOUNT AS Moved;
                RETURN;
            END

            -- the categories a channel can be in (the New channel / Edit channel form)
            IF @Operation = N'Settings channel categories'
            BEGIN
                SELECT cc.ChannelCategoryID, cc.CategoryDescription,
                       (SELECT COUNT(*) FROM CHA.ChannelMaster c WHERE c.CategoryID = cc.ChannelCategoryID) AS Channels
                FROM CHA.ChannelCategory cc
                ORDER BY cc.CategoryDescription;
                RETURN;
            END

            -- New channel (ChannelID 0 / missing) or edit one: name (unique, at most 100
            -- characters), category, private, inactive. A new channel may come with its
            -- purpose. Members are added afterwards ('Add channel members').
            IF @Operation = N'Save channel'
            BEGIN
                DECLARE @CHId INT, @CHName NVARCHAR(MAX), @CHCat INT, @CHPriv INT, @CHInactive INT,
                        @CHPurpose NVARCHAR(MAX), @CHExamples NVARCHAR(MAX);
                SELECT @CHId = ISNULL(ChannelID, 0), @CHName = LTRIM(RTRIM(ISNULL(Name, N''))), @CHCat = CategoryID,
                       @CHPriv = CASE WHEN IsPrivate = 1 THEN 1 ELSE 0 END, @CHInactive = CASE WHEN InActive = 1 THEN 1 ELSE 0 END,
                       @CHPurpose = LTRIM(RTRIM(ISNULL(Purpose, N''))), @CHExamples = LTRIM(RTRIM(ISNULL(Examples, N'')))
                FROM OPENJSON(@LineData) WITH (ChannelID INT '$.ChannelID', Name NVARCHAR(MAX) '$.Name', CategoryID INT '$.CategoryID',
                     IsPrivate INT '$.IsPrivate', InActive INT '$.InActive', Purpose NVARCHAR(MAX) '$.Purpose',
                     Examples NVARCHAR(MAX) '$.Examples');
                IF @CHName = N'' BEGIN SET @State = 1; SET @Message = N'Give the channel a name.'; RETURN; END
                IF LEN(@CHName) > 100 BEGIN SET @State = 1; SET @Message = N'The name can be at most 100 characters.'; RETURN; END
                IF NOT EXISTS (SELECT 1 FROM CHA.ChannelCategory WHERE ChannelCategoryID = @CHCat)
                BEGIN SET @State = 1; SET @Message = N'Pick a category.'; RETURN; END
                IF @CHId <> 0 AND NOT EXISTS (SELECT 1 FROM CHA.ChannelMaster WHERE ChannelID = @CHId)
                BEGIN SET @State = 404; SET @Message = N'Channel not found.'; RETURN; END
                IF EXISTS (SELECT 1 FROM CHA.ChannelMaster WHERE LTRIM(RTRIM(Name)) = @CHName AND ChannelID <> @CHId)
                BEGIN SET @State = 1; SET @Message = N'Another channel already has this name.'; RETURN; END
                IF LEN(@CHPurpose) > 1000 OR LEN(@CHExamples) > 1000
                BEGIN SET @State = 1; SET @Message = N'Purpose and examples can be at most 1000 characters each.'; RETURN; END

                BEGIN TRANSACTION;
                IF @CHId = 0
                BEGIN
                    INSERT INTO CHA.ChannelMaster (Name, CategoryID, InActive, IsPrivate, CreatedDate, CreatedBy, LastMaintDate, LastMaintBy)
                    VALUES (@CHName, @CHCat, @CHInactive, CASE WHEN @CHPriv = 1 THEN N'1' ELSE N'0' END, GETDATE(), @User, GETDATE(), @User);
                    SET @CHId = SCOPE_IDENTITY();
                    IF @CHPurpose <> N''
                        INSERT INTO dbo.SilaChannelPurpose (ChannelID, Purpose, Examples, OfferInAssistant, LastMaintBy)
                        VALUES (@CHId, @CHPurpose, @CHExamples, 1, @User);
                END
                ELSE
                    UPDATE CHA.ChannelMaster SET Name = @CHName, CategoryID = @CHCat, InActive = @CHInactive,
                           IsPrivate = CASE WHEN @CHPriv = 1 THEN N'1' ELSE N'0' END, LastMaintDate = GETDATE(), LastMaintBy = @User
                    WHERE ChannelID = @CHId;
                COMMIT TRANSACTION;
                SELECT @CHId AS ChannelID;
                RETURN;
            END

            -- Channel members: add (active users, not already in), change roles, remove.
            -- New tickets copy roles from here; existing tickets keep theirs.
            IF @Operation IN (N'Add channel members', N'Set channel member', N'Remove channel member')
            BEGIN
                DECLARE @MChannel INT = TRY_CAST(JSON_VALUE(@LineData, '$.ChannelID') AS INT);
                IF NOT EXISTS (SELECT 1 FROM CHA.ChannelMaster WHERE ChannelID = @MChannel)
                BEGIN SET @State = 404; SET @Message = N'Channel not found.'; RETURN; END

                IF @Operation = N'Add channel members'
                BEGIN
                    INSERT INTO CHA.ChannelMembers (ChannelID, UserID, IsTeamLeader, IsAdmin, CreatedDate)
                    SELECT @MChannel, x.UserID, MAX(CASE WHEN x.IsTeamLeader = 1 THEN 1 ELSE 0 END),
                           MAX(CASE WHEN x.IsAdmin = 1 THEN 1 ELSE 0 END), GETDATE()
                    FROM OPENJSON(@LineData, '$.Members') WITH (UserID INT '$.UserID', IsAdmin INT '$.IsAdmin', IsTeamLeader INT '$.IsTeamLeader') x
                    JOIN dbo.UserMaster u ON u.UserID = x.UserID AND u.IsNotActive = 0
                    WHERE NOT EXISTS (SELECT 1 FROM CHA.ChannelMembers m WHERE m.ChannelID = @MChannel AND m.UserID = x.UserID)
                    GROUP BY x.UserID;
                    SELECT @@ROWCOUNT AS Added;
                    RETURN;
                END

                DECLARE @MUser INT = TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT);
                IF NOT EXISTS (SELECT 1 FROM CHA.ChannelMembers WHERE ChannelID = @MChannel AND UserID = @MUser)
                BEGIN SET @State = 1; SET @Message = N'That person is not in this channel.'; RETURN; END
                IF @Operation = N'Set channel member'
                BEGIN
                    UPDATE CHA.ChannelMembers
                    SET IsAdmin = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.IsAdmin') AS INT) = 1 THEN 1 ELSE 0 END,
                        IsTeamLeader = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.IsTeamLeader') AS INT) = 1 THEN 1 ELSE 0 END
                    WHERE ChannelID = @MChannel AND UserID = @MUser;
                    SELECT UserID, IsAdmin, IsTeamLeader FROM CHA.ChannelMembers WHERE ChannelID = @MChannel AND UserID = @MUser;
                    RETURN;
                END
                DELETE FROM CHA.ChannelMembers WHERE ChannelID = @MChannel AND UserID = @MUser;
                SELECT @@ROWCOUNT AS Removed;
                RETURN;
            END

            -- a channel's SLA targets (dbo.SilaChannelSla, SQLScript/SilaSla.sql), in WORKING
            -- minutes (Sat-Thu 08:00-16:00; a working day = 480). NULL / 0 = no target.
            IF @Operation = N'Save channel sla'
            BEGIN
                DECLARE @SlChannel INT = TRY_CAST(JSON_VALUE(@LineData, '$.ChannelID') AS INT);
                DECLARE @SlReply INT = NULLIF(TRY_CAST(JSON_VALUE(@LineData, '$.FirstReplyMinutes') AS INT), 0);
                DECLARE @SlFinish INT = NULLIF(TRY_CAST(JSON_VALUE(@LineData, '$.FinishMinutes') AS INT), 0);
                IF NOT EXISTS (SELECT 1 FROM CHA.ChannelMaster WHERE ChannelID = @SlChannel)
                BEGIN SET @State = 404; SET @Message = N'Channel not found.'; RETURN; END
                IF @SlReply < 0 OR @SlFinish < 0 OR @SlReply > 480 * 60 OR @SlFinish > 480 * 120
                BEGIN SET @State = 1; SET @Message = N'Targets must be between 1 minute and 60 working days (reply) / 120 (finish).'; RETURN; END
                UPDATE dbo.SilaChannelSla SET FirstReplyMinutes = @SlReply, FinishMinutes = @SlFinish, LastMaintBy = @User, LastMaintDate = GETDATE()
                WHERE ChannelID = @SlChannel;
                IF @@ROWCOUNT = 0
                    INSERT INTO dbo.SilaChannelSla (ChannelID, FirstReplyMinutes, FinishMinutes, LastMaintBy) VALUES (@SlChannel, @SlReply, @SlFinish, @User);
                SELECT ChannelID, FirstReplyMinutes, FinishMinutes, LastMaintBy, LastMaintDate FROM dbo.SilaChannelSla WHERE ChannelID = @SlChannel;
                RETURN;
            END

            -- what a channel handles (dbo.SilaChannelPurpose, SQLScript/SilaChannelPurpose.sql):
            -- the one write in System Settings. Purpose required, at most 1000 characters each.
            IF @Operation = N'Save channel purpose'
            BEGIN
                DECLARE @PChannel INT, @PPurpose NVARCHAR(MAX), @PExamples NVARCHAR(MAX), @POffer INT;
                SELECT @PChannel = ChannelID, @PPurpose = LTRIM(RTRIM(ISNULL(Purpose, N''))),
                       @PExamples = LTRIM(RTRIM(ISNULL(Examples, N''))), @POffer = CASE WHEN Offer = 0 THEN 0 ELSE 1 END
                FROM OPENJSON(@LineData) WITH (ChannelID INT '$.ChannelID', Purpose NVARCHAR(MAX) '$.Purpose',
                     Examples NVARCHAR(MAX) '$.Examples', Offer INT '$.OfferInAssistant');
                IF NOT EXISTS (SELECT 1 FROM CHA.ChannelMaster WHERE ChannelID = @PChannel)
                BEGIN SET @State = 404; SET @Message = N'Channel not found.'; RETURN; END
                IF @PPurpose = N'' BEGIN SET @State = 1; SET @Message = N'Write what the channel handles.'; RETURN; END
                IF LEN(@PPurpose) > 1000 OR LEN(@PExamples) > 1000
                BEGIN SET @State = 1; SET @Message = N'Purpose and examples can be at most 1000 characters each.'; RETURN; END
                UPDATE dbo.SilaChannelPurpose SET Purpose = @PPurpose, Examples = @PExamples, OfferInAssistant = @POffer,
                       LastMaintBy = @User, LastMaintDate = GETDATE()
                WHERE ChannelID = @PChannel;
                IF @@ROWCOUNT = 0
                    INSERT INTO dbo.SilaChannelPurpose (ChannelID, Purpose, Examples, OfferInAssistant, LastMaintBy)
                    VALUES (@PChannel, @PPurpose, @PExamples, @POffer, @User);
                SELECT p.ChannelID, p.Purpose, p.Examples, p.OfferInAssistant, p.LastMaintBy AS PurposeBy,
                       p.LastMaintDate AS PurposeDate
                FROM dbo.SilaChannelPurpose p WHERE p.ChannelID = @PChannel;
                RETURN;
            END

            IF @Operation = N'Settings channel'
            BEGIN
                DECLARE @SChannel INT = TRY_CAST(JSON_VALUE(@LineData, '$.ChannelID') AS INT);
                IF NOT EXISTS (SELECT 1 FROM CHA.ChannelMaster WHERE ChannelID = @SChannel)
                BEGIN SET @State = 404; SET @Message = N'Channel not found.'; RETURN; END

                SELECT c.ChannelID, c.Name, c.CategoryID, cc.CategoryDescription, c.InActive,
                       CASE WHEN LTRIM(RTRIM(ISNULL(c.IsPrivate, N'0'))) = N'1' THEN 1 ELSE 0 END AS IsPrivate,
                       c.CreatedDate, c.CreatedBy, cu.FullName AS CreatedByName, c.LastMaintDate, c.LastMaintBy,
                       mu.FullName AS LastMaintByName,
                       ISNULL(p.Purpose, N'') AS Purpose, ISNULL(p.Examples, N'') AS Examples,
                       CAST(ISNULL(p.OfferInAssistant, 0) AS INT) AS OfferInAssistant,
                       p.LastMaintBy AS PurposeBy, pu.FullName AS PurposeByName, p.LastMaintDate AS PurposeDate,
                       sl.FirstReplyMinutes AS ReplyTarget, sl.FinishMinutes AS FinishTarget
                FROM CHA.ChannelMaster c
                LEFT JOIN dbo.SilaChannelSla sl ON sl.ChannelID = c.ChannelID
                LEFT JOIN CHA.ChannelCategory cc ON cc.ChannelCategoryID = c.CategoryID
                LEFT JOIN dbo.UserMaster cu      ON cu.Username = c.CreatedBy
                LEFT JOIN dbo.UserMaster mu      ON mu.Username = c.LastMaintBy
                LEFT JOIN dbo.SilaChannelPurpose p ON p.ChannelID = c.ChannelID
                LEFT JOIN dbo.UserMaster pu      ON pu.Username = p.LastMaintBy
                WHERE c.ChannelID = @SChannel;

                SELECT m.UserID, u.Username, u.FullName, t.JobName, t.DepartmentName, p.FileURL AS PhotoURL,
                       m.IsAdmin, m.IsTeamLeader, m.CreatedDate, u.IsNotActive
                FROM CHA.ChannelMembers m
                JOIN dbo.UserMaster u              ON u.UserID = m.UserID
                LEFT JOIN dbo.V_SilaUserTitle t    ON t.UserID = u.UserID
                OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                             WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
                WHERE m.ChannelID = @SChannel
                ORDER BY m.IsAdmin DESC, m.IsTeamLeader DESC, u.IsNotActive, u.FullName;

                SELECT th.TicketState, ts.StateDescription, COUNT(*) AS Tickets, MAX(th.LastMaintDate) AS LastUpdate
                FROM CHA.TicketHistory th
                LEFT JOIN CHA.TicketState ts ON ts.StateID = th.TicketState
                WHERE th.TicketChannelID = @SChannel
                GROUP BY th.TicketState, ts.StateDescription
                ORDER BY th.TicketState;

                SELECT TOP (20) th.TicketID, th.TicketSubject, th.TicketState, ts.StateDescription, th.CreatedDate,
                       th.CreatedByUser, cu.FullName AS CreatedByName, th.LastMaintDate
                FROM CHA.TicketHistory th
                LEFT JOIN CHA.TicketState ts ON ts.StateID = th.TicketState
                LEFT JOIN dbo.UserMaster cu  ON cu.Username = th.CreatedByUser
                WHERE th.TicketChannelID = @SChannel
                ORDER BY th.TicketID DESC;
                RETURN;
            END

            -- Settings channels
            SELECT c.ChannelID, c.Name, c.CategoryID, cc.CategoryDescription, c.InActive,
                   CASE WHEN LTRIM(RTRIM(ISNULL(c.IsPrivate, N'0'))) = N'1' THEN 1 ELSE 0 END AS IsPrivate,
                   c.CreatedDate, c.CreatedBy, c.LastMaintDate, c.LastMaintBy,
                   ISNULL(m.Members, 0) AS Members, ISNULL(m.Admins, 0) AS Admins, ISNULL(m.TeamLeaders, 0) AS TeamLeaders,
                   ISNULL(t.OpenTickets, 0) AS OpenTickets, ISNULL(t.AllTickets, 0) AS AllTickets,
                   ISNULL(p.Purpose, N'') AS Purpose, CAST(ISNULL(p.OfferInAssistant, 0) AS INT) AS OfferInAssistant
            FROM CHA.ChannelMaster c
            LEFT JOIN CHA.ChannelCategory cc ON cc.ChannelCategoryID = c.CategoryID
            LEFT JOIN dbo.SilaChannelPurpose p ON p.ChannelID = c.ChannelID
            LEFT JOIN (SELECT ChannelID, COUNT(*) AS Members, SUM(CASE WHEN IsAdmin = 1 THEN 1 ELSE 0 END) AS Admins,
                              SUM(CASE WHEN IsTeamLeader = 1 THEN 1 ELSE 0 END) AS TeamLeaders
                       FROM CHA.ChannelMembers GROUP BY ChannelID) m ON m.ChannelID = c.ChannelID
            LEFT JOIN (SELECT TicketChannelID, SUM(CASE WHEN TicketState < 50 THEN 1 ELSE 0 END) AS OpenTickets, COUNT(*) AS AllTickets
                       FROM CHA.TicketHistory GROUP BY TicketChannelID) t ON t.TicketChannelID = c.ChannelID
            ORDER BY cc.CategoryDescription, c.Name;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- User groups (read-only): the user groups (quick.QUK.UserGroupMaster, through
        -- dbo.V_SilaUserTitle) with how many active users (other than the caller)
        -- are in each -- the picker's filter list.
        -- -----------------------------------------------------------------
        IF @Operation = N'User groups'
        BEGIN
            SELECT t.UserGroupID, MAX(t.UserGroupName) AS UserGroupName, COUNT(*) AS ActiveUsers
            FROM dbo.UserMaster u
            JOIN dbo.V_SilaUserTitle t ON t.UserID = u.UserID
            WHERE u.IsNotActive = 0 AND u.UserID <> @UserID AND t.UserGroupID IS NOT NULL
            GROUP BY t.UserGroupID
            ORDER BY MAX(t.UserGroupName);
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Create group. Same rows as the mobile app's 'New Group': GroupMaster,
        -- GroupMembers (their insert trigger adds each member's SilaHistory 'G'
        -- row and bumps ApplicationTableVersion 3 for the mobile sync), then a
        -- system line (the message trigger fills LastMessage / unread for the
        -- members, so the new group shows up in their lists).
        -- Differences: only the creator chooses admins; members must be active,
        -- distinct users; the creator is added once as creator + admin; a retry
        -- within 60 s (same creator + name) returns the group already created.
        -- LineData { Name, Members: [ { UserID, IsAdmin } ] }  -> List0 { GroupID, GroupName, Created }
        -- -----------------------------------------------------------------
        IF @Operation = N'Create group'
        BEGIN
            DECLARE @CGName NVARCHAR(MAX) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Name'), N'')));
            IF @CGName = N'' BEGIN SET @State = 1; SET @Message = N'Give the group a name.'; RETURN; END
            IF LEN(@CGName) > 50 BEGIN SET @State = 1; SET @Message = N'The group name can be at most 50 characters.'; RETURN; END

            DECLARE @CGMembers TABLE (UserID INT PRIMARY KEY, IsAdmin INT);
            INSERT INTO @CGMembers (UserID, IsAdmin)
            SELECT m.UserID, MAX(CASE WHEN m.IsAdmin = 1 THEN 1 ELSE 0 END)
            FROM OPENJSON(@LineData, '$.Members') WITH (UserID INT '$.UserID', IsAdmin INT '$.IsAdmin') m
            JOIN dbo.UserMaster u ON u.UserID = m.UserID AND u.IsNotActive = 0    -- active users only
            WHERE m.UserID <> @UserID                                              -- the creator is added below
            GROUP BY m.UserID;
            IF NOT EXISTS (SELECT 1 FROM @CGMembers)
            BEGIN SET @State = 1; SET @Message = N'Add at least one member.'; RETURN; END
            IF (SELECT COUNT(*) FROM @CGMembers) > 256
            BEGIN SET @State = 1; SET @Message = N'A group can have at most 256 members.'; RETURN; END

            DECLARE @CGID INT = NULL, @CGCreated INT = 0;
            -- a retried request (lost answer) returns the group it already created
            SELECT TOP (1) @CGID = GroupID FROM GRP.GroupMaster
            WHERE CreatedBy = @User AND Name = @CGName AND CreatedDate >= DATEADD(SECOND, -60, GETDATE())
            ORDER BY GroupID DESC;

            IF @CGID IS NULL
            BEGIN
                DECLARE @CGFull NVARCHAR(MAX) = (SELECT FullName FROM dbo.UserMaster WHERE UserID = @UserID);
                DECLARE @CGSysText NVARCHAR(MAX) = N'@' + ISNULL(@CGFull, @User) + N' created the group "' + @CGName + N'"';
                DECLARE @CGSysID INT;
                BEGIN TRANSACTION;
                INSERT INTO GRP.GroupMaster (Name, Inactive, ChatIsLocked, AttachmentID, CreatedBy, CreatedDate, LastMaintBy, LastMaintDate)
                VALUES (@CGName, 0, 0, 0, @User, GETDATE(), @User, GETDATE());
                SET @CGID = SCOPE_IDENTITY();

                INSERT INTO GRP.GroupMembers (GroupID, UserID, IsAdmin, IsCreated, CreatedDate, UnreadCount)
                SELECT @CGID, @UserID, 1, 1, GETDATE(), 0
                UNION ALL
                SELECT @CGID, m.UserID, m.IsAdmin, 0, GETDATE(), 0 FROM @CGMembers m;

                SET @CGSysID = NEXT VALUE FOR dbo.ChatGroup;
                INSERT INTO GRP.GroupChatHistory
                    (ChatID, GroupID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem)
                VALUES (@CGSysID, @CGID, @UserID, @User, @CGSysText, @CGSysText, 0, 0,
                        @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1);
                COMMIT TRANSACTION;
                SET @CGCreated = 1;
            END

            SELECT g.GroupID, g.Name AS GroupName, @CGCreated AS Created,
                   (SELECT COUNT(*) FROM GRP.GroupMembers x WHERE x.GroupID = g.GroupID) AS MemberCount
            FROM GRP.GroupMaster g WHERE g.GroupID = @CGID;
            RETURN;
        END

        IF @GRet IS NOT NULL
        BEGIN
            SELECT m.GroupID, CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END AS SortID,
                   m.ChatID, m.FromUserID, fu.Username AS FromUsername, ISNULL(fu.FullName, m.FromUserName) AS FromName,
                   fj.JobName AS FromJobName, fp.FileURL AS FromPhotoURL,
                   m.Text, m.TextStyle, m.ReplayMsgID, ISNULL(m.IsSystem, 0) AS IsSystem,
                   m.IsDeleted, m.IsEdited, m.OrginalChatID, m.CreatedDate, m.LastMaintDate, m.LocalChatID,
                   m.AttachmentID, t.FileName, t.FileOrginalName, t.FileExtension, t.FileSize, t.FileURL,
                   r.Text AS ReplyText, r.FromUserID AS ReplyFromUserID, ISNULL(ru.FullName, r.FromUserName) AS ReplyFromName
            FROM GRP.GroupChatHistory m
            LEFT JOIN dbo.AttachmentHistory t  ON t.AttachmentID = m.AttachmentID AND m.AttachmentID <> 0
            LEFT JOIN dbo.UserMaster fu        ON fu.UserID = m.FromUserID
            LEFT JOIN dbo.V_SilaUserTitle fj     ON fj.UserID = fu.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = fu.AttachmentID AND fu.AttachmentID <> 0 ORDER BY x.ID DESC) fp
            -- TOP 1: the old mobile 'Delete Chat' took ChatIDs from the one-to-one sequence, so a group ChatID may repeat
            OUTER APPLY (SELECT TOP (1) x.Text, x.FromUserID, x.FromUserName FROM GRP.GroupChatHistory x
                         WHERE x.ChatID = m.ReplayMsgID AND m.ReplayMsgID <> 0 AND x.GroupID = m.GroupID ORDER BY x.ID DESC) r
            LEFT JOIN dbo.UserMaster ru        ON ru.UserID = r.FromUserID
            WHERE m.ChatID = @GRet;
            RETURN;
        END

        SET @State = 1;
        SET @Message = N'Unknown operation.';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        SET @State = ERROR_NUMBER();
        SET @Message = LEFT(N'SQL Exception: ' + ERROR_MESSAGE() + N' (Line: ' + CAST(ERROR_LINE() AS NVARCHAR(10)) + N')', 500);
    END CATCH
END
GO

-- -------------------------------------------------------------------------
-- Allow-list rows for this procedure (PLS.V1ApiOperationPermission). The SP
-- authorizes the caller itself (@User from the token; one-to-one operations
-- check session membership). Inputs travel in LineData: no extra parameters.
-- -------------------------------------------------------------------------
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'dbo.APISilaWebOperation', N'Left side',      N'Home list: caller''s conversations (SilaHistory), delta by LineData.MaxSeq'),
    (N'dbo.APISilaWebOperation', N'Chat messages',  N'One-to-one: messages of a session the caller belongs to, paged'),
    (N'dbo.APISilaWebOperation', N'Mark chat read', N'One-to-one: clear the caller''s unread rows for a session, mark them seen'),
    (N'dbo.APISilaWebOperation', N'Send chat',      N'One-to-one: send a text message (own session or ToUserID), idempotent by LocalChatID'),
    (N'dbo.APISilaWebOperation', N'Edit chat',      N'One-to-one: edit the caller''s own message (new row, OrginalChatID)'),
    (N'dbo.APISilaWebOperation', N'Delete chat',    N'One-to-one: delete the caller''s own message (placeholder row)'),
    (N'dbo.APISilaWebOperation', N'Group messages',    N'Groups: messages of a group the caller belongs to, paged'),
    (N'dbo.APISilaWebOperation', N'Group members',     N'Groups: members of a group the caller belongs to (details panel)'),
    (N'dbo.APISilaWebOperation', N'Lock group chat',   N'Groups: admins lock / unlock sending (ChatIsLocked), posts a system line'),
    (N'dbo.APISilaWebOperation', N'Set group admin',   N'Groups: admins make / dismiss admins (creator protected, keeps one admin), posts a system line'),
    (N'dbo.APISilaWebOperation', N'Add group members',   N'Groups: admins add active users (max 300), posts a system line'),
    (N'dbo.APISilaWebOperation', N'Remove group member', N'Groups: admins remove a member (not the creator, not themselves), posts a system line'),
    (N'dbo.APISilaWebOperation', N'Leave group',         N'Groups: a member leaves (not the last admin while others remain), posts a system line'),
    (N'dbo.APISilaWebOperation', N'Find users',        N'Pickers: active users by name / username / user group (photo, job)'),
    (N'dbo.APISilaWebOperation', N'My day',            N'My Day: the caller''s own reminders (dbo.SilaReminder) and ticket flags'),
    (N'dbo.APISilaWebOperation', N'Save reminder',     N'My Day: create / edit the caller''s reminder (links only to conversations he is in)'),
    (N'dbo.APISilaWebOperation', N'Reminder done',     N'My Day: mark the caller''s reminder done / not done (repeating: next date)'),
    (N'dbo.APISilaWebOperation', N'Delete reminder',   N'My Day: delete the caller''s reminder'),
    (N'dbo.APISilaWebOperation', N'My day count',      N'My Day: the rail badge, reminders and flags due today or earlier'),
    (N'dbo.APISilaWebOperation', N'User profile',      N'Profile card: one user''s job, department, mobile, extension, HR employee id (V_UserMaster_1)'),
    (N'dbo.APISilaWebOperation', N'User groups',       N'Pickers: user groups (quick, via V_SilaUserTitle) with their active user counts'),
    (N'dbo.APISilaWebOperation', N'Settings users',       N'System Settings (mhd only, checked in the SP): user master, read-only, no hash'),
    (N'dbo.APISilaWebOperation', N'Settings user groups', N'System Settings (mhd only, checked in the SP): dbo.UserGroupMaster, read-only'),
    (N'dbo.APISilaWebOperation', N'Settings channels',    N'System Settings (mhd only, checked in the SP): channel master, read-only'),
    (N'dbo.APISilaWebOperation', N'Settings channel',     N'System Settings (mhd only, checked in the SP): one channel''s details, members, tickets'),
    (N'dbo.APISilaWebOperation', N'Save channel purpose', N'System Settings (mhd only, checked in the SP): what a channel handles (dbo.SilaChannelPurpose)'),
    (N'dbo.APISilaWebOperation', N'Settings channel categories', N'System Settings (mhd only, checked in the SP): channel categories for the channel form'),
    (N'dbo.APISilaWebOperation', N'Save channel sla',      N'System Settings (mhd only, checked in the SP): a channel''s first-reply / finish targets'),
    (N'dbo.APISilaWebOperation', N'Save channel',          N'System Settings (mhd only, checked in the SP): create or edit a channel'),
    (N'dbo.APISilaWebOperation', N'Add channel members',   N'System Settings (mhd only, checked in the SP): add active users to a channel'),
    (N'dbo.APISilaWebOperation', N'Set channel member',    N'System Settings (mhd only, checked in the SP): a channel member''s admin / team leader roles'),
    (N'dbo.APISilaWebOperation', N'Remove channel member', N'System Settings (mhd only, checked in the SP): remove a channel member'),
    (N'dbo.APISilaWebOperation', N'Settings user group',   N'System Settings (mhd only, checked in the SP): one Sila user group and its users'),
    (N'dbo.APISilaWebOperation', N'Save user group',       N'System Settings (mhd only, checked in the SP): create or rename a Sila user group'),
    (N'dbo.APISilaWebOperation', N'Delete user group',     N'System Settings (mhd only, checked in the SP): delete an empty Sila user group'),
    (N'dbo.APISilaWebOperation', N'Set users group',       N'System Settings (mhd only, checked in the SP): move users into a Sila user group'),
    (N'dbo.APISilaWebOperation', N'Settings chat groups',  N'System Settings (mhd only, checked in the SP): group master -- chat groups with their type'),
    (N'dbo.APISilaWebOperation', N'Settings chat group',   N'System Settings (mhd only, checked in the SP): one chat group and its members'),
    (N'dbo.APISilaWebOperation', N'Save chat group',       N'System Settings (mhd only, checked in the SP): create / rename a chat group, normal or broadcast'),
    (N'dbo.APISilaWebOperation', N'Set chat group admin',  N'System Settings (mhd only, checked in the SP): a chat group member''s admin role'),
    (N'dbo.APISilaWebOperation', N'Create group',      N'Groups: create a group, the caller is creator + admin, posts a system line'),
    (N'dbo.APISilaWebOperation', N'Mark group read',   N'Groups: clear the caller''s unread rows for a group'),
    (N'dbo.APISilaWebOperation', N'Send group chat',   N'Groups: send a text message (members; locked groups: admins only)'),
    (N'dbo.APISilaWebOperation', N'Edit group chat',   N'Groups: edit the caller''s own message (new row, OrginalChatID)'),
    (N'dbo.APISilaWebOperation', N'Delete group chat', N'Groups: delete the caller''s own message (placeholder row)'),
    (N'dbo.APISilaWebOperation', N'Send chat file',       N'One-to-one: post a file the caller uploaded to this chat (Files API :7500)'),
    (N'dbo.APISilaWebOperation', N'Send group chat file', N'Groups: post a file the caller uploaded to this group (members; locked: admins)')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, N'[]', s.Notes, N'claude');
GO
