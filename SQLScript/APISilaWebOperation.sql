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
--   Find users       LineData { Search?, UserGroupID?, Top? (default 30; max 100, 300 with a group) }
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
                oj.JobName AS FromJobName, od.DepartmentName AS FromDepartmentName, op.FileURL AS FromPhotoURL,
                -- group
                a.GroupID, gm.Name AS GroupName,
                -- ticket
                a.TicketID, a.ChannelID, cm.Name AS ChannelName, a.TicketSubject, a.TicketState,
                ts.StateDescription AS TicketStateDescription, tc.FullName AS TicketCreatedBy,
                -- mail
                a.MailID, a.MailSubject, a.MailState, ms.StateDescription AS MailStateDescription,
                mc.FullName AS MailCreatedBy,
                -- task
                a.TaskID, a.TaskSubject, a.TaskState, ks.StateDescription AS TaskStateDescription
            FROM dbo.SilaHistory a
            LEFT JOIN dbo.UserMaster ou           ON ou.UserID = a.OtherUserID AND RTRIM(a.RecordType) = 'O'
            LEFT JOIN dbo.UserJobMaster oj        ON oj.JobID = ou.JobID
            LEFT JOIN dbo.UserDepartmentMaster od ON od.DepartmentID = ou.DepartmentID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = ou.AttachmentID AND ou.AttachmentID <> 0 ORDER BY x.ID DESC) op
            LEFT JOIN grp.GroupMaster gm          ON gm.GroupID = a.GroupID AND RTRIM(a.RecordType) = 'G'
            LEFT JOIN cha.ChannelMaster cm        ON cm.ChannelID = a.ChannelID AND RTRIM(a.RecordType) = 'C'
            LEFT JOIN cha.TicketState ts          ON ts.StateID = a.TicketState AND RTRIM(a.RecordType) = 'C'
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
                   oj.JobName AS OtherJobName, od.DepartmentName AS OtherDepartmentName, op.FileURL AS OtherPhotoURL
            FROM dbo.UserMaster ou
            LEFT JOIN dbo.UserJobMaster oj        ON oj.JobID = ou.JobID
            LEFT JOIN dbo.UserDepartmentMaster od ON od.DepartmentID = ou.DepartmentID
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
        IF @Operation IN (N'Group messages', N'Mark group read', N'Send group chat', N'Send group chat file', N'Group members', N'Lock group chat', N'Set group admin')
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
                   gp.FileURL AS GroupPhotoURL
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
            LEFT JOIN dbo.UserJobMaster fj     ON fj.JobID = fu.JobID
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

            SELECT gm.UserID, u.Username, u.FullName, j.JobName, d.DepartmentName, p.FileURL AS PhotoURL,
                   ISNULL(gm.IsAdmin, 0) AS IsAdmin,
                   CASE WHEN ISNULL(gm.IsCreated, 0) = 1 OR u.Username = @GCreatedBy THEN 1 ELSE 0 END AS IsCreator,
                   gm.CreatedDate AS JoinedDate,
                   CASE WHEN gm.UserID = @UserID THEN 1 ELSE 0 END AS IsMe
            FROM GRP.GroupMembers gm
            JOIN dbo.UserMaster u                ON u.UserID = gm.UserID
            LEFT JOIN dbo.UserJobMaster j        ON j.JobID = u.JobID
            LEFT JOIN dbo.UserDepartmentMaster d ON d.DepartmentID = u.DepartmentID
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
        -- Find users (read-only): active users for pickers (new group, new
        -- chat). Any signed-in user may search the directory, as the mobile
        -- app's 'System Users and Groups' already returns every user.
        -- -----------------------------------------------------------------
        IF @Operation = N'Find users'
        BEGIN
            -- Search matches name, username or user group (UserGroupMaster.GroupName);
            -- UserGroupID narrows to one user group (then up to 300, for "add all").
            DECLARE @FUSearch NVARCHAR(100) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Search'), N'')));
            DECLARE @FUGroup INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.UserGroupID') AS INT), 0);
            DECLARE @FUTop INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 30);
            IF @FUTop < 1 SET @FUTop = 1;
            IF @FUTop > CASE WHEN @FUGroup <> 0 THEN 300 ELSE 100 END SET @FUTop = CASE WHEN @FUGroup <> 0 THEN 300 ELSE 100 END;
            SELECT TOP (@FUTop) u.UserID, u.Username, u.FullName, j.JobName, d.DepartmentName, p.FileURL AS PhotoURL,
                   u.GroupID AS UserGroupID, ug.GroupName AS UserGroupName
            FROM dbo.UserMaster u
            LEFT JOIN dbo.UserGroupMaster ug     ON ug.GroupID = u.GroupID
            LEFT JOIN dbo.UserJobMaster j        ON j.JobID = u.JobID
            LEFT JOIN dbo.UserDepartmentMaster d ON d.DepartmentID = u.DepartmentID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
            WHERE u.IsNotActive = 0 AND u.UserID <> @UserID
              AND (@FUGroup = 0 OR u.GroupID = @FUGroup)
              AND (@FUSearch = N'' OR u.FullName LIKE N'%' + @FUSearch + N'%' OR u.Username LIKE N'%' + @FUSearch + N'%'
                   OR ug.GroupName LIKE N'%' + @FUSearch + N'%')
            ORDER BY CASE WHEN u.FullName LIKE @FUSearch + N'%' OR u.Username LIKE @FUSearch + N'%' THEN 0 ELSE 1 END, u.FullName;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- User groups (read-only): UserGroupMaster with how many active users
        -- (other than the caller) are in each -- the picker's filter list.
        -- -----------------------------------------------------------------
        IF @Operation = N'User groups'
        BEGIN
            SELECT ug.GroupID AS UserGroupID, ug.GroupName AS UserGroupName, COUNT(u.UserID) AS ActiveUsers
            FROM dbo.UserGroupMaster ug
            LEFT JOIN dbo.UserMaster u ON u.GroupID = ug.GroupID AND u.IsNotActive = 0 AND u.UserID <> @UserID
            GROUP BY ug.GroupID, ug.GroupName
            HAVING COUNT(u.UserID) > 0
            ORDER BY ug.GroupName;
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
            LEFT JOIN dbo.UserJobMaster fj     ON fj.JobID = fu.JobID
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
    (N'dbo.APISilaWebOperation', N'Find users',        N'Pickers: active users by name / username / user group (photo, job)'),
    (N'dbo.APISilaWebOperation', N'User groups',       N'Pickers: user groups (UserGroupMaster) with their active user counts'),
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
