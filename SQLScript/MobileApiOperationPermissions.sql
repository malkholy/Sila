-- =========================================================================
-- Allow-list rows (PLS.V1ApiOperationPermission) for the mobile app's
-- procedures, so the app can call them through SilaApi /api/v2/exec instead
-- of the legacy gateway (:9201). The procedures are unchanged.
--
-- Through SilaApi, @User comes from the signed-in token and @IP from the
-- connection (never from the app); LineData / SqlStatement / Operation are
-- reserved. Everything else the app sends goes in extraParams and must be in
-- the operation's AllowedParametersJson -- one list per procedure, taken from
-- the live parameter lists (read 2026-10-22). @SqlStatement is reserved: the
-- procedures only log it, so the app simply stops sending it.
--
-- Left out on purpose:
--   APIGeneralOperation 'Login'           blocked by the gateway: sign in with /api/v2/auth/login
--   APIGeneralOperation 'Change Password' replaced by /api/v2/auth/change-password
--   (APIGeneralOperation 'System Users and Groups' was added disabled until
--   V_UserMaster_1 was checked; its 18 columns, read 2026-10-22, hold no
--   password hash -- profile, phones, group / department / job, photo -- so
--   it is enabled. The UPDATE at the end enables an existing disabled row.)
--
-- Known gaps these rows do NOT fix (the procedures trust any member / caller):
--   GRP 'add admin' / 'remove member' / 'Left Group' / 'Lock' / 'UNLock' have
--   no admin check; APIGeneralOperation 'Delete Notification' deletes by
--   NotificationID without checking the owner.
--
-- Idempotent: inserts missing rows; changes no existing row except the
-- 'Left side' row an earlier seed disabled for the web (re-enabled for mobile).
-- =========================================================================
DECLARE @General NVARCHAR(MAX) = N'["SilaID","NotificationID","LastChatIDOneToOne","LastChatIDGroup","MaxSeq","UnreadList","FireBaseToken","WebVersion","AndroidVersion","IOSVersion","DeskTopVerion","PlatForm"]';
DECLARE @Group   NVARCHAR(MAX) = N'["GroupID","LastChatID","MinChatID","FireBaseToken","AppVersionWeb","AppVersionAndroid","AppVersionIos","AppVersionDesktop","PlatForm"]';
DECLARE @One     NVARCHAR(MAX) = N'["SessionID","LastChatID","MinChatID","FireBaseToken","AppVersionWeb","AppVersionAndroid","AppVersionIos","AppVersionDesktop","PlatForm"]';
DECLARE @Ticket  NVARCHAR(MAX) = N'["LineMember","TicketID","TempTicketID","ChannelID","LastChatID","MinChatID","MaxSeq","FireBaseToken","AppVersionWeb","AppVersionAndroid","AppVersionIos","AppVersionDesktop","PlatForm"]';

MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    -- dbo.APIGeneralOperation
    (N'dbo.APIGeneralOperation', N'Left side',                 1, @General, N'Mobile: Home list (V_SilaHistory_1), delta by MaxSeq, app version gate'),
    (N'dbo.APIGeneralOperation', N'Get Unread Counters',       1, @General, N'Mobile: unread counts per module'),
    (N'dbo.APIGeneralOperation', N'Get General Notifications', 1, @General, N'Mobile: caller''s notifications, marks them seen'),
    (N'dbo.APIGeneralOperation', N'Delete Notification',       1, @General, N'Mobile: delete notifications by id (no owner check in the SP)'),
    (N'dbo.APIGeneralOperation', N'Hide',                      1, @General, N'Mobile: hide a conversation (SilaID)'),
    (N'dbo.APIGeneralOperation', N'UnHide',                    1, @General, N'Mobile: unhide a conversation (SilaID)'),
    (N'dbo.APIGeneralOperation', N'Logout',                    1, @General, N'Mobile: drop the caller''s Firebase token for PlatForm'),
    (N'dbo.APIGeneralOperation', N'System Users and Groups',   1, @General, N'Mobile: all users (V_UserMaster_1, no hash: checked 2026-10-22) + user groups'),
    -- One.APIOneToOneChatOperation
    (N'One.APIOneToOneChatOperation', N'Get Left-Right Side One-to-one', 1, @One, N'Mobile: one-to-one messages (LastChatID / MinChatID)'),
    (N'One.APIOneToOneChatOperation', N'Load More',   1, @One, N'Mobile: one-to-one older messages'),
    (N'One.APIOneToOneChatOperation', N'New Chat',    1, @One, N'Mobile: one-to-one send'),
    (N'One.APIOneToOneChatOperation', N'Edit Chat',   1, @One, N'Mobile: one-to-one edit'),
    (N'One.APIOneToOneChatOperation', N'Delete Chat', 1, @One, N'Mobile: one-to-one delete'),
    -- GRP.APIGroupChatOperation
    (N'GRP.APIGroupChatOperation', N'Get Left-Right Side Group', 1, @Group, N'Mobile: group messages (LastChatID / MinChatID)'),
    (N'GRP.APIGroupChatOperation', N'Load More',          1, @Group, N'Mobile: group older messages'),
    (N'GRP.APIGroupChatOperation', N'New Chat',           1, @Group, N'Mobile: group send'),
    (N'GRP.APIGroupChatOperation', N'Edit Chat',          1, @Group, N'Mobile: group edit'),
    (N'GRP.APIGroupChatOperation', N'Delete Chat',        1, @Group, N'Mobile: group delete'),
    (N'GRP.APIGroupChatOperation', N'New Group',          1, @Group, N'Mobile: create a group'),
    (N'GRP.APIGroupChatOperation', N'Edit Group',         1, @Group, N'Mobile: rename / edit a group'),
    (N'GRP.APIGroupChatOperation', N'Get Groups Members', 1, @Group, N'Mobile: group members'),
    (N'GRP.APIGroupChatOperation', N'add members',        1, @Group, N'Mobile: add members'),
    (N'GRP.APIGroupChatOperation', N'add admin',          1, @Group, N'Mobile: make a member admin (LineData = UserID; no admin check in the SP)'),
    (N'GRP.APIGroupChatOperation', N'remove member',      1, @Group, N'Mobile: remove a member (LineData = UserID; no admin check in the SP)'),
    (N'GRP.APIGroupChatOperation', N'Left Group',         1, @Group, N'Mobile: leave a group (LineData = UserID; not checked against the caller)'),
    (N'GRP.APIGroupChatOperation', N'Lock',               1, @Group, N'Mobile: lock the chat (no admin check in the SP)'),
    (N'GRP.APIGroupChatOperation', N'UNLock',             1, @Group, N'Mobile: unlock the chat (no admin check in the SP)'),
    -- CHA.APITicketOperation
    (N'CHA.APITicketOperation', N'Channel List',          1, @Ticket, N'Mobile: channels'),
    (N'CHA.APITicketOperation', N'Get Left Side Ticket',  1, @Ticket, N'Mobile: ticket list'),
    (N'CHA.APITicketOperation', N'Get Right Side Ticket', 1, @Ticket, N'Mobile: ticket messages'),
    (N'CHA.APITicketOperation', N'Get Closed Tickets',    1, @Ticket, N'Mobile: closed tickets'),
    (N'CHA.APITicketOperation', N'New Ticket',            1, @Ticket, N'Mobile: open a ticket'),
    (N'CHA.APITicketOperation', N'New Chat',              1, @Ticket, N'Mobile: ticket send'),
    (N'CHA.APITicketOperation', N'Edit Chat',             1, @Ticket, N'Mobile: ticket edit'),
    (N'CHA.APITicketOperation', N'Delete Chat',           1, @Ticket, N'Mobile: ticket delete'),
    (N'CHA.APITicketOperation', N'Start Ticket',          1, @Ticket, N'Mobile: start'),
    (N'CHA.APITicketOperation', N'Hold Ticket',           1, @Ticket, N'Mobile: hold'),
    (N'CHA.APITicketOperation', N'End Ticket',            1, @Ticket, N'Mobile: end'),
    (N'CHA.APITicketOperation', N'Close Ticket',          1, @Ticket, N'Mobile: close'),
    (N'CHA.APITicketOperation', N'Cancel Ticket',         1, @Ticket, N'Mobile: cancel'),
    (N'CHA.APITicketOperation', N'Reopen Ticket',         1, @Ticket, N'Mobile: reopen'),
    (N'CHA.APITicketOperation', N'Forward Ticket',        1, @Ticket, N'Mobile: forward (LineData = target ChannelID)'),
    (N'CHA.APITicketOperation', N'Accept Forward',        1, @Ticket, N'Mobile: accept a forward'),
    (N'CHA.APITicketOperation', N'Reject Forward',        1, @Ticket, N'Mobile: reject a forward'),
    (N'CHA.APITicketOperation', N'Invite Member',         1, @Ticket, N'Mobile: invite members (LineMember)'),
    (N'CHA.APITicketOperation', N'Left Member',           1, @Ticket, N'Mobile: remove / leave members (LineMember)'),
    (N'CHA.APITicketOperation', N'Add favorite',          1, @Ticket, N'Mobile: favorite a channel'),
    (N'CHA.APITicketOperation', N'Remove favorite',       1, @Ticket, N'Mobile: unfavorite a channel')
) AS s (ProcedureName, OperationName, Enabled, AllowedParametersJson, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN MATCHED AND t.Enabled = 0 AND t.Notes = N'Disabled: mobile router; the web uses dbo.APISilaWebOperation' THEN
    UPDATE SET Enabled = s.Enabled, AllowedParametersJson = s.AllowedParametersJson, Notes = s.Notes,
               ModifiedBy = N'claude', ModifiedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, s.Enabled, 1, s.AllowedParametersJson, s.Notes, N'claude');
GO

-- 'System Users and Groups': V_UserMaster_1 checked 2026-10-22 (no password hash) -> enabled.
UPDATE [PLS].[V1ApiOperationPermission]
SET Enabled = 1,
    Notes = N'Mobile: all users (V_UserMaster_1, no hash: checked 2026-10-22) + user groups',
    ModifiedBy = N'claude', ModifiedAt = SYSUTCDATETIME()
WHERE ProcedureName = N'dbo.APIGeneralOperation' AND OperationName = N'System Users and Groups' AND Enabled = 0;
GO

-- -------------------------------------------------------------------------
-- The app's own spellings. The procedures compare @Operation case-insensitively,
-- but this table (and so the gateway) matches the exact spelling: the mobile
-- app sends these names (as in GLC Sila / Sila-Web api-endpoints.ts), so each
-- gets its own row with the same parameters as the row it mirrors. 2026-10-22.
-- -------------------------------------------------------------------------
INSERT INTO [PLS].[V1ApiOperationPermission]
    (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
SELECT p.ProcedureName, v.AppSpelling, p.Enabled, p.AllowExternal, p.AllowedParametersJson,
       N'App spelling of ''' + p.OperationName + N''' (same operation)', N'claude'
FROM (VALUES
    (N'dbo.APIGeneralOperation',   N'Left side',     N'Left Side'),
    (N'GRP.APIGroupChatOperation', N'UNLock',        N'Unlock'),
    (N'GRP.APIGroupChatOperation', N'add members',   N'add Members'),
    (N'GRP.APIGroupChatOperation', N'remove member', N'Remove Member'),
    (N'CHA.APITicketOperation',    N'Reopen Ticket', N'reopen Ticket')
) AS v (ProcedureName, OperationName, AppSpelling)
JOIN [PLS].[V1ApiOperationPermission] p ON p.ProcedureName = v.ProcedureName AND p.OperationName = v.OperationName
WHERE NOT EXISTS (SELECT 1 FROM [PLS].[V1ApiOperationPermission] x
                  WHERE x.ProcedureName = v.ProcedureName AND x.OperationName = v.AppSpelling);
GO

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

-- -------------------------------------------------------------------------
-- CHA.APITicketOperation ticket flag (2026-10-23, SQLScript/APITicketOperationFlag.sql):
-- the caller's own follow-up flag (dbo.SilaTicketFlag). @TicketID in
-- extraParams, DueDate / Note in LineData.
-- -------------------------------------------------------------------------
DECLARE @TicketFlag NVARCHAR(MAX) = N'["TicketID","FireBaseToken","AppVersionWeb","AppVersionAndroid","AppVersionIos","AppVersionDesktop","PlatForm"]';
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'CHA.APITicketOperation', N'Set Ticket Flag',   N'Mobile: flag a ticket for yourself (due date, note)'),
    (N'CHA.APITicketOperation', N'Clear Ticket Flag', N'Mobile: clear your own ticket flag')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, @TicketFlag, s.Notes, N'claude');
GO

-- -------------------------------------------------------------------------
-- CHA.APITicketOperation ticket assignment (2026-10-23, dbo.SilaTicketAssignment):
-- @TicketID in extraParams; Assign: LineData = the UserID.
-- -------------------------------------------------------------------------
DECLARE @TicketAssign NVARCHAR(MAX) = N'["TicketID","FireBaseToken","AppVersionWeb","AppVersionAndroid","AppVersionIos","AppVersionDesktop","PlatForm"]';
MERGE [PLS].[V1ApiOperationPermission] AS t
USING (VALUES
    (N'CHA.APITicketOperation', N'Assign Ticket',   N'Mobile: managers assign the ticket to someone in it'),
    (N'CHA.APITicketOperation', N'Take Ticket',     N'Mobile: a non-CC member takes an unassigned ticket'),
    (N'CHA.APITicketOperation', N'Unassign Ticket', N'Mobile: the assignee or a manager unassigns it')
) AS s (ProcedureName, OperationName, Notes)
ON t.ProcedureName = s.ProcedureName AND t.OperationName = s.OperationName
WHEN NOT MATCHED THEN
    INSERT (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson, Notes, ModifiedBy)
    VALUES (s.ProcedureName, s.OperationName, 1, 1, @TicketAssign, s.Notes, N'claude');
GO
