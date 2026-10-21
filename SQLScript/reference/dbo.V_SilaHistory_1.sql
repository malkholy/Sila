-- Snapshot of the LIVE [dbo].[V_SilaHistory_1] in SILA101 (via the :9101 gateway), read via sila-db on 2026-10-21.
-- Reference only. Feeds APIGeneralOperation 'Left side' (the Home list).
	CREATE View [dbo].[V_SilaHistory_1] as
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
					 a.TaskID , ( select x.StateDescription from Task.TaskState x where x.StateID=a.TaskState and TicketID<>0 ) as TaskStateDescription , TaskState , TaskSubject , a.SynSequence
			From  SilaHistory a 
