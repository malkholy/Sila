USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [CHA].[APISilaWebTicketOperation] -- channels and tickets for the Sila web
-- app, called only through SilaApi /api/v2/exec. CHA.APITicketOperation stays
-- the mobile app's procedure; both work on the same tables, so a ticket looks
-- the same in either app.
--
-- Differences from CHA.APITicketOperation (on purpose):
--   * Every operation checks the caller (@User comes from the signed-in token):
--     tickets are read and changed by their members only; admins-only notes
--     (TicketChatHistory.IsAdmin = 1) are sent to ticket admins / team leaders
--     only; state changes, forwarding and member changes follow the role rules
--     below; messages are edited / deleted by their sender only.
--   * Admin / team-leader roles of new and invited members are copied from the
--     channel (ChannelMembers), never taken from the client.
--   * Multi-step changes (new ticket, forward, accept / reject / cancel a
--     forward) run in one transaction.
--   * The CHA.TicketMembers triggers handle one row per statement (TOP (1)):
--     after multi-row member changes this procedure cleans SilaHistory /
--     TicketUnreadChat for every row itself.
--   * TrgTicketChatHistoryafterInsertUpdate adds unread rows for every insert,
--     including edit / delete copies: those are removed here.
--   * No app-version result sets, no SPUserLog writes. UserSyncMaster only to
--     force the mobile app's full sync (ForceFullSync = 1) for everyone in a
--     ticket that is forwarded / accepted / rejected / cancelled here: those
--     add or delete whole tickets, which the app's MaxSeq delta never removes.
--     The app clears the flag itself ('Get Left Side Ticket').
--
-- Roles in a ticket (CHA.TicketMembers, IsLeft = 0):
--   member   any row          manager  IsAdmin = 1 or IsTeamLeader = 1
--   creator  IsCreatedBy = 1, or TicketHistory.CreatedByUser = the caller
--
-- Ticket states (CHA.TicketState): 0 New, 1 In Progress, 2 Forwarded,
--   3 Approve Waiting, 5 Hold, 10 End, 50 Close, 100 Archieved.
--
-- Operations (LineData JSON):
--   Channel list          -> channels the caller can see (public, or a member of a
--                            private one) with IsFavorite, IsMember, MyIsAdmin,
--                            MyIsTeamLeader, MyOpenTickets, MyUnread, and what it handles:
--                            Purpose, Examples, OfferInAssistant (dbo.SilaChannelPurpose).
--   Channel members       { ChannelID }  visible channels only.
--   Set channel favorite  { ChannelID, Favorite: 1|0 }
--   Ticket list           { ChannelID?: int, Closed?: 1, Since?: bigint }  the caller's tickets
--                            (open by default; Closed = 1: closed ones, newest 200).
--                            List1 = { Mark }: the watermark for the next call.
--                            Since = a previous Mark: ONLY the caller's tickets whose
--                            TicketHistory or own TicketMembers row changed after it
--                            (RowVer, SQLScript/TicketRowVersion.sql), in any state and
--                            with IsLeft, so the app can file / drop them; at most 2001
--                            rows (more = reload in full).
--   Ticket messages       { TicketID, BeforeChatID?, AfterChatID?, Top? (1-200, 50) }
--                            List0 = the ticket + the caller's role and allowed
--                            actions, List1 = messages newest first (SortID like groups),
--                            List2 = its state steps from the system lines (not on a page back).
--                            A forwarded copy waiting for approval (state 3) also lists the
--                            original ticket's messages (no admins-only notes), read-only.
--                            Read-only: opening a ticket does NOT mark it read.
--   Ticket members        { TicketID }
--   Ticket media          { TicketID }  files and messages with links (newest 500), for the
--                            details panel; the same visibility as Ticket messages.
--   Mark ticket read      { TicketID }
--   New ticket            { ChannelID, Subject, Text, Members: [ { UserID, IsCC } ], TempTicketID?,
--                            ExcludeAdmins?: [ UserID ] }  the channel's plain admins the
--                            creator left out (team leaders always join; one manager must stay)
--   Send ticket chat      { TicketID, Text, LocalChatID, ReplayMsgID?, AdminOnly?: 1, Html? }
--                            Html (also on New ticket / Edit ticket chat): formatted text,
--                            stored in TextStyle; Text stays plain.
--   Send ticket file      { TicketID, AttachmentID, LocalChatID, AdminOnly?: 1 }  post a file the
--                            caller uploaded to this ticket through the Files API (:7500)
--   Edit ticket chat      { ChatID, Text, LocalChatID }   own, non-system messages
--   Delete ticket chat    { ChatID, LocalChatID }
--   Change ticket state   { TicketID, Action: Start | Hold | End | Reopen | Close }
--   Forward ticket        { TicketID, ToChannelID, Members?: [ { UserID, IsCC } ] }
--   Answer forward        { TicketID (the forwarded copy), Accept: 1|0 }
--   Cancel forward        { TicketID (the original) }
--   Invite ticket members { TicketID, Members: [ { UserID, IsCC, IsAdmin? } ] }   any member until ended; IsAdmin from admins / TL only
--                            only; IsAdmin = 1 makes the invitee a ticket admin (else the channel's role)
--   Remove ticket member  { TicketID, UserID }   managers, or yourself (leave)
--   Leave ticket          { TicketID }   any member; not the last admin / team leader of an
--                            open ticket
--   Assign ticket / Take ticket / Unassign ticket  { TicketID, UserID (Assign) }  the ticket's
--                            owner (dbo.SilaTicketAssignment): managers assign anyone in it and
--                            take it while unassigned, the assignee or a manager
--                            unassigns. Rows / header carry AssignedUserID / AssignedName; the
--                            header also CanAssign / CanTake / CanUnassign.
--   Ticket report         { From?, To? }  per channel / per assignee times for the channels the
--                            caller manages (all for mhd); see the block. Every ticket row and
--                            the header also carry the SLA: FirstReplyDate, ReplyMinutes,
--                            ReplyTarget, ReplyState, FinishWorkMinutes, FinishTarget, FinishState
--                            (working minutes; states 0 no target, 1 on time, 2 due soon, 3 late).
--   Set ticket flag       { TicketID, Flagged: 1|0, DueDate?: 'yyyy-mm-dd', Note? }  the caller's
--                            own follow-up flag (dbo.SilaTicketFlag); lists, the header and
--                            the Home list return MyFlagged / MyFlagDue / MyFlagNote
--   Remove ended ticket   { TicketID }  an Ended (10) ticket leaves the caller's own Home
--                            list now instead of at night (dbo.SqlAgentDeleteEndedTicket):
--                            his SilaHistory row goes, and his phone reloads its list
--                            (UserSyncMaster.ForceFullSync = 1). Other members keep theirs.
-- Writes on a message return it (Ticket messages columns + TicketID); writes on
-- a ticket return the ticket row (Ticket list columns).
--
-- Gateway contract (SilaApi ParameterBinder): @Operation, @User (from the
-- token), @LineData (JSON object), @State INT OUTPUT, @Message OUTPUT.
-- Permission rows: the MERGE at the end of this script.
-- Idempotent: CREATE OR ALTER + MERGE. Deploy with deploy.sh or in SSMS.
-- =========================================================================
CREATE OR ALTER PROCEDURE [CHA].[APISilaWebTicketOperation]
    @Operation NVARCHAR(100),
    @User      NVARCHAR(250),
    @LineData  NVARCHAR(MAX) = N'',
    @State     INT           = 0  OUTPUT,
    @Message   NVARCHAR(500) = N'' OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET @State = 0;
    SET @Message = N'';

    BEGIN TRY
        IF ISJSON(@LineData) <> 1 SET @LineData = N'{}';

        DECLARE @UserID INT, @Inactive INT, @FullName NVARCHAR(MAX);
        SELECT @UserID = UserID, @Inactive = IsNotActive, @FullName = FullName FROM dbo.UserMaster WHERE Username = @User;
        IF @UserID IS NULL OR ISNULL(@Inactive, 1) <> 0
        BEGIN SET @State = 9; SET @Message = N'User is not active.'; RETURN; END
        DECLARE @Me NVARCHAR(MAX) = N'@' + ISNULL(NULLIF(@FullName, N''), @User);

        -- Formatted text (the composer's rich mode): LineData.Html is stored in
        -- TextStyle -- the column the mobile app's editor already fills with HTML --
        -- while Text keeps the plain text for previews, search and notifications.
        -- The web app sanitizes it before sending and again when showing it.
        DECLARE @WHtml NVARCHAR(MAX);
        SELECT @WHtml = NULLIF(LTRIM(RTRIM(Html)), N'') FROM OPENJSON(@LineData) WITH (Html NVARCHAR(MAX) '$.Html');
        IF @Operation LIKE N'Delete%' SET @WHtml = NULL;
        IF LEN(@WHtml) > 30000
        BEGIN SET @State = 1; SET @Message = N'The formatted message is too long.'; RETURN; END

        DECLARE @RetTicket INT = NULL, @RetChat INT = NULL;

        -- channels the caller can see: public ones, and private ones he belongs to
        DECLARE @Visible TABLE (ChannelID INT PRIMARY KEY);
        INSERT INTO @Visible (ChannelID)
        SELECT c.ChannelID FROM CHA.ChannelMaster c
        WHERE ISNULL(c.InActive, 0) = 0
          AND (LTRIM(RTRIM(ISNULL(c.IsPrivate, N'0'))) <> N'1'
               OR EXISTS (SELECT 1 FROM CHA.ChannelMembers m WHERE m.ChannelID = c.ChannelID AND m.UserID = @UserID));

        -- =================================================================
        -- CHANNELS
        -- =================================================================
        IF @Operation = N'Channel list'
        BEGIN
            SELECT c.ChannelID, c.Name, c.CategoryID, cc.CategoryDescription,
                   CASE WHEN LTRIM(RTRIM(ISNULL(c.IsPrivate, N'0'))) = N'1' THEN 1 ELSE 0 END AS IsPrivate,
                   CASE WHEN EXISTS (SELECT 1 FROM CHA.ChannelUserFavorite f WHERE f.ChannelID = c.ChannelID AND f.UserID = @UserID)
                        THEN 1 ELSE 0 END AS IsFavorite,
                   CASE WHEN cm.UserID IS NULL THEN 0 ELSE 1 END AS IsMember,
                   ISNULL(cm.IsAdmin, 0) AS MyIsAdmin, ISNULL(cm.IsTeamLeader, 0) AS MyIsTeamLeader,
                   ISNULL(t.OpenTickets, 0) AS MyOpenTickets, ISNULL(t.Unread, 0) AS MyUnread,
                   ISNULL(p.Purpose, N'') AS Purpose, ISNULL(p.Examples, N'') AS Examples,
                   CAST(ISNULL(p.OfferInAssistant, 0) AS INT) AS OfferInAssistant
            FROM CHA.ChannelMaster c
            JOIN @Visible v ON v.ChannelID = c.ChannelID
            LEFT JOIN dbo.SilaChannelPurpose p ON p.ChannelID = c.ChannelID
            LEFT JOIN CHA.ChannelCategory cc ON cc.ChannelCategoryID = c.CategoryID
            LEFT JOIN CHA.ChannelMembers cm  ON cm.ChannelID = c.ChannelID AND cm.UserID = @UserID
            OUTER APPLY (SELECT COUNT(*) AS OpenTickets, SUM(tm.UnreadCount) AS Unread
                         FROM CHA.TicketMembers tm JOIN CHA.TicketHistory th ON th.TicketID = tm.TicketID
                         WHERE tm.UserID = @UserID AND tm.IsLeft = 0 AND th.TicketChannelID = c.ChannelID
                           AND th.TicketState < 50) t
            ORDER BY cc.CategoryDescription, c.Name;
            RETURN;
        END

        IF @Operation IN (N'Channel members', N'Set channel favorite')
        BEGIN
            DECLARE @CChannel INT = TRY_CAST(JSON_VALUE(@LineData, '$.ChannelID') AS INT);
            IF NOT EXISTS (SELECT 1 FROM @Visible WHERE ChannelID = @CChannel)
            BEGIN SET @State = 403; SET @Message = N'Channel not found.'; RETURN; END

            IF @Operation = N'Channel members'
            BEGIN
                SELECT m.UserID, u.Username, u.FullName, j.JobName, j.DepartmentName, p.FileURL AS PhotoURL,
                       m.IsAdmin, m.IsTeamLeader
                FROM CHA.ChannelMembers m
                JOIN dbo.UserMaster u                ON u.UserID = m.UserID AND u.IsNotActive = 0
                LEFT JOIN dbo.V_SilaUserTitle j        ON j.UserID = u.UserID
                OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                             WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
                WHERE m.ChannelID = @CChannel
                ORDER BY m.IsAdmin DESC, m.IsTeamLeader DESC, u.FullName;
                RETURN;
            END

            DECLARE @CFav INT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Favorite') AS INT) = 1 THEN 1 ELSE 0 END;
            DELETE FROM CHA.ChannelUserFavorite WHERE ChannelID = @CChannel AND UserID = @UserID;
            IF @CFav = 1 INSERT INTO CHA.ChannelUserFavorite (ChannelID, UserID) VALUES (@CChannel, @UserID);
            SELECT @CChannel AS ChannelID, @CFav AS IsFavorite;
            RETURN;
        END

        -- =================================================================
        -- TICKET LIST
        -- =================================================================
        IF @Operation = N'Ticket list'
        BEGIN
            DECLARE @LChannel INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.ChannelID') AS INT), 0);
            DECLARE @LClosed INT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Closed') AS INT) = 1 THEN 1 ELSE 0 END;
            DECLARE @LSince BIGINT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Since') AS BIGINT), 0);
            -- the watermark, taken FIRST: every change below MIN_ACTIVE_ROWVERSION() is
            -- committed, so the next call (RowVer > Mark) misses nothing still being saved
            DECLARE @LMark BIGINT = CAST(MIN_ACTIVE_ROWVERSION() AS BIGINT) - 1;

            IF @LSince > 0
            BEGIN
                -- changed tickets (any member's change, state, last message ...) plus the
                -- caller's own member rows (unread count, left, roles); both seek an index
                DECLARE @LChanged TABLE (TicketID INT PRIMARY KEY);
                INSERT INTO @LChanged (TicketID)
                SELECT th.TicketID FROM CHA.TicketHistory th WHERE th.RowVer > CAST(@LSince AS BINARY(8))
                UNION
                SELECT tm.TicketID FROM CHA.TicketMembers tm WHERE tm.UserID = @UserID AND tm.RowVer > CAST(@LSince AS BINARY(8));

                SELECT TOP (2001)
                       th.TicketID, th.TicketSubject, th.TicketState, ts.StateDescription, th.TicketChannelID AS ChannelID,
                       c.Name AS ChannelName, th.CreatedDate, th.CreatedByUser, cu.FullName AS CreatedByName,
                       th.LastMessage, th.LastChatID, th.LastMaintDate, th.StartDate, th.EndedDate, th.ClosedDate,
                       th.OrginalTicketID, th.OrginalChannelID, oc.Name AS OrginalChannelName,
                       tm.UnreadCount AS Unread, tm.IsMuted, tm.IsAdmin AS MyIsAdmin, tm.IsTeamLeader AS MyIsTeamLeader,
                       CASE WHEN tm.IsCreatedBy = 1 OR th.CreatedByUser = @User THEN 1 ELSE 0 END AS MyIsCreator,
                       tm.IsLeft,
                       CASE WHEN tf.TicketID IS NULL THEN 0 ELSE 1 END AS MyFlagged, tf.DueDate AS MyFlagDue, tf.Note AS MyFlagNote,
                   ta.UserID AS AssignedUserID, au.Username AS AssignedUsername, ISNULL(NULLIF(au.FullName, N''), au.Username) AS AssignedName,
                   sla.FirstReplyDate, sla.ReplyMinutes, sla.ReplyTarget, sla.ReplyState,
                   sla.FinishMinutes AS FinishWorkMinutes, sla.FinishTarget, sla.FinishState
                FROM @LChanged x
                JOIN CHA.TicketHistory th        ON th.TicketID = x.TicketID
                LEFT JOIN dbo.SilaTicketFlag tf  ON tf.TicketID = th.TicketID AND tf.UserID = @UserID
            LEFT JOIN dbo.SilaTicketAssignment ta ON ta.TicketID = th.TicketID
            LEFT JOIN dbo.UserMaster au      ON au.UserID = ta.UserID
            OUTER APPLY dbo.fnSilaTicketSla(th.TicketID) sla
                -- one member row per ticket (an active one first)
                CROSS APPLY (SELECT TOP (1) m.UnreadCount, m.IsMuted, m.IsAdmin, m.IsTeamLeader, m.IsCreatedBy, m.IsLeft
                             FROM CHA.TicketMembers m WHERE m.TicketID = th.TicketID AND m.UserID = @UserID
                             ORDER BY m.IsLeft, m.ID DESC) tm
                LEFT JOIN CHA.TicketState ts     ON ts.StateID = th.TicketState
                LEFT JOIN CHA.ChannelMaster c    ON c.ChannelID = th.TicketChannelID
                LEFT JOIN CHA.ChannelMaster oc   ON oc.ChannelID = th.OrginalChannelID AND th.OrginalChannelID <> 0
                LEFT JOIN dbo.UserMaster cu      ON cu.Username = th.CreatedByUser
                ORDER BY th.LastMaintDate DESC;
                SELECT @LMark AS Mark;
                RETURN;
            END

            SELECT TOP (CASE WHEN @LClosed = 1 THEN 200 ELSE 2000 END)
                   th.TicketID, th.TicketSubject, th.TicketState, ts.StateDescription, th.TicketChannelID AS ChannelID,
                   c.Name AS ChannelName, th.CreatedDate, th.CreatedByUser, cu.FullName AS CreatedByName,
                   th.LastMessage, th.LastChatID, th.LastMaintDate, th.StartDate, th.EndedDate, th.ClosedDate,
                   th.OrginalTicketID, th.OrginalChannelID, oc.Name AS OrginalChannelName,
                   tm.UnreadCount AS Unread, tm.IsMuted, tm.IsAdmin AS MyIsAdmin, tm.IsTeamLeader AS MyIsTeamLeader,
                   CASE WHEN tm.IsCreatedBy = 1 OR th.CreatedByUser = @User THEN 1 ELSE 0 END AS MyIsCreator,
                   CASE WHEN tf.TicketID IS NULL THEN 0 ELSE 1 END AS MyFlagged, tf.DueDate AS MyFlagDue, tf.Note AS MyFlagNote,
                   ta.UserID AS AssignedUserID, au.Username AS AssignedUsername, ISNULL(NULLIF(au.FullName, N''), au.Username) AS AssignedName,
                   sla.FirstReplyDate, sla.ReplyMinutes, sla.ReplyTarget, sla.ReplyState,
                   sla.FinishMinutes AS FinishWorkMinutes, sla.FinishTarget, sla.FinishState
            FROM CHA.TicketMembers tm
            JOIN CHA.TicketHistory th        ON th.TicketID = tm.TicketID
            LEFT JOIN dbo.SilaTicketFlag tf  ON tf.TicketID = th.TicketID AND tf.UserID = @UserID
            LEFT JOIN dbo.SilaTicketAssignment ta ON ta.TicketID = th.TicketID
            LEFT JOIN dbo.UserMaster au      ON au.UserID = ta.UserID
            OUTER APPLY dbo.fnSilaTicketSla(th.TicketID) sla
            LEFT JOIN CHA.TicketState ts     ON ts.StateID = th.TicketState
            LEFT JOIN CHA.ChannelMaster c    ON c.ChannelID = th.TicketChannelID
            LEFT JOIN CHA.ChannelMaster oc   ON oc.ChannelID = th.OrginalChannelID AND th.OrginalChannelID <> 0
            LEFT JOIN dbo.UserMaster cu      ON cu.Username = th.CreatedByUser
            WHERE tm.UserID = @UserID AND tm.IsLeft = 0
              AND (@LChannel = 0 OR th.TicketChannelID = @LChannel)
              AND ((@LClosed = 0 AND th.TicketState < 50) OR (@LClosed = 1 AND th.TicketState = 50))
            ORDER BY th.LastMaintDate DESC;
            SELECT @LMark AS Mark;
            RETURN;
        END

        -- =================================================================
        -- NEW TICKET
        -- =================================================================
        IF @Operation = N'New ticket'
        BEGIN
            DECLARE @NChannel INT, @NSubject NVARCHAR(MAX), @NText NVARCHAR(MAX), @NTemp INT;
            SELECT @NChannel = ChannelID, @NSubject = Subject, @NText = [Text], @NTemp = TempTicketID
            FROM OPENJSON(@LineData) WITH (ChannelID INT '$.ChannelID', Subject NVARCHAR(MAX) '$.Subject',
                 [Text] NVARCHAR(MAX) '$.Text', TempTicketID INT '$.TempTicketID');
            SET @NSubject = LTRIM(RTRIM(ISNULL(@NSubject, N'')));
            SET @NText = LTRIM(RTRIM(ISNULL(@NText, N'')));
            IF NOT EXISTS (SELECT 1 FROM @Visible WHERE ChannelID = @NChannel)
            BEGIN SET @State = 403; SET @Message = N'Channel not found.'; RETURN; END
            IF @NSubject = N'' BEGIN SET @State = 1; SET @Message = N'Give the ticket a subject.'; RETURN; END
            IF LEN(@NSubject) > 300 BEGIN SET @State = 1; SET @Message = N'The subject can be at most 300 characters.'; RETURN; END
            IF @NText = N'' BEGIN SET @State = 1; SET @Message = N'Describe the request.'; RETURN; END
            IF LEN(@NText) > 10000 BEGIN SET @State = 1; SET @Message = N'The description is too long.'; RETURN; END

            -- a retried request (same TempTicketID from this user) returns the ticket already created
            IF ISNULL(@NTemp, 0) <> 0
                SELECT @RetTicket = TicketID FROM CHA.TicketHistory WHERE TempTicketID = @NTemp AND CreatedByUser = @User;

            IF @RetTicket IS NULL
            BEGIN
                -- members: the listed active users + the channel's admins / team leaders + the creator;
                -- roles come from the channel, never from the client
                DECLARE @NMembers TABLE (UserID INT PRIMARY KEY, IsAdmin INT, IsTeamLeader INT, IsCreatedBy INT, IsCC INT);
                INSERT INTO @NMembers (UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC)
                SELECT x.UserID, ISNULL(MAX(cm.IsAdmin), 0), ISNULL(MAX(cm.IsTeamLeader), 0), 0,
                       MAX(CASE WHEN x.IsCC = 1 THEN 1 ELSE 0 END)
                FROM OPENJSON(@LineData, '$.Members') WITH (UserID INT '$.UserID', IsCC INT '$.IsCC') x
                JOIN dbo.UserMaster u ON u.UserID = x.UserID AND u.IsNotActive = 0
                LEFT JOIN CHA.ChannelMembers cm ON cm.ChannelID = @NChannel AND cm.UserID = x.UserID
                WHERE x.UserID <> @UserID
                GROUP BY x.UserID;
                -- ExcludeAdmins: channel admins the creator took off this ticket. Only a plain
                -- admin can be left out; a team leader (admin or not) always joins.
                INSERT INTO @NMembers (UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC)
                SELECT cm.UserID, cm.IsAdmin, cm.IsTeamLeader, 0, 0
                FROM CHA.ChannelMembers cm JOIN dbo.UserMaster u ON u.UserID = cm.UserID AND u.IsNotActive = 0
                WHERE cm.ChannelID = @NChannel AND (cm.IsAdmin = 1 OR cm.IsTeamLeader = 1) AND cm.UserID <> @UserID
                  AND NOT EXISTS (SELECT 1 FROM @NMembers n WHERE n.UserID = cm.UserID)
                  AND NOT (ISNULL(cm.IsTeamLeader, 0) = 0
                           AND cm.UserID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@LineData, '$.ExcludeAdmins')
                                            WHERE TRY_CAST([value] AS INT) IS NOT NULL));
                INSERT INTO @NMembers (UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC)
                SELECT @UserID, ISNULL(cm.IsAdmin, 0), ISNULL(cm.IsTeamLeader, 0), 1, 0
                FROM (SELECT 1 AS one) z LEFT JOIN CHA.ChannelMembers cm ON cm.ChannelID = @NChannel AND cm.UserID = @UserID;
                IF (SELECT COUNT(*) FROM @NMembers) > 300
                BEGIN SET @State = 1; SET @Message = N'A ticket can have at most 300 members.'; RETURN; END
                -- someone has to be able to pick it up: an admin or team leader stays on every ticket
                IF EXISTS (SELECT 1 FROM CHA.ChannelMembers cm WHERE cm.ChannelID = @NChannel AND (cm.IsAdmin = 1 OR cm.IsTeamLeader = 1))
                   AND NOT EXISTS (SELECT 1 FROM @NMembers WHERE IsAdmin = 1 OR IsTeamLeader = 1)
                BEGIN SET @State = 1; SET @Message = N'Keep at least one admin or team leader on the ticket.'; RETURN; END

                BEGIN TRANSACTION;
                SET @RetTicket = NEXT VALUE FOR dbo.TicketID;
                INSERT INTO CHA.TicketHistory
                    (TicketID, TicketSubject, TicketChannelID, CreatedDate, CreatedByUser, LastMaintDate, LastMaintByUser, TempTicketID)
                VALUES (@RetTicket, @NSubject, @NChannel, GETDATE(), @User, GETDATE(), @User, ISNULL(@NTemp, 0));
                -- the insert trigger adds each member's SilaHistory 'C' row (set-based) and the Members list
                INSERT INTO CHA.TicketMembers (ChannelID, TicketID, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, IsMuted, IsInvited)
                SELECT @NChannel, @RetTicket, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, 0, 0 FROM @NMembers;
                -- the request itself is the first message (the message trigger fills LastMessage / unread)
                DECLARE @NChat INT = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO CHA.TicketChatHistory
                    (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
                VALUES (@NChat, @NChannel, @RetTicket, @UserID, @User, @NText,
                        ISNULL(@WHtml, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@NText, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'),
                                NCHAR(13) + NCHAR(10), N'<br>'), NCHAR(10), N'<br>')),
                        0, 0, @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 0, 0);
                COMMIT TRANSACTION;
            END
        END

        -- =================================================================
        -- TICKET REPORT { From?: 'yyyy-mm-dd', To?: 'yyyy-mm-dd' } (default: the
        -- last 30 days; at most a year). The channels the caller manages (admin
        -- or team leader in CHA.ChannelMembers) -- every channel for mhd. Times
        -- are WORKING minutes (dbo.fnSilaTicketSla, SQLScript/SilaSla.sql).
        --   List0 per channel: opened / finished in the period, open now, late now
        --         (no reply / not finished past the target), average first reply and
        --         finish, share on time, the targets.
        --   List1 per person (the tickets' assignees): open, late now, finished in
        --         the period, average finish.
        --   List2 { From, To, Channels }.
        -- =================================================================
        IF @Operation = N'Ticket report'
        BEGIN
            DECLARE @RpFrom DATE = TRY_CONVERT(DATE, JSON_VALUE(@LineData, '$.From'), 23);
            DECLARE @RpTo DATE = TRY_CONVERT(DATE, JSON_VALUE(@LineData, '$.To'), 23);
            IF @RpTo IS NULL SET @RpTo = CAST(GETDATE() AS DATE);
            IF @RpFrom IS NULL OR @RpFrom > @RpTo SET @RpFrom = DATEADD(DAY, -29, @RpTo);
            IF DATEDIFF(DAY, @RpFrom, @RpTo) > 366 SET @RpFrom = DATEADD(DAY, -366, @RpTo);
            DECLARE @RpEnd DATETIME = DATEADD(DAY, 1, CAST(@RpTo AS DATETIME));

            DECLARE @RpChannels TABLE (ChannelID INT PRIMARY KEY);
            INSERT INTO @RpChannels (ChannelID)
            SELECT c.ChannelID FROM CHA.ChannelMaster c
            WHERE LOWER(@User) = N'mhd'
               OR EXISTS (SELECT 1 FROM CHA.ChannelMembers m WHERE m.ChannelID = c.ChannelID AND m.UserID = @UserID
                          AND (m.IsAdmin = 1 OR m.IsTeamLeader = 1));
            IF NOT EXISTS (SELECT 1 FROM @RpChannels)
            BEGIN SET @State = 403; SET @Message = N'Reports are for channel admins and team leaders.'; RETURN; END

            -- the tickets that count: opened or finished in the period, or open now
            DECLARE @Rp TABLE (TicketID INT PRIMARY KEY, ChannelID INT, CreatedDate DATETIME, TicketState INT,
                               FirstReplyDate DATETIME, FinishDate DATETIME, ReplyMinutes INT, FinishMinutes INT,
                               ReplyTarget INT, FinishTarget INT, ReplyState INT, FinishState INT, AssignedUserID INT);
            INSERT INTO @Rp
            SELECT th.TicketID, th.TicketChannelID, th.CreatedDate, th.TicketState, x.FirstReplyDate, x.FinishDate,
                   x.ReplyMinutes, x.FinishMinutes, x.ReplyTarget, x.FinishTarget, x.ReplyState, x.FinishState, ta.UserID
            FROM CHA.TicketHistory th
            JOIN @RpChannels rc ON rc.ChannelID = th.TicketChannelID
            CROSS APPLY dbo.fnSilaTicketSla(th.TicketID) x
            LEFT JOIN dbo.SilaTicketAssignment ta ON ta.TicketID = th.TicketID
            WHERE th.TicketState NOT IN (2, 3)
              AND ((th.CreatedDate >= @RpFrom AND th.CreatedDate < @RpEnd)
                   OR th.TicketState < 10
                   OR (x.FinishDate >= @RpFrom AND x.FinishDate < @RpEnd));

            SELECT c.ChannelID, c.Name AS ChannelName, s.FirstReplyMinutes AS ReplyTarget, s.FinishMinutes AS FinishTarget,
                   SUM(CASE WHEN r.CreatedDate >= @RpFrom AND r.CreatedDate < @RpEnd THEN 1 ELSE 0 END) AS Opened,
                   SUM(CASE WHEN r.FinishDate >= @RpFrom AND r.FinishDate < @RpEnd THEN 1 ELSE 0 END) AS Finished,
                   SUM(CASE WHEN r.TicketState < 10 THEN 1 ELSE 0 END) AS OpenNow,
                   SUM(CASE WHEN r.TicketState < 10 AND r.FirstReplyDate IS NULL AND r.ReplyState = 3 THEN 1 ELSE 0 END) AS NoReplyLate,
                   SUM(CASE WHEN r.TicketState < 10 AND r.FinishState = 3 THEN 1 ELSE 0 END) AS FinishLate,
                   AVG(CASE WHEN r.CreatedDate >= @RpFrom AND r.CreatedDate < @RpEnd AND r.FirstReplyDate IS NOT NULL THEN r.ReplyMinutes END) AS AvgReplyMinutes,
                   AVG(CASE WHEN r.FinishDate >= @RpFrom AND r.FinishDate < @RpEnd THEN r.FinishMinutes END) AS AvgFinishMinutes,
                   SUM(CASE WHEN r.CreatedDate >= @RpFrom AND r.CreatedDate < @RpEnd AND r.FirstReplyDate IS NOT NULL AND r.ReplyTarget IS NOT NULL THEN 1 ELSE 0 END) AS ReplyMeasured,
                   SUM(CASE WHEN r.CreatedDate >= @RpFrom AND r.CreatedDate < @RpEnd AND r.FirstReplyDate IS NOT NULL AND r.ReplyTarget IS NOT NULL AND r.ReplyMinutes <= r.ReplyTarget THEN 1 ELSE 0 END) AS ReplyOnTime,
                   SUM(CASE WHEN r.FinishDate >= @RpFrom AND r.FinishDate < @RpEnd AND r.FinishTarget IS NOT NULL THEN 1 ELSE 0 END) AS FinishMeasured,
                   SUM(CASE WHEN r.FinishDate >= @RpFrom AND r.FinishDate < @RpEnd AND r.FinishTarget IS NOT NULL AND r.FinishMinutes <= r.FinishTarget THEN 1 ELSE 0 END) AS FinishOnTime
            FROM @RpChannels rc
            JOIN CHA.ChannelMaster c ON c.ChannelID = rc.ChannelID
            LEFT JOIN dbo.SilaChannelSla s ON s.ChannelID = c.ChannelID
            LEFT JOIN @Rp r ON r.ChannelID = c.ChannelID
            WHERE ISNULL(c.InActive, 0) = 0 OR r.TicketID IS NOT NULL
            GROUP BY c.ChannelID, c.Name, s.FirstReplyMinutes, s.FinishMinutes
            HAVING COUNT(r.TicketID) > 0
            ORDER BY SUM(CASE WHEN r.TicketState < 10 AND r.FinishState = 3 THEN 1 ELSE 0 END) DESC, c.Name;

            SELECT u.UserID, u.Username, ISNULL(NULLIF(u.FullName, N''), u.Username) AS FullName, p.FileURL AS PhotoURL,
                   SUM(CASE WHEN r.TicketState < 10 THEN 1 ELSE 0 END) AS OpenNow,
                   SUM(CASE WHEN r.TicketState < 10 AND r.FinishState = 3 THEN 1 ELSE 0 END) AS LateNow,
                   SUM(CASE WHEN r.FinishDate >= @RpFrom AND r.FinishDate < @RpEnd THEN 1 ELSE 0 END) AS Finished,
                   AVG(CASE WHEN r.FinishDate >= @RpFrom AND r.FinishDate < @RpEnd THEN r.FinishMinutes END) AS AvgFinishMinutes
            FROM @Rp r
            JOIN dbo.UserMaster u ON u.UserID = r.AssignedUserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
            GROUP BY u.UserID, u.Username, u.FullName, p.FileURL
            ORDER BY SUM(CASE WHEN r.TicketState < 10 AND r.FinishState = 3 THEN 1 ELSE 0 END) DESC, u.FullName;

            SELECT @RpFrom AS [From], @RpTo AS [To], (SELECT COUNT(*) FROM @RpChannels) AS Channels;
            RETURN;
        END

        -- =================================================================
        -- EVERYTHING ON ONE TICKET: the ticket and the caller's role in it
        -- =================================================================
        DECLARE @TicketID INT, @TState INT, @TChannel INT, @TCreatedBy NVARCHAR(50), @TOrig INT, @TOrigChannel INT,
                @TForwardBy NVARCHAR(50), @TIsManager INT, @TIsCreator INT, @TIsMember INT = 0, @TIsCC INT = 0;
        IF @Operation IN (N'Ticket messages', N'Ticket members', N'Ticket media', N'Mark ticket read', N'Send ticket chat', N'Send ticket file',
                          N'Change ticket state', N'Forward ticket', N'Answer forward', N'Cancel forward',
                          N'Invite ticket members', N'Remove ticket member', N'Leave ticket', N'Set ticket flag',
                          N'Remove ended ticket', N'Assign ticket', N'Take ticket', N'Unassign ticket')
        BEGIN
            SET @TicketID = TRY_CAST(JSON_VALUE(@LineData, '$.TicketID') AS INT);
            SELECT @TState = th.TicketState, @TChannel = th.TicketChannelID, @TCreatedBy = th.CreatedByUser,
                   @TOrig = th.OrginalTicketID, @TOrigChannel = th.OrginalChannelID, @TForwardBy = th.ForwardBy,
                   @TIsMember = 1,
                   @TIsManager = CASE WHEN tm.IsAdmin = 1 OR tm.IsTeamLeader = 1 THEN 1 ELSE 0 END,
                   @TIsCreator = CASE WHEN tm.IsCreatedBy = 1 OR th.CreatedByUser = @User THEN 1 ELSE 0 END,
                   @TIsCC = CASE WHEN tm.IsCC = 1 THEN 1 ELSE 0 END
            FROM CHA.TicketHistory th
            JOIN CHA.TicketMembers tm ON tm.TicketID = th.TicketID AND tm.UserID = @UserID AND tm.IsLeft = 0
            WHERE th.TicketID = @TicketID;
            IF @TIsMember = 0
            BEGIN SET @State = 403; SET @Message = N'Ticket not found.'; RETURN; END
        END
        DECLARE @SyncUsers TABLE (UserID INT PRIMARY KEY);   -- forward / answer / cancel: whose phone resyncs

        -- -----------------------------------------------------------------
        -- Set ticket flag: the caller's own follow-up flag (dbo.SilaTicketFlag),
        -- private to him. Flagged = 0 clears it. DueDate (yyyy-mm-dd) and Note
        -- (at most 300 characters) are optional.
        -- -----------------------------------------------------------------
        IF @Operation = N'Set ticket flag'
        BEGIN
            DECLARE @FgOn INT, @FgDue NVARCHAR(30), @FgNote NVARCHAR(MAX);
            SELECT @FgOn = CASE WHEN Flagged = 0 THEN 0 ELSE 1 END, @FgDue = NULLIF(LTRIM(RTRIM(DueDate)), N''),
                   @FgNote = LTRIM(RTRIM(ISNULL(Note, N'')))
            FROM OPENJSON(@LineData) WITH (Flagged INT '$.Flagged', DueDate NVARCHAR(30) '$.DueDate', Note NVARCHAR(MAX) '$.Note');
            IF @FgDue IS NOT NULL AND TRY_CONVERT(DATE, @FgDue, 23) IS NULL
            BEGIN SET @State = 1; SET @Message = N'The due date is not valid.'; RETURN; END
            IF LEN(@FgNote) > 300
            BEGIN SET @State = 1; SET @Message = N'The note can be at most 300 characters.'; RETURN; END
            IF @FgOn = 0
                DELETE FROM dbo.SilaTicketFlag WHERE TicketID = @TicketID AND UserID = @UserID;
            ELSE
            BEGIN
                UPDATE dbo.SilaTicketFlag SET DueDate = TRY_CONVERT(DATE, @FgDue, 23), Note = @FgNote, LastMaintDate = GETDATE()
                WHERE TicketID = @TicketID AND UserID = @UserID;
                IF @@ROWCOUNT = 0
                    INSERT INTO dbo.SilaTicketFlag (TicketID, UserID, DueDate, Note) VALUES (@TicketID, @UserID, TRY_CONVERT(DATE, @FgDue, 23), @FgNote);
            END
            SELECT @TicketID AS TicketID, CASE WHEN f.TicketID IS NULL THEN 0 ELSE 1 END AS MyFlagged, f.DueDate AS MyFlagDue, f.Note AS MyFlagNote
            FROM (SELECT 1 AS one) z LEFT JOIN dbo.SilaTicketFlag f ON f.TicketID = @TicketID AND f.UserID = @UserID;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Remove ended ticket: the caller's own Home row of an Ended ticket (the
        -- nightly dbo.SqlAgentDeleteEndedTicket does this for everyone). The
        -- ticket itself is untouched; the phone's MaxSeq delta never drops a
        -- deleted row, so it is told to reload in full.
        -- -----------------------------------------------------------------
        IF @Operation = N'Remove ended ticket'
        BEGIN
            IF @TState <> 10
            BEGIN SET @State = 1; SET @Message = N'Only an ended ticket can be removed from Home.'; RETURN; END
            DELETE FROM dbo.SilaHistory WHERE TicketID = @TicketID AND RecordType = 'C' AND UserID = @UserID;
            DECLARE @RmRemoved INT = @@ROWCOUNT;
            UPDATE dbo.UserSyncMaster SET ForceFullSync = 1 WHERE UserID = @UserID;
            SELECT @TicketID AS TicketID, @RmRemoved AS Removed;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Assignment (dbo.SilaTicketAssignment): who owns the ticket.
        --   Assign ticket   { TicketID, UserID }  admins / team leaders; anyone in the ticket
        --   Take ticket     { TicketID }          admins / team leaders, while nobody has it
        --   Unassign ticket { TicketID }          the assignee or a manager
        -- Open tickets only (state < 50). A system line each time; returns the ticket row.
        -- -----------------------------------------------------------------
        IF @Operation IN (N'Assign ticket', N'Take ticket', N'Unassign ticket')
        BEGIN
            IF @TState >= 50
            BEGIN SET @State = 1; SET @Message = N'This ticket is closed.'; RETURN; END
            DECLARE @AsCurrent INT = (SELECT UserID FROM dbo.SilaTicketAssignment WHERE TicketID = @TicketID);
            DECLARE @AsTarget INT, @AsName NVARCHAR(MAX), @AsText NVARCHAR(MAX), @AsSame INT = 0;
            IF @Operation = N'Assign ticket'
            BEGIN
                IF @TIsManager = 0
                BEGIN SET @State = 403; SET @Message = N'Only ticket admins and team leaders can assign a ticket.'; RETURN; END
                SET @AsTarget = TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT);
            END
            ELSE IF @Operation = N'Take ticket'
            BEGIN
                IF @TIsManager = 0
                BEGIN SET @State = 403; SET @Message = N'Only ticket admins and team leaders can take a ticket.'; RETURN; END
                IF @AsCurrent IS NOT NULL AND @AsCurrent <> @UserID
                BEGIN SET @State = 1; SET @Message = N'Someone already has this ticket.'; RETURN; END
                SET @AsTarget = @UserID;
            END
            ELSE
            BEGIN
                IF @AsCurrent IS NULL
                BEGIN SET @State = 1; SET @Message = N'Nobody has this ticket.'; RETURN; END
                IF @TIsManager = 0 AND @AsCurrent <> @UserID
                BEGIN SET @State = 403; SET @Message = N'Only the assignee or a ticket admin / team leader can unassign it.'; RETURN; END
            END

            IF @Operation <> N'Unassign ticket'
            BEGIN
                SELECT @AsName = ISNULL(NULLIF(u.FullName, N''), u.Username)
                FROM CHA.TicketMembers tm JOIN dbo.UserMaster u ON u.UserID = tm.UserID AND u.IsNotActive = 0
                WHERE tm.TicketID = @TicketID AND tm.UserID = @AsTarget AND tm.IsLeft = 0;
                IF @AsName IS NULL
                BEGIN SET @State = 1; SET @Message = N'Only someone in the ticket can be assigned.'; RETURN; END
                IF @AsCurrent = @AsTarget SET @AsSame = 1;   -- already his: nothing to change
                SET @AsText = CASE WHEN @AsTarget = @UserID THEN @Me + N' took this ticket'
                                   ELSE @Me + N' assigned this ticket to @' + @AsName END;
            END
            ELSE
                SET @AsText = @Me + N' unassigned this ticket ('
                              + ISNULL((SELECT N'@' + ISNULL(NULLIF(FullName, N''), Username) FROM dbo.UserMaster WHERE UserID = @AsCurrent), N'') + N')';

            IF @AsSame = 0
            BEGIN
            BEGIN TRANSACTION;
            IF @Operation = N'Unassign ticket'
                DELETE FROM dbo.SilaTicketAssignment WHERE TicketID = @TicketID;
            ELSE
            BEGIN
                UPDATE dbo.SilaTicketAssignment SET UserID = @AsTarget, AssignedBy = @User, AssignedDate = GETDATE() WHERE TicketID = @TicketID;
                IF @@ROWCOUNT = 0
                    INSERT INTO dbo.SilaTicketAssignment (TicketID, UserID, AssignedBy) VALUES (@TicketID, @AsTarget, @User);
            END
            DECLARE @AsChat INT = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO CHA.TicketChatHistory
                (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
            VALUES (@AsChat, @TChannel, @TicketID, @UserID, @User, @AsText, @AsText, 0, 0,
                    @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);
            UPDATE CHA.TicketHistory SET LastMaintDate = GETDATE(), LastMaintByUser = @User WHERE TicketID = @TicketID;
            COMMIT TRANSACTION;
            END
            SET @RetTicket = @TicketID;
        END

        -- -----------------------------------------------------------------
        -- Ticket messages (read-only)
        -- -----------------------------------------------------------------
        IF @Operation = N'Ticket messages'
        BEGIN
            DECLARE @MBefore INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.BeforeChatID') AS INT), 0);
            DECLARE @MAfter INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.AfterChatID') AS INT), 0);
            DECLARE @MTop INT = ISNULL(TRY_CAST(JSON_VALUE(@LineData, '$.Top') AS INT), 50);
            IF @MTop < 1 SET @MTop = 1;
            IF @MTop > 200 SET @MTop = 200;
            -- a forwarded copy waiting for approval (state 3): its managers also read the
            -- original ticket's conversation (no admins-only notes -- those stay behind on
            -- Accept too), so they can decide. Read-only: nothing is marked read there.
            DECLARE @MOrig INT = CASE WHEN @TState = 3 AND ISNULL(@TOrig, 0) > 0 THEN @TOrig ELSE 0 END;

            SELECT th.TicketID, th.TicketSubject, th.TicketState, ts.StateDescription, th.TicketChannelID AS ChannelID,
                   c.Name AS ChannelName, c.CategoryID, th.CreatedDate, th.CreatedByUser, cu.FullName AS CreatedByName,
                   cj.JobName AS CreatedByJobName,
                   th.StartDate, th.StartBy, th.EndedDate, th.EndedBy, th.ClosedDate, th.ClosedBy, th.HoldDate, th.HoldBy,
                   th.ForwardDate, th.ForwardBy, th.OrginalTicketID, th.OrginalChannelID, oc.Name AS OrginalChannelName,
                   (SELECT COUNT(*) FROM CHA.TicketMembers x WHERE x.TicketID = th.TicketID AND x.IsLeft = 0) AS MemberCount,
                   @UserID AS MeUserID, @TIsManager AS MyIsManager, @TIsCreator AS MyIsCreator,
                   -- what the caller may do now (the same rules the write operations check)
                   CASE WHEN th.TicketState IN (0, 1) THEN 1 ELSE 0 END AS CanSend,
                   @TIsManager AS CanWriteAdminNote,
                   CASE WHEN @TIsManager = 1 AND th.TicketState = 0 THEN 1 ELSE 0 END AS CanStart,
                   CASE WHEN @TIsManager = 1 AND th.TicketState = 1 THEN 1 ELSE 0 END AS CanHold,
                   CASE WHEN @TIsManager = 1 AND th.TicketState = 1 THEN 1 ELSE 0 END AS CanEnd,
                   CASE WHEN (@TIsManager = 1 AND th.TicketState IN (5, 10)) OR (@TIsCreator = 1 AND th.TicketState = 10) THEN 1 ELSE 0 END AS CanReopen,
                   CASE WHEN @TIsCreator = 1 AND th.TicketState = 0 THEN 1 ELSE 0 END AS CanClose,
                   CASE WHEN @TIsManager = 1 AND th.TicketState IN (0, 1) THEN 1 ELSE 0 END AS CanForward,
                   CASE WHEN @TIsManager = 1 AND th.TicketState = 3 THEN 1 ELSE 0 END AS CanAnswerForward,
                   CASE WHEN (@TIsManager = 1 OR th.ForwardBy = @User) AND th.TicketState = 2 THEN 1 ELSE 0 END AS CanCancelForward,
                   CASE WHEN th.TicketState < 10 THEN 1 ELSE 0 END AS CanInvite,   -- any member, until ended
                   @TIsManager AS CanRemoveMembers,
                   CASE WHEN @TIsManager = 1 AND th.TicketState < 50
                         AND (SELECT COUNT(*) FROM CHA.TicketMembers x WHERE x.TicketID = th.TicketID AND x.IsLeft = 0
                              AND (x.IsAdmin = 1 OR x.IsTeamLeader = 1)) <= 1 THEN 0 ELSE 1 END AS CanLeave,
                   CASE WHEN @TIsManager = 1 AND th.TicketState < 50 THEN 1 ELSE 0 END AS CanAssign,
                   CASE WHEN ta.TicketID IS NULL AND @TIsManager = 1 AND th.TicketState < 50 THEN 1 ELSE 0 END AS CanTake,
                   CASE WHEN ta.TicketID IS NOT NULL AND (@TIsManager = 1 OR ta.UserID = @UserID) AND th.TicketState < 50 THEN 1 ELSE 0 END AS CanUnassign,
                   CASE WHEN tf.TicketID IS NULL THEN 0 ELSE 1 END AS MyFlagged, tf.DueDate AS MyFlagDue, tf.Note AS MyFlagNote,
                   ta.UserID AS AssignedUserID, au.Username AS AssignedUsername, ISNULL(NULLIF(au.FullName, N''), au.Username) AS AssignedName,
                   sla.FirstReplyDate, sla.ReplyMinutes, sla.ReplyTarget, sla.ReplyState,
                   sla.FinishMinutes AS FinishWorkMinutes, sla.FinishTarget, sla.FinishState
            FROM CHA.TicketHistory th
            LEFT JOIN dbo.SilaTicketFlag tf ON tf.TicketID = th.TicketID AND tf.UserID = @UserID
            LEFT JOIN dbo.SilaTicketAssignment ta ON ta.TicketID = th.TicketID
            LEFT JOIN dbo.UserMaster au     ON au.UserID = ta.UserID
            OUTER APPLY dbo.fnSilaTicketSla(th.TicketID) sla
            LEFT JOIN CHA.TicketState ts    ON ts.StateID = th.TicketState
            LEFT JOIN CHA.ChannelMaster c   ON c.ChannelID = th.TicketChannelID
            LEFT JOIN CHA.ChannelMaster oc  ON oc.ChannelID = th.OrginalChannelID AND th.OrginalChannelID <> 0
            LEFT JOIN dbo.UserMaster cu     ON cu.Username = th.CreatedByUser
            LEFT JOIN dbo.V_SilaUserTitle cj ON cj.UserID = cu.UserID
            WHERE th.TicketID = @TicketID;

            SELECT TOP (@MTop)
                   CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END AS SortID,
                   m.ChatID, m.FromUserID, fu.Username AS FromUsername, ISNULL(fu.FullName, m.FromUserName) AS FromName,
                   fj.JobName AS FromJobName, fp.FileURL AS FromPhotoURL,
                   m.Text, m.TextStyle, m.ReplayMsgID, m.IsSystem, m.IsAdmin AS IsAdminNote,
                   m.IsDeleted, m.IsEdited, m.OrginalChatID, m.CreatedDate, m.LastMaintDate, m.LocalChatID,
                   m.AttachmentID, t.FileName, t.FileOrginalName, t.FileExtension, t.FileSize, t.FileURL,
                   CASE WHEN r.IsAdmin = 1 AND @TIsManager = 0 THEN NULL ELSE r.Text END AS ReplyText,
                   r.FromUserID AS ReplyFromUserID, ISNULL(ru.FullName, r.FromUserName) AS ReplyFromName
            FROM CHA.TicketChatHistory m
            -- replaced versions: the ticket's OrginalChatIDs, collected once (as for groups)
            LEFT JOIN (SELECT DISTINCT n.OrginalChatID FROM CHA.TicketChatHistory n
                       WHERE n.TicketID IN (@TicketID, @MOrig) AND n.OrginalChatID > 0) sup ON sup.OrginalChatID = m.ChatID
            LEFT JOIN dbo.AttachmentHistory t  ON t.AttachmentID = m.AttachmentID AND m.AttachmentID <> 0
            LEFT JOIN dbo.UserMaster fu        ON fu.UserID = m.FromUserID
            LEFT JOIN dbo.V_SilaUserTitle fj     ON fj.UserID = fu.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = fu.AttachmentID AND fu.AttachmentID <> 0 ORDER BY x.ID DESC) fp
            -- TOP 1: the old 'New Chat' saved some messages twice under one ChatID
            OUTER APPLY (SELECT TOP (1) x.Text, x.FromUserID, x.FromUserName, x.IsAdmin FROM CHA.TicketChatHistory x
                         WHERE x.ChatID = m.ReplayMsgID AND m.ReplayMsgID <> 0 AND x.TicketID = m.TicketID ORDER BY x.ID DESC) r
            LEFT JOIN dbo.UserMaster ru        ON ru.UserID = r.FromUserID
            WHERE (m.TicketID = @TicketID OR (@MOrig > 0 AND m.TicketID = @MOrig AND m.IsAdmin = 0))
              AND (m.IsAdmin = 0 OR @TIsManager = 1)                 -- admins-only notes
              AND (sup.OrginalChatID IS NULL OR @MAfter > 0)
              AND (@MBefore = 0 OR CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END < @MBefore)
              AND (@MAfter = 0 OR m.ChatID > @MAfter)
            ORDER BY SortID DESC, m.ChatID DESC, m.ID DESC;

            -- List2: the ticket's state steps, one per system line, oldest first --
            -- every Start / Hold / Reopen / End / Close and forward step, from the web's
            -- and the mobile app's own wording (the ticket row keeps only the latest
            -- date of each, and none for a reopen). Not on a page back (BeforeChatID).
            IF @MBefore = 0
                SELECT s.ChatID, s.CreatedDate, s.ByUser, s.Step
                FROM (SELECT c.ChatID, c.CreatedDate, c.FromUserName AS ByUser,
                             CASE WHEN c.Text LIKE N'%re-opened%' OR c.Text LIKE N'%reopened%' THEN 'reopened'
                                  WHEN c.Text LIKE N'%has started%' THEN 'started'
                                  WHEN c.Text LIKE N'%holded%' OR c.Text LIKE N'%put on hold%' THEN 'hold'
                                  WHEN c.Text LIKE N'%has ended%' THEN 'ended'
                                  WHEN c.Text LIKE N'%has closed%' THEN 'closed'
                                  WHEN c.Text LIKE N'%accepted forwarded%' THEN 'accepted'
                                  WHEN c.Text LIKE N'%rejected forwarded%' THEN 'rejected'
                                  WHEN c.Text LIKE N'%cancelled the forward%' THEN 'cancelled'
                                  WHEN c.Text LIKE N'%Forwarded Ticket%' OR c.Text LIKE N'%forwarded this ticket%' THEN 'forwarded'
                             END AS Step
                      FROM CHA.TicketChatHistory c
                      WHERE c.TicketID = @TicketID AND c.IsSystem = 1 AND ISNULL(c.OrginalChatID, 0) = 0) s
                WHERE s.Step IS NOT NULL
                ORDER BY s.ChatID;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Ticket media (read-only): files, and messages that carry a link,
        -- newest first -- what the caller can see in Ticket messages: no
        -- admins-only notes for non-managers, no replaced versions, no
        -- deleted or system lines. The app splits files into media / docs and
        -- reads the links out of Text.
        -- -----------------------------------------------------------------
        IF @Operation = N'Ticket media'
        BEGIN
            -- a waiting forwarded copy: the original's files too (as Ticket messages)
            DECLARE @DOrig INT = CASE WHEN @TState = 3 AND ISNULL(@TOrig, 0) > 0 THEN @TOrig ELSE 0 END;
            SELECT TOP (500)
                   m.ChatID, m.CreatedDate, m.FromUserID, ISNULL(fu.FullName, m.FromUserName) AS FromName,
                   m.AttachmentID, t.FileName, t.FileOrginalName, t.FileExtension, t.FileSize, t.FileURL,
                   CASE WHEN ISNULL(m.AttachmentID, 0) = 0 THEN m.Text END AS Text
            FROM CHA.TicketChatHistory m
            LEFT JOIN (SELECT DISTINCT n.OrginalChatID FROM CHA.TicketChatHistory n
                       WHERE n.TicketID IN (@TicketID, @DOrig) AND n.OrginalChatID > 0) sup ON sup.OrginalChatID = m.ChatID
            LEFT JOIN dbo.AttachmentHistory t ON t.AttachmentID = m.AttachmentID AND m.AttachmentID <> 0
            LEFT JOIN dbo.UserMaster fu       ON fu.UserID = m.FromUserID
            WHERE (m.TicketID = @TicketID OR (@DOrig > 0 AND m.TicketID = @DOrig AND m.IsAdmin = 0))
              AND (m.IsAdmin = 0 OR @TIsManager = 1)
              AND sup.OrginalChatID IS NULL
              AND ISNULL(m.IsDeleted, 0) = 0 AND ISNULL(m.IsSystem, 0) = 0
              AND ((m.AttachmentID <> 0 AND t.FileURL IS NOT NULL)
                   OR m.Text LIKE N'%http%' OR m.Text LIKE N'%www.%')
            ORDER BY m.ChatID DESC, m.ID DESC;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Ticket members (read-only)
        -- -----------------------------------------------------------------
        IF @Operation = N'Ticket members'
        BEGIN
            SELECT tm.UserID, u.Username, u.FullName, j.JobName, j.DepartmentName, p.FileURL AS PhotoURL,
                   tm.IsAdmin, tm.IsTeamLeader, tm.IsCC, tm.IsInvited,
                   CASE WHEN tm.IsCreatedBy = 1 OR u.Username = @TCreatedBy THEN 1 ELSE 0 END AS IsCreator,
                   CASE WHEN tm.UserID = @UserID THEN 1 ELSE 0 END AS IsMe
            FROM CHA.TicketMembers tm
            JOIN dbo.UserMaster u                ON u.UserID = tm.UserID
            LEFT JOIN dbo.V_SilaUserTitle j        ON j.UserID = u.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = u.AttachmentID AND u.AttachmentID <> 0 ORDER BY x.ID DESC) p
            WHERE tm.TicketID = @TicketID AND tm.IsLeft = 0
            ORDER BY CASE WHEN tm.IsAdmin = 1 OR tm.IsTeamLeader = 1 THEN 0 ELSE 1 END, tm.IsCC, u.FullName;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Mark ticket read (one user: TrgTicketChatHistoryafterDelete then zeroes
        -- his UnreadCount and SilaHistory.UnreadMessage)
        -- -----------------------------------------------------------------
        IF @Operation = N'Mark ticket read'
        BEGIN
            DELETE FROM CHA.TicketUnreadChat WHERE TicketID = @TicketID AND UserID = @UserID;
            SELECT @@ROWCOUNT AS Cleared;
            RETURN;
        END

        -- -----------------------------------------------------------------
        -- Send ticket chat
        -- -----------------------------------------------------------------
        IF @Operation = N'Send ticket chat'
        BEGIN
            DECLARE @SText NVARCHAR(MAX), @SLocal INT, @SReply INT, @SAdmin INT;
            SELECT @SText = [Text], @SLocal = LocalChatID, @SReply = ReplayMsgID, @SAdmin = AdminOnly
            FROM OPENJSON(@LineData) WITH ([Text] NVARCHAR(MAX) '$.Text', LocalChatID INT '$.LocalChatID',
                 ReplayMsgID INT '$.ReplayMsgID', AdminOnly INT '$.AdminOnly');
            SET @SText = LTRIM(RTRIM(ISNULL(@SText, N'')));
            SET @SAdmin = CASE WHEN @SAdmin = 1 THEN 1 ELSE 0 END;
            IF @SText = N'' BEGIN SET @State = 1; SET @Message = N'Write a message first.'; RETURN; END
            IF LEN(@SText) > 10000 BEGIN SET @State = 1; SET @Message = N'The message is too long.'; RETURN; END
            IF ISNULL(@SLocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END
            IF @SAdmin = 1 AND @TIsManager = 0
            BEGIN SET @State = 403; SET @Message = N'Only ticket admins can write admins-only notes.'; RETURN; END
            IF @TState NOT IN (0, 1)
            BEGIN SET @State = 1; SET @Message = N'Messages can only be sent while the ticket is new or in progress.'; RETURN; END
            -- a reply must point into the same ticket (and a non-manager can't quote an admins-only note)
            IF ISNULL(@SReply, 0) <> 0 AND NOT EXISTS (SELECT 1 FROM CHA.TicketChatHistory
                                                      WHERE ChatID = @SReply AND TicketID = @TicketID AND (IsAdmin = 0 OR @TIsManager = 1))
                SET @SReply = 0;
            -- a reply to an admins-only note is admins-only too (its quote would show the note to everyone)
            IF ISNULL(@SReply, 0) <> 0 AND EXISTS (SELECT 1 FROM CHA.TicketChatHistory WHERE ChatID = @SReply AND TicketID = @TicketID AND IsAdmin = 1)
                SET @SAdmin = 1;

            SELECT TOP (1) @RetChat = ChatID FROM CHA.TicketChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @SLocal AND TicketID = @TicketID ORDER BY ID;
            IF @RetChat IS NULL
            BEGIN
                BEGIN TRANSACTION;
                -- a manager's first (non-note) message starts a new ticket, as in the mobile app
                IF @TState = 0 AND @TIsManager = 1 AND @SAdmin = 0
                    UPDATE CHA.TicketHistory SET TicketState = 1, StartDate = GETDATE(), StartBy = @User,
                           LastMaintDate = GETDATE(), LastMaintByUser = @User
                    WHERE TicketID = @TicketID;
                SET @RetChat = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO CHA.TicketChatHistory
                    (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
                VALUES (@RetChat, @TChannel, @TicketID, @UserID, @User, @SText,
                        ISNULL(@WHtml, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@SText, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'),
                                NCHAR(13) + NCHAR(10), N'<br>'), NCHAR(10), N'<br>')),
                        ISNULL(@SReply, 0), 0, @User, GETDATE(), @User, GETDATE(), @SLocal, 0, 0, 0, 0, @SAdmin);
                COMMIT TRANSACTION;
            END
        END

        -- -----------------------------------------------------------------
        -- Change ticket state: Start | Hold | End | Reopen | Close
        -- -----------------------------------------------------------------
        -- -----------------------------------------------------------------
        -- Send ticket file: post a file uploaded through the Files API
        -- { TicketID, AttachmentID, LocalChatID, AdminOnly?: 1 }
        -- -----------------------------------------------------------------
        IF @Operation = N'Send ticket file'
        BEGIN
            DECLARE @FAtt INT, @FLocal INT, @FAdmin INT;
            SELECT @FAtt = AttachmentID, @FLocal = LocalChatID, @FAdmin = AdminOnly
            FROM OPENJSON(@LineData) WITH (AttachmentID INT '$.AttachmentID', LocalChatID INT '$.LocalChatID', AdminOnly INT '$.AdminOnly');
            SET @FAdmin = CASE WHEN @FAdmin = 1 THEN 1 ELSE 0 END;
            IF ISNULL(@FLocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END
            IF @FAdmin = 1 AND @TIsManager = 0
            BEGIN SET @State = 403; SET @Message = N'Only ticket admins can write admins-only notes.'; RETURN; END
            IF @TState NOT IN (0, 1)
            BEGIN SET @State = 1; SET @Message = N'Files can only be sent while the ticket is new or in progress.'; RETURN; END

            SELECT TOP (1) @RetChat = ChatID FROM CHA.TicketChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @FLocal AND TicketID = @TicketID ORDER BY ID;
            IF @RetChat IS NULL
            BEGIN
            -- a file the caller uploaded through the Files API (:7500) to THIS conversation,
            -- stored, not deleted, and not posted yet (PLS.V1FileUpload, SQLScript/APIPlusAttachmentOperation.sql)
                IF NOT EXISTS (SELECT 1 FROM [PLS].[V1FileUpload] f
                               WHERE f.AttachmentID = @FAtt AND f.EntityType = 'Ticket' AND f.EntityKey = @TicketID
                                 AND f.CreatedBy = @User AND f.IsExist = 1 AND f.IsDeleted = 0)
                   OR EXISTS (SELECT 1 FROM CHA.TicketChatHistory WHERE AttachmentID = @FAtt AND TicketID = @TicketID)
                BEGIN SET @State = 409; SET @Message = N'That file can''t be sent here. Upload it again.'; RETURN; END
                BEGIN TRANSACTION;
                -- a manager's first (non-note) message starts a new ticket, as in the mobile app
                IF @TState = 0 AND @TIsManager = 1 AND @FAdmin = 0
                    UPDATE CHA.TicketHistory SET TicketState = 1, StartDate = GETDATE(), StartBy = @User,
                           LastMaintDate = GETDATE(), LastMaintByUser = @User
                    WHERE TicketID = @TicketID;
                SET @RetChat = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO CHA.TicketChatHistory
                    (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
                VALUES (@RetChat, @TChannel, @TicketID, @UserID, @User, N'', N'', 0, @FAtt,
                        @User, GETDATE(), @User, GETDATE(), @FLocal, 0, 0, 0, 0, @FAdmin);
                COMMIT TRANSACTION;
            END
        END

        IF @Operation = N'Change ticket state'
        BEGIN
            DECLARE @AAction NVARCHAR(20) = LTRIM(RTRIM(ISNULL(JSON_VALUE(@LineData, '$.Action'), N'')));
            DECLARE @ATo INT = CASE @AAction WHEN N'Start' THEN 1 WHEN N'Hold' THEN 5 WHEN N'End' THEN 10
                                             WHEN N'Reopen' THEN 1 WHEN N'Close' THEN 50 END;
            IF @ATo IS NULL BEGIN SET @State = 1; SET @Message = N'Unknown action.'; RETURN; END
            DECLARE @AAllowed INT = CASE
                WHEN @AAction = N'Start'  THEN CASE WHEN @TIsManager = 1 AND @TState = 0 THEN 1 ELSE 0 END
                WHEN @AAction = N'Hold'   THEN CASE WHEN @TIsManager = 1 AND @TState = 1 THEN 1 ELSE 0 END
                WHEN @AAction = N'End'    THEN CASE WHEN @TIsManager = 1 AND @TState = 1 THEN 1 ELSE 0 END
                WHEN @AAction = N'Reopen' THEN CASE WHEN (@TIsManager = 1 AND @TState IN (5, 10)) OR (@TIsCreator = 1 AND @TState = 10) THEN 1 ELSE 0 END
                WHEN @AAction = N'Close'  THEN CASE WHEN @TIsCreator = 1 AND @TState = 0 THEN 1 ELSE 0 END
                ELSE 0 END;
            IF @AAllowed = 0
            BEGIN
                SET @State = 403;
                SET @Message = CASE WHEN @AAction IN (N'Start', N'Hold', N'End') AND @TIsManager = 0
                                      THEN N'Only ticket admins and team leaders can do that.'
                                    WHEN @AAction = N'Close' AND @TIsCreator = 0
                                      THEN N'Only the ticket''s creator can close it.'
                                    WHEN @AAction = N'Reopen' AND @TIsManager = 0 AND @TIsCreator = 0
                                      THEN N'Only ticket admins, team leaders or the creator can do that.'
                                    ELSE N'That isn''t possible in the ticket''s current state.' END;
                RETURN;
            END
            DECLARE @AText NVARCHAR(MAX) = @Me + CASE @AAction
                WHEN N'Start' THEN N' has started Ticket #' WHEN N'Hold' THEN N' has put on hold Ticket #'
                WHEN N'End' THEN N' has ended Ticket #' WHEN N'Reopen' THEN N' has re-opened Ticket #'
                ELSE N' has closed Ticket #' END + CAST(@TicketID AS NVARCHAR(20));

            BEGIN TRANSACTION;
            UPDATE CHA.TicketHistory SET
                TicketState = @ATo,
                StartDate  = CASE WHEN @AAction = N'Start' OR (@AAction = N'End' AND StartDate IS NULL) THEN GETDATE() ELSE StartDate END,
                StartBy    = CASE WHEN @AAction = N'Start' OR (@AAction = N'End' AND ISNULL(StartBy, N'') = N'') THEN @User ELSE StartBy END,
                HoldDate   = CASE WHEN @AAction = N'Hold' THEN GETDATE() ELSE HoldDate END,
                HoldBy     = CASE WHEN @AAction = N'Hold' THEN @User ELSE HoldBy END,
                EndedDate  = CASE WHEN @AAction = N'End' THEN GETDATE() ELSE EndedDate END,
                EndedBy    = CASE WHEN @AAction = N'End' THEN @User WHEN @AAction = N'Reopen' THEN N'' ELSE EndedBy END,
                ClosedDate = CASE WHEN @AAction = N'Close' THEN GETDATE() ELSE ClosedDate END,
                ClosedBy   = CASE WHEN @AAction = N'Close' THEN @User ELSE ClosedBy END,
                LastMaintDate = GETDATE(), LastMaintByUser = @User
            WHERE TicketID = @TicketID;
            -- the system line (an unread event for the other members, as in the mobile app)
            DECLARE @AChat INT = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO CHA.TicketChatHistory
                (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
            VALUES (@AChat, @TChannel, @TicketID, @UserID, @User, @AText, @AText, 0, 0,
                    @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);
            -- a closed ticket leaves the Home lists (as in the mobile app; 'Ticket list' Closed = 1 shows it)
            IF @AAction = N'Close'
                DELETE FROM dbo.SilaHistory WHERE TicketID = @TicketID AND RecordType = 'C';
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- -----------------------------------------------------------------
        -- Forward ticket: a copy waits in the target channel (state 3) until its
        -- admins accept or reject it; the original is Forwarded (2).
        -- -----------------------------------------------------------------
        IF @Operation = N'Forward ticket'
        BEGIN
            DECLARE @FTo INT = TRY_CAST(JSON_VALUE(@LineData, '$.ToChannelID') AS INT);
            IF @TIsManager = 0
            BEGIN SET @State = 403; SET @Message = N'Only ticket admins and team leaders can forward a ticket.'; RETURN; END
            IF @TState NOT IN (0, 1)
            BEGIN SET @State = 1; SET @Message = N'Only a new or in-progress ticket can be forwarded.'; RETURN; END
            IF @FTo = @TChannel OR NOT EXISTS (SELECT 1 FROM @Visible WHERE ChannelID = @FTo)
            BEGIN SET @State = 1; SET @Message = N'Pick another channel.'; RETURN; END
            IF (SELECT CategoryID FROM CHA.ChannelMaster WHERE ChannelID = @FTo)
               <> (SELECT CategoryID FROM CHA.ChannelMaster WHERE ChannelID = @TChannel)
            BEGIN SET @State = 1; SET @Message = N'A ticket can only be forwarded to a channel of the same category.'; RETURN; END

            -- members of the copy: the target channel's admins / team leaders, the listed users
            -- (roles from the target channel), the ticket's creator and its CC people (always,
            -- as CC); never the client's roles
            DECLARE @FMembers TABLE (UserID INT PRIMARY KEY, IsAdmin INT, IsTeamLeader INT, IsCreatedBy INT, IsCC INT);
            INSERT INTO @FMembers (UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC)
            SELECT cm.UserID, cm.IsAdmin, cm.IsTeamLeader, 0, 0
            FROM CHA.ChannelMembers cm JOIN dbo.UserMaster u ON u.UserID = cm.UserID AND u.IsNotActive = 0
            WHERE cm.ChannelID = @FTo AND (cm.IsAdmin = 1 OR cm.IsTeamLeader = 1);
            INSERT INTO @FMembers (UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC)
            SELECT x.UserID, ISNULL(MAX(cm.IsAdmin), 0), ISNULL(MAX(cm.IsTeamLeader), 0), 0, MAX(CASE WHEN x.IsCC = 1 THEN 1 ELSE 0 END)
            FROM OPENJSON(@LineData, '$.Members') WITH (UserID INT '$.UserID', IsCC INT '$.IsCC') x
            JOIN dbo.UserMaster u ON u.UserID = x.UserID AND u.IsNotActive = 0
            LEFT JOIN CHA.ChannelMembers cm ON cm.ChannelID = @FTo AND cm.UserID = x.UserID
            WHERE NOT EXISTS (SELECT 1 FROM @FMembers f WHERE f.UserID = x.UserID)
            GROUP BY x.UserID;
            DECLARE @FCreatorID INT = (SELECT UserID FROM dbo.UserMaster WHERE Username = @TCreatedBy AND IsNotActive = 0);
            IF @FCreatorID IS NOT NULL
            BEGIN
                UPDATE @FMembers SET IsCreatedBy = 1 WHERE UserID = @FCreatorID;
                IF @@ROWCOUNT = 0 INSERT INTO @FMembers VALUES (@FCreatorID, 0, 0, 1, 0);
            END
            -- the ticket's CC people always come along, still as CC
            UPDATE f SET f.IsCC = 1 FROM @FMembers f
            JOIN CHA.TicketMembers tm ON tm.TicketID = @TicketID AND tm.UserID = f.UserID AND tm.IsLeft = 0 AND tm.IsCC = 1
            WHERE f.IsAdmin = 0 AND f.IsTeamLeader = 0 AND f.IsCreatedBy = 0;
            INSERT INTO @FMembers (UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC)
            SELECT tm.UserID, 0, 0, 0, 1
            FROM CHA.TicketMembers tm JOIN dbo.UserMaster u ON u.UserID = tm.UserID AND u.IsNotActive = 0
            WHERE tm.TicketID = @TicketID AND tm.IsLeft = 0 AND tm.IsCC = 1
              AND NOT EXISTS (SELECT 1 FROM @FMembers f WHERE f.UserID = tm.UserID);
            IF NOT EXISTS (SELECT 1 FROM @FMembers WHERE IsAdmin = 1 OR IsTeamLeader = 1)
            BEGIN SET @State = 1; SET @Message = N'That channel has no admin or team leader to accept the ticket.'; RETURN; END

            DECLARE @FToName NVARCHAR(100) = (SELECT Name FROM CHA.ChannelMaster WHERE ChannelID = @FTo);
            DECLARE @FFromName NVARCHAR(100) = (SELECT Name FROM CHA.ChannelMaster WHERE ChannelID = @TChannel);
            DECLARE @FCopy INT, @FChat INT, @FText NVARCHAR(MAX);
            BEGIN TRANSACTION;
            UPDATE CHA.TicketHistory SET TicketState = 2, ForwardDate = GETDATE(), ForwardBy = @User,
                   LastMaintDate = GETDATE(), LastMaintByUser = @User
            WHERE TicketID = @TicketID;
            SET @FText = @Me + N' has forwarded Ticket #' + CAST(@TicketID AS NVARCHAR(20)) + N' to # ' + ISNULL(@FToName, N'');
            SET @FChat = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO CHA.TicketChatHistory
                (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
            VALUES (@FChat, @TChannel, @TicketID, @UserID, @User, @FText, @FText, 0, 0,
                    @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);

            SET @FCopy = NEXT VALUE FOR dbo.TicketID;
            INSERT INTO CHA.TicketHistory
                (TicketID, TicketSubject, CreatedByUser, CreatedDate, TicketChannelID, OrginalChannelID, OrginalTicketID,
                 TicketState, LastMaintDate, LastMaintByUser, ForwardDate, ForwardBy)
            SELECT @FCopy, TicketSubject, CreatedByUser, GETDATE(), @FTo, TicketChannelID, TicketID, 3, GETDATE(), @User, GETDATE(), @User
            FROM CHA.TicketHistory WHERE TicketID = @TicketID;
            INSERT INTO CHA.TicketMembers (ChannelID, TicketID, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, IsMuted, IsInvited)
            SELECT @FTo, @FCopy, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, 0, 0 FROM @FMembers;
            SET @FText = @Me + N' forwarded this ticket from # ' + ISNULL(@FFromName, N'') + N' (Ticket #'
                       + CAST(@TicketID AS NVARCHAR(20)) + N'). Accept or reject it.';
            SET @FChat = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO CHA.TicketChatHistory
                (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
            VALUES (@FChat, @FTo, @FCopy, @UserID, @User, @FText, @FText, 0, 0,
                    @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);
            INSERT INTO @SyncUsers SELECT DISTINCT UserID FROM CHA.TicketMembers WHERE TicketID IN (@TicketID, @FCopy);
            -- the phones of everyone in either ticket reload their whole list (a delta can't drop a deleted ticket)
            UPDATE dbo.UserSyncMaster SET ForceFullSync = 1 WHERE UserID IN (SELECT UserID FROM @SyncUsers);
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- -----------------------------------------------------------------
        -- Answer forward (on the waiting copy, state 3): Accept moves the
        -- conversation into the copy and retires the original; Reject drops the
        -- copy and gives the original back (New).
        -- -----------------------------------------------------------------
        IF @Operation = N'Answer forward'
        BEGIN
            DECLARE @WAccept INT = CASE WHEN TRY_CAST(JSON_VALUE(@LineData, '$.Accept') AS INT) = 1 THEN 1 ELSE 0 END;
            IF @TIsManager = 0
            BEGIN SET @State = 403; SET @Message = N'Only the channel''s ticket admins and team leaders can answer a forward.'; RETURN; END
            IF @TState <> 3 OR ISNULL(@TOrig, 0) = 0 OR NOT EXISTS (SELECT 1 FROM CHA.TicketHistory WHERE TicketID = @TOrig AND TicketState = 2)
            BEGIN SET @State = 1; SET @Message = N'This ticket is not waiting for an answer.'; RETURN; END

            DECLARE @WChat INT, @WText NVARCHAR(MAX);
            BEGIN TRANSACTION;
            -- both tickets' people, taken before either one's members are deleted
            INSERT INTO @SyncUsers SELECT DISTINCT UserID FROM CHA.TicketMembers WHERE TicketID IN (@TicketID, @TOrig);
            IF @WAccept = 1
            BEGIN
                SET @WText = @Me + N' has accepted forwarded Ticket #' + CAST(@TicketID AS NVARCHAR(20));
                -- keep a copy of the original (as the mobile app does), then retire it
                INSERT INTO CHA.TicketHistoryForward SELECT * FROM CHA.TicketHistory WHERE TicketID = @TOrig;
                -- the old team's admins-only notes stay behind; the rest of the conversation moves
                DELETE FROM CHA.TicketChatHistory WHERE TicketID = @TOrig AND IsAdmin = 1;
                UPDATE CHA.TicketChatHistory SET TicketID = @TicketID, ChannelID = @TChannel WHERE TicketID = @TOrig;
                -- unread rows: kept for people in the new ticket, dropped for the others
                UPDATE u SET u.TicketID = @TicketID, u.ChannelID = @TChannel
                FROM CHA.TicketUnreadChat u
                WHERE u.TicketID = @TOrig AND u.UserID IN (SELECT x.UserID FROM CHA.TicketMembers x WHERE x.TicketID = @TicketID AND x.IsLeft = 0);
                DELETE FROM CHA.TicketUnreadChat WHERE TicketID = @TOrig;
                DELETE FROM CHA.TicketMembers WHERE TicketID = @TOrig;
                DELETE FROM dbo.SilaTicketAssignment WHERE TicketID = @TOrig;
                DELETE FROM dbo.SilaHistory WHERE TicketID = @TOrig AND RecordType = 'C';   -- the delete trigger handles one row only
                DELETE FROM CHA.TicketHistory WHERE TicketID = @TOrig;
                UPDATE CHA.TicketHistory SET TicketState = 0, LastMaintDate = GETDATE(), LastMaintByUser = @User WHERE TicketID = @TicketID;
                SET @WChat = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO CHA.TicketChatHistory
                    (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
                VALUES (@WChat, @TChannel, @TicketID, @UserID, @User, @WText, @WText, 0, 0,
                        @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);
                -- moving rows re-ran the message trigger on old rows: recount everyone's unread for this ticket
                UPDATE tm SET tm.UnreadCount = (SELECT COUNT(*) FROM CHA.TicketUnreadChat u WHERE u.TicketID = tm.TicketID AND u.UserID = tm.UserID)
                FROM CHA.TicketMembers tm WHERE tm.TicketID = @TicketID;
                UPDATE sh SET sh.UnreadMessage = ISNULL(tm.UnreadCount, 0)
                FROM dbo.SilaHistory sh JOIN CHA.TicketMembers tm ON tm.TicketID = sh.TicketID AND tm.UserID = sh.UserID
                WHERE sh.TicketID = @TicketID AND sh.RecordType = 'C';
                SET @RetTicket = @TicketID;
            END
            ELSE
            BEGIN
                SET @WText = @Me + N' has rejected forwarded Ticket #' + CAST(@TicketID AS NVARCHAR(20));
                DELETE FROM CHA.TicketUnreadChat WHERE TicketID = @TicketID;
                DELETE FROM CHA.TicketChatHistory WHERE TicketID = @TicketID;
                DELETE FROM CHA.TicketMembers WHERE TicketID = @TicketID;
                DELETE FROM dbo.SilaTicketAssignment WHERE TicketID = @TicketID;
                DELETE FROM dbo.SilaHistory WHERE TicketID = @TicketID AND RecordType = 'C';
                DELETE FROM CHA.TicketHistory WHERE TicketID = @TicketID;
                -- the original goes back to where it was: In progress if it had been started, else New
                UPDATE CHA.TicketHistory SET TicketState = CASE WHEN StartDate > '2000-01-01' THEN 1 ELSE 0 END, LastMaintDate = GETDATE(), LastMaintByUser = @User WHERE TicketID = @TOrig;
                SET @WChat = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO CHA.TicketChatHistory
                    (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
                VALUES (@WChat, @TOrigChannel, @TOrig, @UserID, @User, @WText, @WText, 0, 0,
                        @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);
                -- the caller usually isn't a member of the original: answer with the rejected copy's id only
                SELECT @TicketID AS TicketID, @TOrig AS OrginalTicketID, N'Rejected' AS Result;
            END
            -- the phones of everyone in either ticket reload their whole list (a delta can't drop a deleted ticket)
            UPDATE dbo.UserSyncMaster SET ForceFullSync = 1 WHERE UserID IN (SELECT UserID FROM @SyncUsers);
            COMMIT TRANSACTION;
            IF @WAccept = 0 RETURN;
        END

        -- -----------------------------------------------------------------
        -- Cancel forward (on the original, state 2)
        -- -----------------------------------------------------------------
        IF @Operation = N'Cancel forward'
        BEGIN
            IF @TIsManager = 0 AND ISNULL(@TForwardBy, N'') <> @User
            BEGIN SET @State = 403; SET @Message = N'Only ticket admins, team leaders or whoever forwarded it can cancel the forward.'; RETURN; END
            IF @TState <> 2
            BEGIN SET @State = 1; SET @Message = N'This ticket is not forwarded.'; RETURN; END
            DECLARE @KCopy INT = (SELECT TOP (1) TicketID FROM CHA.TicketHistory WHERE OrginalTicketID = @TicketID AND TicketState = 3 ORDER BY TicketID DESC);
            DECLARE @KText NVARCHAR(MAX) = @Me + N' has cancelled the forward of Ticket #' + CAST(@TicketID AS NVARCHAR(20));
            DECLARE @KChat INT;
            BEGIN TRANSACTION;
            INSERT INTO @SyncUsers SELECT DISTINCT UserID FROM CHA.TicketMembers WHERE TicketID IN (@TicketID, ISNULL(@KCopy, @TicketID));
            IF @KCopy IS NOT NULL
            BEGIN
                DELETE FROM CHA.TicketUnreadChat WHERE TicketID = @KCopy;
                DELETE FROM CHA.TicketChatHistory WHERE TicketID = @KCopy;
                DELETE FROM CHA.TicketMembers WHERE TicketID = @KCopy;
                DELETE FROM dbo.SilaTicketAssignment WHERE TicketID = @KCopy;
                DELETE FROM dbo.SilaHistory WHERE TicketID = @KCopy AND RecordType = 'C';
                DELETE FROM CHA.TicketHistory WHERE TicketID = @KCopy;
            END
            -- back to where it was: In progress if it had been started, else New
            UPDATE CHA.TicketHistory SET TicketState = CASE WHEN StartDate > '2000-01-01' THEN 1 ELSE 0 END, LastMaintDate = GETDATE(), LastMaintByUser = @User WHERE TicketID = @TicketID;
            SET @KChat = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO CHA.TicketChatHistory
                (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
            VALUES (@KChat, @TChannel, @TicketID, @UserID, @User, @KText, @KText, 0, 0,
                    @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);
            -- the phones of everyone in either ticket reload their whole list (a delta can't drop a deleted ticket)
            UPDATE dbo.UserSyncMaster SET ForceFullSync = 1 WHERE UserID IN (SELECT UserID FROM @SyncUsers);
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- -----------------------------------------------------------------
        -- Invite ticket members: any member, until the ticket is ended. Roles
        -- from the channel; only admins / team leaders may make someone a ticket admin. Someone who had left is brought back (his Home row re-added:
        -- the update trigger only handles leaving).
        -- -----------------------------------------------------------------
        IF @Operation = N'Invite ticket members'
        BEGIN
            IF @TState >= 10
            BEGIN SET @State = 1; SET @Message = N'This ticket has ended. Reopen it to invite people.'; RETURN; END
            -- roles from the channel; an inviting admin / team leader may also make someone a
            -- TICKET admin (Members[].IsAdmin = 1) -- ignored from anyone else
            DECLARE @IList TABLE (UserID INT PRIMARY KEY, IsAdmin INT, IsTeamLeader INT, IsCC INT, FullName NVARCHAR(MAX), Existing INT);
            INSERT INTO @IList (UserID, IsAdmin, IsTeamLeader, IsCC, FullName, Existing)
            SELECT x.UserID,
                   CASE WHEN MAX(CASE WHEN x.IsAdmin = 1 AND @TIsManager = 1 THEN 1 ELSE 0 END) = 1 THEN 1 ELSE ISNULL(MAX(cm.IsAdmin), 0) END,
                   ISNULL(MAX(cm.IsTeamLeader), 0), MAX(CASE WHEN x.IsCC = 1 THEN 1 ELSE 0 END),
                   MAX(ISNULL(NULLIF(u.FullName, N''), u.Username)),
                   MAX(CASE WHEN tm.UserID IS NULL THEN 0 WHEN tm.IsLeft = 1 THEN 1 ELSE 2 END)
            FROM OPENJSON(@LineData, '$.Members') WITH (UserID INT '$.UserID', IsCC INT '$.IsCC', IsAdmin INT '$.IsAdmin') x
            JOIN dbo.UserMaster u ON u.UserID = x.UserID AND u.IsNotActive = 0
            LEFT JOIN CHA.ChannelMembers cm ON cm.ChannelID = @TChannel AND cm.UserID = x.UserID
            LEFT JOIN CHA.TicketMembers tm ON tm.TicketID = @TicketID AND tm.UserID = x.UserID
            GROUP BY x.UserID;
            DELETE FROM @IList WHERE Existing = 2;   -- already in the ticket
            IF NOT EXISTS (SELECT 1 FROM @IList)
            BEGIN SET @State = 1; SET @Message = N'Everyone you picked is already in this ticket.'; RETURN; END

            BEGIN TRANSACTION;
            INSERT INTO CHA.TicketMembers (ChannelID, TicketID, UserID, IsAdmin, IsTeamLeader, IsCreatedBy, IsCC, IsMuted, IsInvited)
            SELECT @TChannel, @TicketID, UserID, IsAdmin, IsTeamLeader, 0, IsCC, 0, 1 FROM @IList WHERE Existing = 0;
            UPDATE tm SET tm.IsLeft = 0, tm.IsInvited = 1, tm.IsCC = i.IsCC,
                   tm.IsAdmin = i.IsAdmin   -- coming back: the role picked now (or the channel's), not the old one
            FROM CHA.TicketMembers tm JOIN @IList i ON i.UserID = tm.UserID AND i.Existing = 1
            WHERE tm.TicketID = @TicketID;
            -- Home rows for everyone invited (the insert trigger may have added them already)
            INSERT INTO dbo.SilaHistory (RecordType, TicketID, UserID, ChannelID, TicketSubject)
            SELECT 'C', @TicketID, i.UserID, @TChannel, (SELECT TicketSubject FROM CHA.TicketHistory WHERE TicketID = @TicketID)
            FROM @IList i
            WHERE NOT EXISTS (SELECT 1 FROM dbo.SilaHistory sh WHERE sh.RecordType = 'C' AND sh.TicketID = @TicketID AND sh.UserID = i.UserID);
            UPDATE CHA.TicketHistory SET
                Members = ISNULL((SELECT STRING_AGG(CAST(x.UserID AS NVARCHAR(10)), ',') FROM CHA.TicketMembers x
                                  WHERE x.TicketID = @TicketID AND x.IsLeft = 0), N''),
                LastMaintDate = GETDATE(), LastMaintByUser = @User
            WHERE TicketID = @TicketID;
            -- one system line per invited person (NEXT VALUE FOR gives each row its own ChatID)
            INSERT INTO CHA.TicketChatHistory
                (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
            SELECT NEXT VALUE FOR dbo.ChatTicket, @TChannel, @TicketID, @UserID, @User,
                   N'@' + i.FullName + N' has been invited to Ticket #' + CAST(@TicketID AS NVARCHAR(20)) + CASE WHEN i.IsAdmin = 1 THEN N' as admin' ELSE N'' END,
                   N'@' + i.FullName + N' has been invited to Ticket #' + CAST(@TicketID AS NVARCHAR(20)) + CASE WHEN i.IsAdmin = 1 THEN N' as admin' ELSE N'' END,
                   0, 0, @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0
            FROM @IList i;
            COMMIT TRANSACTION;
            SET @RetTicket = @TicketID;
        END

        -- -----------------------------------------------------------------
        -- Remove ticket member (managers remove anyone but the creator;
        -- anyone may leave) / Leave ticket (the caller). One row: the update
        -- trigger drops his Home row and unread rows.
        -- -----------------------------------------------------------------
        IF @Operation IN (N'Remove ticket member', N'Leave ticket')
        BEGIN
            DECLARE @RTarget INT = CASE WHEN @Operation = N'Leave ticket' THEN @UserID
                                        ELSE TRY_CAST(JSON_VALUE(@LineData, '$.UserID') AS INT) END;
            DECLARE @RIsCreator INT, @RName NVARCHAR(MAX), @RIsManager INT;
            SELECT @RIsCreator = CASE WHEN tm.IsCreatedBy = 1 OR u.Username = @TCreatedBy THEN 1 ELSE 0 END,
                   @RIsManager = CASE WHEN tm.IsAdmin = 1 OR tm.IsTeamLeader = 1 THEN 1 ELSE 0 END,
                   @RName = ISNULL(NULLIF(u.FullName, N''), u.Username)
            FROM CHA.TicketMembers tm JOIN dbo.UserMaster u ON u.UserID = tm.UserID
            WHERE tm.TicketID = @TicketID AND tm.UserID = @RTarget AND tm.IsLeft = 0;
            IF @RName IS NULL
            BEGIN SET @State = 1; SET @Message = N'That person is not in this ticket.'; RETURN; END
            IF @RTarget <> @UserID AND @TIsManager = 0
            BEGIN SET @State = 403; SET @Message = N'Only ticket admins and team leaders can remove people.'; RETURN; END
            IF @RTarget <> @UserID AND @RIsCreator = 1
            BEGIN SET @State = 403; SET @Message = N'The ticket''s creator can''t be removed.'; RETURN; END
            IF @RIsManager = 1 AND (SELECT COUNT(*) FROM CHA.TicketMembers WHERE TicketID = @TicketID AND IsLeft = 0
                                    AND (IsAdmin = 1 OR IsTeamLeader = 1)) <= 1 AND @TState < 50
            BEGIN SET @State = 1; SET @Message = CASE WHEN @RTarget = @UserID
                THEN N'You are the last admin or team leader of this open ticket: end or close it, or have someone made admin first.'
                ELSE N'An open ticket needs at least one admin or team leader.' END; RETURN; END

            DECLARE @RText NVARCHAR(MAX) = CASE WHEN @RTarget = @UserID
                THEN N'@' + @RName + N' has left Ticket #' + CAST(@TicketID AS NVARCHAR(20))
                ELSE N'@' + @RName + N' has been removed from this Ticket by ' + @Me END;
            DECLARE @RChat INT;
            BEGIN TRANSACTION;
            UPDATE CHA.TicketMembers SET IsLeft = 1 WHERE TicketID = @TicketID AND UserID = @RTarget;
            DELETE FROM dbo.SilaTicketAssignment WHERE TicketID = @TicketID AND UserID = @RTarget;   -- nobody owns it now
            SET @RChat = NEXT VALUE FOR dbo.ChatTicket;
            INSERT INTO CHA.TicketChatHistory
                (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                 CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
            VALUES (@RChat, @TChannel, @TicketID, @UserID, @User, @RText, @RText, 0, 0,
                    @User, GETDATE(), @User, GETDATE(), 0, 0, 0, 0, 1, 0);
            COMMIT TRANSACTION;
            IF @RTarget = @UserID
            BEGIN
                SELECT @TicketID AS TicketID, 1 AS Left_;   -- no longer a member: nothing more to show
                RETURN;
            END
            SET @RetTicket = @TicketID;
        END

        -- -----------------------------------------------------------------
        -- Edit ticket chat / Delete ticket chat (own, non-system messages,
        -- of a ticket the caller is still in, until it is closed)
        -- -----------------------------------------------------------------
        IF @Operation IN (N'Edit ticket chat', N'Delete ticket chat')
        BEGIN
            DECLARE @EChat INT, @EText NVARCHAR(MAX), @ELocal INT, @EFrom INT, @ETicket INT, @EDeleted INT, @ESystem INT, @EAdmin INT, @EState INT;
            SELECT @EChat = ChatID, @EText = [Text], @ELocal = LocalChatID
            FROM OPENJSON(@LineData) WITH (ChatID INT '$.ChatID', [Text] NVARCHAR(MAX) '$.Text', LocalChatID INT '$.LocalChatID');
            SELECT TOP (1) @EFrom = m.FromUserID, @ETicket = m.TicketID, @EDeleted = m.IsDeleted, @ESystem = m.IsSystem,
                   @EAdmin = m.IsAdmin, @EState = th.TicketState
            FROM CHA.TicketChatHistory m JOIN CHA.TicketHistory th ON th.TicketID = m.TicketID
            WHERE m.ChatID = @EChat ORDER BY m.ID;
            IF @EFrom IS NULL OR @EFrom <> @UserID OR @ESystem <> 0
               OR NOT EXISTS (SELECT 1 FROM CHA.TicketMembers WHERE TicketID = @ETicket AND UserID = @UserID AND IsLeft = 0)
            BEGIN SET @State = 403; SET @Message = N'You can only change your own messages.'; RETURN; END
            IF @EState >= 50
            BEGIN SET @State = 1; SET @Message = N'This ticket is closed.'; RETURN; END
            IF @EDeleted <> 0 OR EXISTS (SELECT 1 FROM CHA.TicketChatHistory WHERE TicketID = @ETicket AND OrginalChatID = @EChat)
            BEGIN SET @State = 1; SET @Message = N'This message was already changed. Reload the ticket.'; RETURN; END
            IF ISNULL(@ELocal, 0) = 0 BEGIN SET @State = 1; SET @Message = N'LocalChatID is required.'; RETURN; END
            IF @Operation = N'Edit ticket chat'
            BEGIN
                SET @EText = LTRIM(RTRIM(ISNULL(@EText, N'')));
                IF @EText = N'' BEGIN SET @State = 1; SET @Message = N'Write a message first.'; RETURN; END
                IF LEN(@EText) > 10000 BEGIN SET @State = 1; SET @Message = N'The message is too long.'; RETURN; END
            END
            ELSE
                SET @EText = N'Text Is Deleted ********';   -- the mobile app's placeholder

            SELECT TOP (1) @RetChat = ChatID FROM CHA.TicketChatHistory
            WHERE FromUserID = @UserID AND LocalChatID = @ELocal AND OrginalChatID = @EChat ORDER BY ID;
            IF @RetChat IS NULL
            BEGIN
                DECLARE @EIsDel BIT = CASE WHEN @Operation = N'Delete ticket chat' THEN 1 ELSE 0 END;
                BEGIN TRANSACTION;
                -- flag the original first, then add the copy: the message trigger runs on both and
                -- leaves LastChatID / LastMessage on the copy
                UPDATE CHA.TicketChatHistory
                SET LastMaintBy = @User, LastMaintDate = GETDATE(),
                    IsEdited = CASE WHEN @EIsDel = 0 THEN 1 ELSE IsEdited END,
                    IsDeleted = CASE WHEN @EIsDel = 1 THEN 1 ELSE IsDeleted END
                WHERE ChatID = @EChat AND TicketID = @ETicket;
                SET @RetChat = NEXT VALUE FOR dbo.ChatTicket;
                INSERT INTO CHA.TicketChatHistory
                    (ChatID, ChannelID, TicketID, FromUserID, FromUserName, Text, TextStyle, ReplayMsgID, AttachmentID,
                     CreatedBy, CreatedDate, LastMaintBy, LastMaintDate, LocalChatID, OrginalChatID, IsEdited, IsDeleted, IsSystem, IsAdmin)
                SELECT TOP (1) @RetChat, ChannelID, TicketID, FromUserID, FromUserName, @EText,
                       ISNULL(@WHtml, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@EText, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'),
                               NCHAR(13) + NCHAR(10), N'<br>'), NCHAR(10), N'<br>')),
                       ReplayMsgID, CASE WHEN @EIsDel = 1 THEN 0 ELSE AttachmentID END,
                       @User, GETDATE(), @User, GETDATE(), @ELocal, @EChat, 0, @EIsDel, 0, @EAdmin
                FROM CHA.TicketChatHistory WHERE ChatID = @EChat AND TicketID = @ETicket ORDER BY ID;
                -- the trigger counted the copy as a new unread message: undo that, then recount
                DELETE FROM CHA.TicketUnreadChat WHERE TicketID = @ETicket AND ChatID IN (@EChat, @RetChat);
                UPDATE tm SET tm.UnreadCount = (SELECT COUNT(*) FROM CHA.TicketUnreadChat u WHERE u.TicketID = tm.TicketID AND u.UserID = tm.UserID)
                FROM CHA.TicketMembers tm WHERE tm.TicketID = @ETicket;
                UPDATE sh SET sh.UnreadMessage = tm.UnreadCount
                FROM dbo.SilaHistory sh JOIN CHA.TicketMembers tm ON tm.TicketID = sh.TicketID AND tm.UserID = sh.UserID
                WHERE sh.TicketID = @ETicket AND sh.RecordType = 'C';
                COMMIT TRANSACTION;
            END
        END

        -- =================================================================
        -- RESULTS
        -- =================================================================
        IF @RetChat IS NOT NULL
        BEGIN
            SELECT TOP (1) m.TicketID, CASE WHEN m.OrginalChatID > 0 THEN m.OrginalChatID ELSE m.ChatID END AS SortID,
                   m.ChatID, m.FromUserID, fu.Username AS FromUsername, ISNULL(fu.FullName, m.FromUserName) AS FromName,
                   fj.JobName AS FromJobName, fp.FileURL AS FromPhotoURL,
                   m.Text, m.TextStyle, m.ReplayMsgID, m.IsSystem, m.IsAdmin AS IsAdminNote,
                   m.IsDeleted, m.IsEdited, m.OrginalChatID, m.CreatedDate, m.LastMaintDate, m.LocalChatID,
                   m.AttachmentID, t.FileName, t.FileOrginalName, t.FileExtension, t.FileSize, t.FileURL,
                   r.Text AS ReplyText, r.FromUserID AS ReplyFromUserID, ISNULL(ru.FullName, r.FromUserName) AS ReplyFromName,
                   (SELECT TicketState FROM CHA.TicketHistory WHERE TicketID = m.TicketID) AS TicketState
            FROM CHA.TicketChatHistory m
            LEFT JOIN dbo.AttachmentHistory t  ON t.AttachmentID = m.AttachmentID AND m.AttachmentID <> 0
            LEFT JOIN dbo.UserMaster fu        ON fu.UserID = m.FromUserID
            LEFT JOIN dbo.V_SilaUserTitle fj     ON fj.UserID = fu.UserID
            OUTER APPLY (SELECT TOP (1) x.FileURL FROM dbo.AttachmentHistory x
                         WHERE x.AttachmentID = fu.AttachmentID AND fu.AttachmentID <> 0 ORDER BY x.ID DESC) fp
            OUTER APPLY (SELECT TOP (1) x.Text, x.FromUserID, x.FromUserName FROM CHA.TicketChatHistory x
                         WHERE x.ChatID = m.ReplayMsgID AND m.ReplayMsgID <> 0 AND x.TicketID = m.TicketID ORDER BY x.ID DESC) r
            LEFT JOIN dbo.UserMaster ru        ON ru.UserID = r.FromUserID
            WHERE m.ChatID = @RetChat
            ORDER BY m.ID;
            RETURN;
        END

        IF @RetTicket IS NOT NULL
        BEGIN
            SELECT th.TicketID, th.TicketSubject, th.TicketState, ts.StateDescription, th.TicketChannelID AS ChannelID,
                   c.Name AS ChannelName, th.CreatedDate, th.CreatedByUser, cu.FullName AS CreatedByName,
                   th.LastMessage, th.LastChatID, th.LastMaintDate, th.StartDate, th.EndedDate, th.ClosedDate,
                   th.OrginalTicketID, th.OrginalChannelID, oc.Name AS OrginalChannelName,
                   ISNULL(tm.UnreadCount, 0) AS Unread, ISNULL(tm.IsMuted, 0) AS IsMuted,
                   ISNULL(tm.IsAdmin, 0) AS MyIsAdmin, ISNULL(tm.IsTeamLeader, 0) AS MyIsTeamLeader,
                   CASE WHEN tm.IsCreatedBy = 1 OR th.CreatedByUser = @User THEN 1 ELSE 0 END AS MyIsCreator,
                   CASE WHEN tf.TicketID IS NULL THEN 0 ELSE 1 END AS MyFlagged, tf.DueDate AS MyFlagDue, tf.Note AS MyFlagNote,
                   ta.UserID AS AssignedUserID, au.Username AS AssignedUsername, ISNULL(NULLIF(au.FullName, N''), au.Username) AS AssignedName,
                   sla.FirstReplyDate, sla.ReplyMinutes, sla.ReplyTarget, sla.ReplyState,
                   sla.FinishMinutes AS FinishWorkMinutes, sla.FinishTarget, sla.FinishState
            FROM CHA.TicketHistory th
            LEFT JOIN CHA.TicketMembers tm   ON tm.TicketID = th.TicketID AND tm.UserID = @UserID AND tm.IsLeft = 0
            LEFT JOIN dbo.SilaTicketFlag tf  ON tf.TicketID = th.TicketID AND tf.UserID = @UserID
            LEFT JOIN dbo.SilaTicketAssignment ta ON ta.TicketID = th.TicketID
            LEFT JOIN dbo.UserMaster au      ON au.UserID = ta.UserID
            OUTER APPLY dbo.fnSilaTicketSla(th.TicketID) sla
            LEFT JOIN CHA.TicketState ts     ON ts.StateID = th.TicketState
            LEFT JOIN CHA.ChannelMaster c    ON c.ChannelID = th.TicketChannelID
            LEFT JOIN CHA.ChannelMaster oc   ON oc.ChannelID = th.OrginalChannelID AND th.OrginalChannelID <> 0
            LEFT JOIN dbo.UserMaster cu      ON cu.Username = th.CreatedByUser
            WHERE th.TicketID = @RetTicket;
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
-- authorizes the caller itself; inputs travel in LineData (no extra parameters).
-- -------------------------------------------------------------------------
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'CHA.APISilaWebTicketOperation', N'Channel list',          N'Channels the caller can see, favorites, his open tickets / unread per channel'),
    (N'CHA.APISilaWebTicketOperation', N'Channel members',       N'Members of a visible channel (new ticket / forward pickers)'),
    (N'CHA.APISilaWebTicketOperation', N'Set channel favorite',  N'Favorite / unfavorite a visible channel'),
    (N'CHA.APISilaWebTicketOperation', N'Ticket list',           N'The caller''s tickets (open, or closed), optional channel'),
    (N'CHA.APISilaWebTicketOperation', N'Ticket messages',       N'Messages of a ticket the caller is in; admins-only notes for managers only'),
    (N'CHA.APISilaWebTicketOperation', N'Ticket members',        N'Members of a ticket the caller is in'),
    (N'CHA.APISilaWebTicketOperation', N'Ticket media',          N'Files and links of a ticket the caller is in (details panel)'),
    (N'CHA.APISilaWebTicketOperation', N'Mark ticket read',      N'Clear the caller''s unread rows for a ticket'),
    (N'CHA.APISilaWebTicketOperation', N'New ticket',            N'Open a ticket in a visible channel; roles copied from the channel'),
    (N'CHA.APISilaWebTicketOperation', N'Send ticket chat',      N'Members send while New / In Progress; admins-only notes for managers'),
    (N'CHA.APISilaWebTicketOperation', N'Send ticket file',      N'Post a file the caller uploaded to this ticket (Files API :7500); same rules as Send ticket chat'),
    (N'CHA.APISilaWebTicketOperation', N'Edit ticket chat',      N'Edit the caller''s own message (new row, OrginalChatID)'),
    (N'CHA.APISilaWebTicketOperation', N'Delete ticket chat',    N'Delete the caller''s own message (placeholder row)'),
    (N'CHA.APISilaWebTicketOperation', N'Change ticket state',   N'Start / Hold (managers), End / Reopen / Close (managers or creator)'),
    (N'CHA.APISilaWebTicketOperation', N'Forward ticket',        N'Managers forward a new ticket to a channel of the same category'),
    (N'CHA.APISilaWebTicketOperation', N'Answer forward',        N'Managers of the waiting copy accept / reject it'),
    (N'CHA.APISilaWebTicketOperation', N'Cancel forward',        N'Managers or the forwarder cancel a pending forward'),
    (N'CHA.APISilaWebTicketOperation', N'Invite ticket members', N'Members invite active users until the ticket ends; roles from the channel'),
    (N'CHA.APISilaWebTicketOperation', N'Remove ticket member',  N'Managers remove members (not the creator); anyone may leave'),
    (N'CHA.APISilaWebTicketOperation', N'Leave ticket',          N'The caller leaves a ticket; not the last admin / team leader of an open one'),
    (N'CHA.APISilaWebTicketOperation', N'Set ticket flag',       N'The caller''s own follow-up flag on a ticket he is in (due date, note)'),
    (N'CHA.APISilaWebTicketOperation', N'Remove ended ticket',   N'Home: drop an Ended ticket from the caller''s own list (his SilaHistory row) and resync his phone'),
    (N'CHA.APISilaWebTicketOperation', N'Assign ticket',         N'Managers assign the ticket to someone in it'),
    (N'CHA.APISilaWebTicketOperation', N'Ticket report',         N'Times per channel / assignee for the channels the caller manages (all for mhd)'),
    (N'CHA.APISilaWebTicketOperation', N'Take ticket',           N'A ticket admin / team leader takes an unassigned ticket'),
    (N'CHA.APISilaWebTicketOperation', N'Unassign ticket',       N'The assignee or a manager unassigns the ticket')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, N'[]', s.Notes, N'claude');
GO
