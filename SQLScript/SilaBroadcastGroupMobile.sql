USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- Broadcast groups for the mobile app: IsBroadcast (1 / 0) on the two views
-- the mobile procedures return with SELECT *, so every mobile answer that
-- carries a group says whether it is a broadcast group (dbo.SilaGroupType,
-- SilaBroadcastGroup.sql) -- no change to the procedures themselves.
--
--   GRP.V_GroupMaster_1   every GRP.APIGroupChatOperation answer with the group
--                         row: 'Get Left-Right Side Group', 'New Chat',
--                         'Edit Chat', 'Delete Chat', 'Lock' / 'UNLock',
--                         'add members', 'add admin', 'remove member',
--                         'Left Group', 'New Group', 'Edit Group'
--   dbo.V_SilaHistory_1   dbo.APIGeneralOperation 'Left side' (the Home list);
--                         1 only on group rows (RecordType 'G')
--
-- IsBroadcast is the LAST column of each view, so the existing columns keep
-- their positions. Both views are otherwise the live definitions as read on
-- 2026-10-28 (unchanged).
--
-- The Home list is sent as a delta (SilaHistory.SynSequence > the app's
-- MaxSeq): a phone sees IsBroadcast on a Home row the next time that row
-- changes (any new message in the group) or on its next full sync.
-- Idempotent (CREATE OR ALTER). Deploy with deploy.sh or in SSMS.
-- =========================================================================
CREATE OR ALTER VIEW [GRP].[V_GroupMaster_1] AS

select	a.GroupID , a.Name  ,
					a.LastMessage ,
					a.LastMaintDate ,
					a.LastChatID ,
					0  as UnreadMessages , a.ChatIsLocked , a.AttachmentID , t.FileName , t.FileURL ,
					CASE WHEN EXISTS (SELECT 1 FROM dbo.SilaGroupType b WHERE b.GroupID = a.GroupID AND b.GroupType = 'Broadcast')
					     THEN 1 ELSE 0 END AS IsBroadcast
			From Grp .GroupMaster a left outer join AttachmentHistory t on t.AttachmentID=a.attachmentID
GO

CREATE OR ALTER VIEW [dbo].[V_SilaHistory_1] AS
	select	a.SilaID , a.userid ,
					a.SessionID ,
					a.OtherUserID as FromUserID ,
					( select x.FullName from UserMaster x  where x.userid=a.OtherUserID ) as FromName ,
					a.Groupid  , ( select x.Name from grp.GroupMaster x where x.GroupID=a.GroupID ) as GroupName ,
					a.LastMessage ,
					a.LastMaintDate ,
					a.LastChatID ,
					a.UnreadMessage ,
					a.RecordType  ,
					( select Count(*) from SilaHideHistory x where x.SilaID=a.SilaID and x.UserID=a.UserID ) IsHidden , TicketID , ChannelID ,
					( select x.Name from cha.ChannelMaster x where x.ChannelID=a.ChannelID ) as ChannelName ,
					( select x.StateDescription from cha.TicketState x where x.StateID=a.TicketState and TicketID<>0 ) as TicketStateDescription   , TicketState , TicketSubject ,
					 MailId , MailSubject , ( select x.StateDescription from MAIL.MailState x where x.StateID=a.TicketState and MailID<>0 ) as MailStateDescription , MailState ,
					 ( select z.FullName from cha.TicketHistory x left outer join usermaster z on z.Username=x.CreatedByUser    where RecordType='C' and a.TicketID=x.TicketID  ) TicketCreatedBy ,
					 ( select z.FullName from mail.MailHistory x left outer join usermaster z on z.Username=x.CreatedByUser    where RecordType='M' and a.MailID=x.MailID  ) MailCreatedBy ,
					 a.TaskID , ( select x.StateDescription from Task.TaskState x where x.StateID=a.TaskState and TicketID<>0 ) as TaskStateDescription , TaskState , TaskSubject , a.SynSequence ,
					 CASE WHEN a.RecordType = 'G' AND EXISTS (SELECT 1 FROM dbo.SilaGroupType b WHERE b.GroupID = a.GroupID AND b.GroupType = 'Broadcast')
					      THEN 1 ELSE 0 END AS IsBroadcast
			From  SilaHistory a
GO
