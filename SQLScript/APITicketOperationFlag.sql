USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [CHA].[APITicketOperation] -- the MOBILE app's LIVE procedure as it was on
-- 2026-10-23 (unchanged since 2026-04-05; SQLScript/reference/CHA.APITicketOperation.sql),
-- with ONLY these changes:
-- (1) the ticket follow-up flag (dbo.SilaTicketFlag, SQLScript/SilaTicketFlag.sql):
--   * new operations 'Set Ticket Flag' / 'Clear Ticket Flag' (@TicketID, @LineData);
--   * three columns at the END of every ticket row it returns (from
--     CHA.V_TicketHistory: the ticket lists and the row after each action):
--     IsFlagged, FlagDueDate, FlagNote.
-- (3) ticket assignment (dbo.SilaTicketAssignment, SQLScript/SilaTicketAssignment.sql):
--   * new operations 'Assign Ticket' / 'Take Ticket' / 'Unassign Ticket' (@TicketID,
--     @LineData = UserID for Assign; Assign and Take: ticket admins / team leaders);
--     Left Member drops the leaver's assignment;
--   * AssignedUserID, AssignedName after the flag columns on every ticket row.
-- (2) the forward operations ('Forward Ticket', 'Accept Forward', 'Reject Forward',
--     'Cancel Ticket') rewritten with the web's rules -- see the comment above them:
--     role checks, the ticket's own channel and category, the target's admins /
--     team leaders + the creator always in the copy, every row on the target
--     channel, system lines, transactions, unread recount, Home-row clean-up.
-- (4) 'Invite Member': ticket admins / team leaders only; IsAdmin in @LineMember
--     also applies to someone brought back; the system line says "as admin".
-- Every other operation, column and result set is as before.
-- Not the rewrite in SQLScript/APITicketOperation.sql (that one still waits for
-- the app owner's go-ahead).
-- Run in SSMS: the original drops #TempChat, which deploy.sh refuses.
-- =========================================================================
CREATE OR ALTER PROCEDURE [CHA].[APITicketOperation]
    @Operation nvarchar(250), 
    @LineData nvarchar(max) = '', 
	@LineMember nvarchar(max)='', 
	@TicketID int =0 , 
	@TempTicketID int =0 , 
	@ChannelID int =0 , 
	@LastChatID int =0 ,
	@MinChatID int =0 , 
	@MaxSeq int=0 , 
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
as
begin
--begin try 
--begin Transaction 
    set nocount on;
    set @State = 0;
    set @Message = '';

    declare @Inactive int = 1 ,  @ForwardedCategoryID int =0 , @OrginalCategoryID int=0 , @ForwardChannelID int =0 , @OrginlChannelID int =0 , @ForwardedTicketID int=0 , @IsAdminChat int =0 
    declare @LineQuery nvarchar(max) , @ErrorMessage nvarchar(max) ='' , @ForceFullSync int=0
    declare @ID int, @ChatID int,  @FromUserID int, @  int;
    declare @ToUserName nvarchar(50)=0 , @Text nvarchar(max)='', @ReplayMsgID int =0  , @ticketState int =0 
    declare @IsDeleted int, @TextStyle nvarchar(max), @IsSeen int, @SeenDate datetime;
    declare @SendingAttempt int=0 , @AttachmentID int =0 , @IsSend int =0 , @SendDate date;
    declare @LocalChatID int =0 , @OrginalChatID int =0 , @IsEdited int=0  , @UserID int =0 , @Cnt int =0 , @Flag int =0 , @LogID int =0 
	declare  @GroupName nvarchar(max)='' , @MemberUserID int =0 ,  @IsGroupAdmin int =0 , @FullName nvarchar(max)='' 
	declare @TicketSubject nvarchar(max), @TicketChannelID int, @ForwardDate datetime, @ForwardBy nvarchar(50), @OrginalTicketID int, @OrginalChannelID int , @TicketText nvarchar(max) = ''

    select @Inactive = IsNotActive , @UserID = UserID , @FullName = FullName  from UserMaster where Username = @User;

    if @Inactive = 0
    begin
        insert into SPUserLog (maxSeq , Username, ModuleName, SPName, SPOperation, AndroidVersion, DeskTopVerion, WebVersion, IOSVersion, CreatedDate, platForm, FireBaseToken, SqlStatement, lineData , TicketTempID , TicketID )
        values (@MaxSeq ,  @User, 'Channel', 'CHA.APITicketOperation', @Operation, @AppVersionAndroid, @AppVersionDesktop, @AppVersionWeb, @AppVersionIos, getdate(), @PlatForm, @FireBaseToken, @SqlStatement, @LineData , @TempTicketID , @TicketID );
		set @LogID= SCOPE_IDENTITY()
		create table #TempChat (
        ChatID int, TicketID int,   Text nvarchar(max), TextStyle nvarchar(max) ,  ReplayMsgID int, LocalChatID int, OrginalChatID int  , IsAdmin int );

		create table #TempTicketHistory 
		( TicketSubject nvarchar(max), TicketChannelID int , TicketText nvarchar(max) );

		create table #TempMember 
		(UserID int  , IsAdmin int  , IsTeamLeader  int  , IsCreatedBy int , IsCC int  ) 


		create table #TempMemberFor 
		(UserID int  , IsAdmin int  , IsTeamLeader  int  , IsCreatedBy int , IsCC int , IsInvited int  ) 

		--------Table Version 
		select * from ApplicationTableVersion
		select a.PlatFormName , a.VersionNo  from SoftwareVersionHistory a where IsNotActive=0 
		------
	

		exec APIUserFirebaseHistory @firebaseToken=@FirebaseToken ,@PlatForm =@PlatForm ,  @user=@user 
		if @Operation='Add favorite'
		begin
			delete from cha.ChannelUserFavorite where ChannelID=@ChannelID and UserID=@userID 
			insert into cha.ChannelUserFavorite 
			( ChannelID , userid ) 
			values 
			( @ChannelID , @Userid ) 
		end 
		if @Operation='Remove favorite'
		begin
			delete from cha.ChannelUserFavorite where ChannelID=@ChannelID and UserID=@userID 
			
		end 
		-- ---------------------------------------------------------------
		-- Ticket flag (added 2026-10-23): the caller's own follow-up flag on a
		-- ticket he is in (dbo.SilaTicketFlag), private to him; the web app
		-- shows the same flag. @TicketID = the ticket; Set: @LineData =
		-- {"DueDate":"yyyy-mm-dd" (optional), "Note":"..." (optional, 300 max)}.
		-- Returns { TicketID, IsFlagged, FlagDueDate, FlagNote } after the
		-- table-version result sets, like every operation here.
		-- ---------------------------------------------------------------
		if @Operation in ('Set Ticket Flag', 'Clear Ticket Flag')
		begin
			if not exists ( select 1 from cha.TicketMembers where TicketID=@TicketID and UserID=@UserID and IsLeft=0 )
			begin
				set @State = 1 ; set @Message = 'Ticket not found' ;
				return ;
			end
			if @Operation = 'Clear Ticket Flag'
				delete from dbo.SilaTicketFlag where TicketID=@TicketID and UserID=@UserID
			else
			begin
				declare @FlagDue nvarchar(30) = case when isjson(@LineData)=1 then nullif(ltrim(rtrim(json_value(@LineData, '$.DueDate'))), '') end ,
				        @FlagNote nvarchar(max) = case when isjson(@LineData)=1 then ltrim(rtrim(isnull(json_value(@LineData, '$.Note'), ''))) else '' end
				if @FlagDue is not null and try_convert(date, @FlagDue, 23) is null
				begin
					set @State = 1 ; set @Message = 'The due date is not valid' ;
					return ;
				end
				if len(@FlagNote) > 300
				begin
					set @State = 1 ; set @Message = 'The note can be at most 300 characters' ;
					return ;
				end
				update dbo.SilaTicketFlag set DueDate = try_convert(date, @FlagDue, 23) , Note = @FlagNote , LastMaintDate = getdate()
				where TicketID=@TicketID and UserID=@UserID
				if @@rowcount = 0
					insert into dbo.SilaTicketFlag ( TicketID , UserID , DueDate , Note )
					values ( @TicketID , @UserID , try_convert(date, @FlagDue, 23) , @FlagNote )
			end
			select @TicketID as TicketID ,
			       case when f.TicketID is null then 0 else 1 end as IsFlagged , f.DueDate as FlagDueDate , isnull(f.Note, '') as FlagNote
			from ( select 1 as one ) z left join dbo.SilaTicketFlag f on f.TicketID=@TicketID and f.UserID=@UserID
		end

		
		-- ---------------------------------------------------------------
		-- Assignment (added 2026-10-23): who owns the ticket (dbo.SilaTicketAssignment),
		-- the same rules as the web. @TicketID = the ticket.
		--   'Assign Ticket'   @LineData = the UserID; ticket admins / team leaders,
		--                     anyone in the ticket
		--   'Take Ticket'     ticket admins / team leaders, while nobody has it
		--   'Unassign Ticket' the assignee or a ticket admin / team leader
		-- Open tickets only; a system line each time; returns the ticket row.
		-- ---------------------------------------------------------------
		if @Operation in ('Assign Ticket', 'Take Ticket', 'Unassign Ticket')
		begin
			declare @AsState int , @AsChannel int , @AsManager int = 0 , @AsCC int = 0 , @AsMember int = 0 ,
			        @AsCurrent int , @AsTarget int , @AsName nvarchar(max) , @AsText nvarchar(max)
			select @AsState = th.TicketState , @AsChannel = th.TicketChannelID , @AsMember = 1 ,
			       @AsManager = case when tm.IsAdmin = 1 or tm.IsTeamLeader = 1 then 1 else 0 end ,
			       @AsCC = case when tm.IsCC = 1 then 1 else 0 end
			from cha.TicketHistory th
			join cha.TicketMembers tm on tm.TicketID = th.TicketID and tm.UserID = @UserID and tm.IsLeft = 0
			where th.TicketID = @TicketID
			if @AsMember = 0 begin set @State = 1 ; set @Message = 'Ticket not found' ; return ; end
			if @AsState >= 50 begin set @State = 1 ; set @Message = 'This ticket is closed' ; return ; end
			select @AsCurrent = UserID from dbo.SilaTicketAssignment where TicketID = @TicketID
			if @Operation = 'Assign Ticket'
			begin
				if @AsManager = 0 begin set @State = 1 ; set @Message = 'Only ticket admins and team leaders can assign a ticket' ; return ; end
				set @AsTarget = try_cast(@LineData as int)
			end
			else if @Operation = 'Take Ticket'
			begin
				if @AsManager = 0 begin set @State = 1 ; set @Message = 'Only ticket admins and team leaders can take a ticket' ; return ; end
				if @AsCurrent is not null and @AsCurrent <> @UserID begin set @State = 1 ; set @Message = 'Someone already has this ticket' ; return ; end
				set @AsTarget = @UserID
			end
			else
			begin
				if @AsCurrent is null begin set @State = 1 ; set @Message = 'Nobody has this ticket' ; return ; end
				if @AsManager = 0 and @AsCurrent <> @UserID begin set @State = 1 ; set @Message = 'Only the assignee or a ticket admin / team leader can unassign it' ; return ; end
			end
			if @Operation <> 'Unassign Ticket'
			begin
				select @AsName = isnull(nullif(u.FullName, ''), u.Username)
				from cha.TicketMembers tm join UserMaster u on u.UserID = tm.UserID and u.IsNotActive = 0
				where tm.TicketID = @TicketID and tm.UserID = @AsTarget and tm.IsLeft = 0
				if @AsName is null begin set @State = 1 ; set @Message = 'Only someone in the ticket can be assigned' ; return ; end
				set @AsText = case when @AsTarget = @UserID then '@' + @FullName + ' took this ticket'
				                   else '@' + @FullName + ' assigned this ticket to @' + @AsName end
			end
			else
				set @AsText = '@' + @FullName + ' unassigned this ticket ('
				              + isnull(( select '@' + isnull(nullif(FullName, ''), Username) from UserMaster where UserID = @AsCurrent ), '') + ')'
			if isnull(@AsCurrent, 0) <> isnull(@AsTarget, 0) or @Operation = 'Unassign Ticket'
			begin
				begin try
					begin transaction
					if @Operation = 'Unassign Ticket'
						delete from dbo.SilaTicketAssignment where TicketID = @TicketID
					else
					begin
						update dbo.SilaTicketAssignment set UserID = @AsTarget , AssignedBy = @User , AssignedDate = getdate() where TicketID = @TicketID
						if @@rowcount = 0 insert into dbo.SilaTicketAssignment ( TicketID , UserID , AssignedBy ) values ( @TicketID , @AsTarget , @User )
					end
					set @ChatID = next value for dbo.ChatTicket
					insert into cha.TicketChatHistory ( ChatID , TicketID , FromUserID , FromUserName , Text , TextStyle , ReplayMsgID , CreatedDate , AttachmentID , LocalChatID , ChannelID , IsSystem )
					values ( @ChatID , @TicketID , @UserID , @User , @AsText , @AsText , 0 , getdate() , 0 , 0 , @AsChannel , 1 )
					update cha.TicketHistory set LastMaintDate = getdate() , LastMaintByUser = @User where TicketID = @TicketID
					commit transaction
				end try
				begin catch
					if @@trancount > 0 rollback transaction
					set @State = 1 ; set @Message = 'Assignment failed: ' + left(error_message(), 400) ;
					return ;
				end catch
			end
			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 
		end

		-- ===============================================================
		-- Forwarding (rewritten 2026-10-23; same parameters and result sets
		-- as before). The same rules as the web (CHA.APISilaWebTicketOperation):
		--   * Forward Ticket: ticket admins / team leaders of a New ticket; the
		--     target (@LineData = ChannelID) must be another active channel the
		--     caller can see, in the SAME category as the ticket's own channel
		--     (not the @ChannelID the app sends). The copy's members: the target
		--     channel's admins / team leaders (always), the people in @LineMember
		--     (roles from the target channel, IsCC kept), the ticket's creator;
		--     every row on the target channel. A system line on both tickets.
		--   * Accept / Reject Forward: admins / team leaders of the waiting copy
		--     (state 3) whose original is still Forwarded (2). Accept recounts the
		--     unread badges; both clean up Home rows (the member triggers handle
		--     one row only) and, on Reject, the copy's messages.
		--   * Cancel Ticket (cancel a forward): ticket admins / team leaders or
		--     whoever forwarded it; now posts a system line.
		--   * Each one runs in a transaction; a refusal returns @State = 1.
		-- ===============================================================
		IF (@Operation in ('Forward Ticket', 'Accept Forward', 'Reject Forward', 'Cancel Ticket'))
		begin
			declare @FwChannel int , @FwState int , @FwManager int = 0 , @FwMember int = 0 , @FwCreatedBy nvarchar(50) = '' ,
			        @FwForwardBy nvarchar(50) = '' , @FwOrig int = 0 , @FwOrigChannel int = 0 , @FwCopy int , @FwText nvarchar(max) ,
			        @FwToName nvarchar(100) , @FwFromName nvarchar(100) , @FwCreatorID int
			select @FwChannel = th.TicketChannelID , @FwState = th.TicketState , @FwCreatedBy = isnull(th.CreatedByUser, '') ,
			       @FwForwardBy = isnull(th.ForwardBy, '') , @FwOrig = isnull(th.OrginalTicketID, 0) , @FwOrigChannel = isnull(th.OrginalChannelID, 0) ,
			       @FwMember = 1 , @FwManager = case when tm.IsAdmin = 1 or tm.IsTeamLeader = 1 then 1 else 0 end
			from cha.TicketHistory th
			join cha.TicketMembers tm on tm.TicketID = th.TicketID and tm.UserID = @UserID and tm.IsLeft = 0
			where th.TicketID = @TicketID
			if @FwMember = 0
			begin
				set @State = 1 ; set @Message = 'Ticket not found' ;
				return ;
			end
		end

		IF (@Operation = 'Forward Ticket')
		begin
			if @FwManager = 0
			begin
				set @State = 1 ; set @Message = 'Only ticket admins and team leaders can forward a ticket' ;
				return ;
			end
			if @FwState <> 0
			begin
				set @State = 1 ; set @Message = 'Ticket State is not Correct ' ;
				return ;
			end
			set @ForwardChannelID = try_cast(@LineData as int)
			if @ForwardChannelID is null or @ForwardChannelID = @FwChannel
			   or not exists ( select 1 from cha.ChannelMaster c where c.ChannelID = @ForwardChannelID and isnull(c.InActive, 0) = 0
			                   and ( ltrim(rtrim(isnull(c.IsPrivate, '0'))) <> '1'
			                         or exists ( select 1 from cha.ChannelMembers m where m.ChannelID = c.ChannelID and m.UserID = @UserID ) ) )
			begin
				set @State = 1 ; set @Message = 'Pick another channel' ;
				return ;
			end
			if ( select CategoryID from cha.ChannelMaster where ChannelID = @ForwardChannelID )
			   <> ( select CategoryID from cha.ChannelMaster where ChannelID = @FwChannel )
			begin
				set @State = 1 ; set @Message = 'Forwarding Ticket is not Allowed ' ;
				return ;
			end

			declare @FwMembers table ( UserID int primary key , IsAdmin int , IsTeamLeader int , IsCreatedBy int , IsCC int )
			insert into @FwMembers ( UserID , IsAdmin , IsTeamLeader , IsCreatedBy , IsCC )
			select cm.UserID , cm.IsAdmin , cm.IsTeamLeader , 0 , 0
			from cha.ChannelMembers cm join UserMaster u on u.UserID = cm.UserID and u.IsNotActive = 0
			where cm.ChannelID = @ForwardChannelID and ( cm.IsAdmin = 1 or cm.IsTeamLeader = 1 )
			if isjson(@LineMember) = 1
				insert into @FwMembers ( UserID , IsAdmin , IsTeamLeader , IsCreatedBy , IsCC )
				select x.UserID , isnull(max(cm.IsAdmin), 0) , isnull(max(cm.IsTeamLeader), 0) , 0 , max(case when x.IsCC = 1 then 1 else 0 end)
				from openjson(@LineMember) with ( UserID int , IsCC int ) x
				join UserMaster u on u.UserID = x.UserID and u.IsNotActive = 0
				left join cha.ChannelMembers cm on cm.ChannelID = @ForwardChannelID and cm.UserID = x.UserID
				where not exists ( select 1 from @FwMembers f where f.UserID = x.UserID )
				group by x.UserID
			select @FwCreatorID = UserID from UserMaster where Username = @FwCreatedBy and IsNotActive = 0
			if @FwCreatorID is not null
			begin
				update @FwMembers set IsCreatedBy = 1 where UserID = @FwCreatorID
				if @@rowcount = 0 insert into @FwMembers values ( @FwCreatorID , 0 , 0 , 1 , 0 )
			end
			if not exists ( select 1 from @FwMembers where IsAdmin = 1 or IsTeamLeader = 1 )
			begin
				set @State = 1 ; set @Message = 'That channel has no admin or team leader to accept the ticket' ;
				return ;
			end
			select @FwToName = Name from cha.ChannelMaster where ChannelID = @ForwardChannelID
			select @FwFromName = Name from cha.ChannelMaster where ChannelID = @FwChannel

			begin try
				begin transaction
				set @FwText = '@' + @FullName + ' has Forwarded Ticket #' + convert(nvarchar, @TicketID) + ' to # ' + isnull(@FwToName, '')
				set @ChatID = next value for dbo.ChatTicket
				insert into cha.TicketChatHistory ( ChatID , TicketID , FromUserID , FromUserName , Text , TextStyle , ReplayMsgID , CreatedDate , LocalChatID , ChannelID , IsSystem )
				values ( @ChatID , @TicketID , @UserID , @User , @FwText , @FwText , 0 , getdate() , 0 , @FwChannel , 1 )
				update cha.TicketHistory set TicketState = 2 , ForwardDate = getdate() , ForwardBy = @User , LastMaintDate = getdate() , LastMaintByUser = @User
				where TicketID = @TicketID

				set @FwCopy = next value for dbo.TicketID
				insert into cha.TicketHistory ( TicketID , TicketSubject , CreatedByUser , CreatedDate , TicketChannelID , OrginalChannelID , OrginalTicketID ,
				                                TicketState , LastMaintDate , LastMaintByUser , ForwardDate , ForwardBy )
				select @FwCopy , TicketSubject , CreatedByUser , getdate() , @ForwardChannelID , TicketChannelID , TicketID , 3 , getdate() , @User , getdate() , @User
				from cha.TicketHistory where TicketID = @TicketID
				insert into cha.TicketMembers ( ChannelID , TicketID , UserID , IsAdmin , IsTeamLeader , IsCreatedBy , IsCC , IsMuted , IsInvited )
				select @ForwardChannelID , @FwCopy , UserID , IsAdmin , IsTeamLeader , IsCreatedBy , IsCC , 0 , 0 from @FwMembers
				-- the insert trigger adds one Home row per inserted member; make sure every member has one
				insert into SilaHistory ( RecordType , TicketID , UserID , ChannelID , TicketSubject )
				select 'C' , @FwCopy , f.UserID , @ForwardChannelID , ( select TicketSubject from cha.TicketHistory where TicketID = @FwCopy )
				from @FwMembers f
				where not exists ( select 1 from SilaHistory sh where sh.RecordType = 'C' and sh.TicketID = @FwCopy and sh.UserID = f.UserID )

				set @FwText = '@' + @FullName + ' forwarded this ticket from # ' + isnull(@FwFromName, '') + ' (Ticket #' + convert(nvarchar, @TicketID) + '). Accept or reject it.'
				set @ChatID = next value for dbo.ChatTicket
				insert into cha.TicketChatHistory ( ChatID , TicketID , FromUserID , FromUserName , Text , TextStyle , ReplayMsgID , CreatedDate , LocalChatID , ChannelID , IsSystem )
				values ( @ChatID , @FwCopy , @UserID , @User , @FwText , @FwText , 0 , getdate() , 0 , @ForwardChannelID , 1 )
				commit transaction
			end try
			begin catch
				if @@trancount > 0 rollback transaction
				set @State = 1 ; set @Message = 'Forward failed: ' + left(error_message(), 400) ;
				return ;
			end catch
			set @TicketID = @FwCopy
			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 
		end

		IF (@Operation in ('Accept Forward', 'Reject Forward'))
		begin
			if @FwManager = 0
			begin
				set @State = 1 ; set @Message = 'Only the channel''s ticket admins and team leaders can answer a forward' ;
				return ;
			end
			if @FwState <> 3 or @FwOrig = 0 or not exists ( select 1 from cha.TicketHistory where TicketID = @FwOrig and TicketState = 2 )
			begin
				set @State = 1 ; set @Message = 'Ticket State is not Correct ' ;
				return ;
			end
			begin try
				begin transaction
				if @Operation = 'Accept Forward'
				begin
					set @FwText = '@' + @FullName + ' has accepted forwarded Ticket #' + convert(nvarchar, @TicketID)
					-- keep a copy of the original, then retire it; the old team's admins-only notes stay behind
					insert into cha.TicketHistoryForward select * from cha.TicketHistory where TicketID = @FwOrig
					delete from cha.TicketChatHistory where TicketID = @FwOrig and IsAdmin = 1
					update cha.TicketChatHistory set ChannelID = @FwChannel , TicketID = @TicketID where TicketID = @FwOrig
					update cha.TicketUnreadChat set TicketID = @TicketID , ChannelID = @FwChannel
					where TicketID = @FwOrig and UserID in ( select x.UserID from cha.TicketMembers x where x.TicketID = @TicketID and x.IsLeft = 0 )
					delete from cha.TicketUnreadChat where TicketID = @FwOrig
					delete from cha.TicketMembers where TicketID = @FwOrig
					delete from dbo.SilaTicketAssignment where TicketID = @FwOrig
					delete from SilaHistory where TicketID = @FwOrig and RecordType = 'C'
					delete from cha.TicketHistory where TicketID = @FwOrig
					update cha.TicketHistory set TicketState = 0 , LastMaintDate = getdate() , LastMaintByUser = @User where TicketID = @TicketID
					set @ChatID = next value for dbo.ChatTicket
					insert into cha.TicketChatHistory ( ChatID , TicketID , FromUserID , FromUserName , Text , TextStyle , ReplayMsgID , CreatedDate , AttachmentID , LocalChatID , ChannelID , IsSystem )
					values ( @ChatID , @TicketID , @UserID , @User , @FwText , @FwText , 0 , getdate() , 0 , 0 , @FwChannel , 1 )
					-- moving rows re-ran the message trigger on old rows: recount everyone's unread for this ticket
					update tm set tm.UnreadCount = ( select count(*) from cha.TicketUnreadChat u where u.TicketID = tm.TicketID and u.UserID = tm.UserID )
					from cha.TicketMembers tm where tm.TicketID = @TicketID
					update sh set sh.UnreadMessage = isnull(tm.UnreadCount, 0)
					from SilaHistory sh join cha.TicketMembers tm on tm.TicketID = sh.TicketID and tm.UserID = sh.UserID
					where sh.TicketID = @TicketID and sh.RecordType = 'C'
				end
				else
				begin
					set @FwText = '@' + @FullName + ' has rejected forwarded Ticket #' + convert(nvarchar, @TicketID)
					delete from cha.TicketUnreadChat where TicketID = @TicketID
					delete from cha.TicketChatHistory where TicketID = @TicketID
					delete from cha.TicketMembers where TicketID = @TicketID
					delete from dbo.SilaTicketAssignment where TicketID = @TicketID
					delete from SilaHistory where TicketID = @TicketID and RecordType = 'C'
					delete from cha.TicketHistory where TicketID = @TicketID
					update cha.TicketHistory set TicketState = 0 , LastMaintDate = getdate() , LastMaintByUser = @User where TicketID = @FwOrig
					set @ChatID = next value for dbo.ChatTicket
					insert into cha.TicketChatHistory ( ChatID , TicketID , FromUserID , FromUserName , Text , TextStyle , ReplayMsgID , CreatedDate , AttachmentID , LocalChatID , ChannelID , IsSystem )
					values ( @ChatID , @FwOrig , @UserID , @User , @FwText , @FwText , 0 , getdate() , 0 , 0 , @FwOrigChannel , 1 )
				end
				commit transaction
			end try
			begin catch
				if @@trancount > 0 rollback transaction
				set @State = 1 ; set @Message = 'The answer failed: ' + left(error_message(), 400) ;
				return ;
			end catch
			-- as before: the accepted copy's row (a rejected copy is gone: no row)
			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 
		end

		IF (@Operation = 'Cancel Ticket')
		begin
			if @FwManager = 0 and @FwForwardBy <> @User
			begin
				set @State = 1 ; set @Message = 'Only ticket admins, team leaders or whoever forwarded it can cancel the forward' ;
				return ;
			end
			if @FwState <> 2
			begin
				set @State = 1 ; set @Message = 'Ticket State is not Correct ' ;
				return ;
			end
			select top (1) @ForwardedTicketID = TicketID from cha.TicketHistory where OrginalTicketID = @TicketID and TicketState = 3 order by TicketID desc
			begin try
				begin transaction
				if isnull(@ForwardedTicketID, 0) <> 0
				begin
					delete from cha.TicketUnreadChat where TicketID = @ForwardedTicketID
					delete from cha.TicketChatHistory where TicketID = @ForwardedTicketID
					delete from cha.TicketMembers where TicketID = @ForwardedTicketID
					delete from dbo.SilaTicketAssignment where TicketID = @ForwardedTicketID
					delete from SilaHistory where TicketID = @ForwardedTicketID and RecordType = 'C'
					delete from cha.TicketHistory where TicketID = @ForwardedTicketID
				end
				update cha.TicketHistory set TicketState = 0 , LastMaintDate = getdate() , LastMaintByUser = @User where TicketID = @TicketID
				set @FwText = '@' + @FullName + ' has cancelled the forward of Ticket #' + convert(nvarchar, @TicketID)
				set @ChatID = next value for dbo.ChatTicket
				insert into cha.TicketChatHistory ( ChatID , TicketID , FromUserID , FromUserName , Text , TextStyle , ReplayMsgID , CreatedDate , AttachmentID , LocalChatID , ChannelID , IsSystem )
				values ( @ChatID , @TicketID , @UserID , @User , @FwText , @FwText , 0 , getdate() , 0 , 0 , @FwChannel , 1 )
				commit transaction
			end try
			begin catch
				if @@trancount > 0 rollback transaction
				set @State = 1 ; set @Message = 'Cancel failed: ' + left(error_message(), 400) ;
				return ;
			end catch
			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 
		end
		if @operation='Get Closed Tickets'
		begin
			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a 
					where --- a.TicketChannelID=@ChannelID and 
					 a.TicketID in ( select  x.TicketID from cha.TicketMembers  x where UserID=@userID and IsLeft=0  ) and TicketState=50
		end
		
		IF (@Operation = 'Get Left Side Ticket') 
		begin
			select @Cnt=count(*) from UserSyncMaster where userid=@userID
			if @Cnt=0
			begin
				insert into UserSyncMaster 
				( UserID , ForceFullSync , LastForceSyncDate )
				values
				(@userID , 0 , getdate() )
				set @ForceFullSync=1
			end
			else
			begin
				select @ForceFullSync = ForceFullSync  from UserSyncMaster where UserID=@UserID
			end

			if @ForceFullSync=1
			begin
				set @MaxSeq =0 
				update UserSyncMaster set ForceFullSync=0 , LastForceSyncDate=GETDATE() where UserID=@userID
			end

			if @ChannelID<>0
			begin
			
			-- Left Side






		select  @ForceFullSync as ForceFullSync , a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
					where a.TicketChannelID=@ChannelID and 
					 a.TicketID in ( select  x.TicketID from cha.TicketMembers  x where UserID=@userID and IsLeft=0  ) 
			end
			else
			begin
				select   @ForceFullSync as ForceFullSync , a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a 
					where --- a.TicketChannelID=@ChannelID and 
					 a.TicketID in ( select  x.TicketID from cha.TicketMembers  x where UserID=@userID and IsLeft=0  ) 
			end 
				
					

		end
		IF (@Operation = 'Get Right Side Ticket')
		begin

			SELECT       	a.ID, 
							a.ChatID, 
							a.TicketID, 
							a.FromUserID, 
							a.FromUserName, 
							a.Text, 
							a.ReplayMsgID, 
							a.IsDeleted, 
							a.OrginalChatID,
							a.IsEdited,
							a.CreatedDate, 
							a.LastMaintBy, 
							a.LastMaintDate, 
							a.TextStyle, 
							a.AttachmentID, 
							a.LocalChatID ,
							IsSystem , isadmin , b.FileName , b.FileOrginalName , b.FileSize , b.FileExtension , b.FileURL 
			FROM            cha.TicketChatHistory a left outer join AttachmentHistory b on a.AttachmentID=b.AttachmentID 
									
			WHERE        a.TicketID = @TicketID and a.ChatID > @LastChatID
			order BY a.ChatID DESC

			-----

			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
					
					
					 where TicketID=@TicketID
					---where a.TicketID in ( select  x.TicketID from cha.TicketMembers  x where UserID=@userID and IsLeft=0  ) 





			delete from cha.TicketUnreadChat where UserID=@userid and TicketID=@TicketID 

			-- Member
			SELECT        TM.ID, TM.UserID, TM.IsCreatedBy, TM.IsTeamLeader, TM.IsAdmin, TM.IsCC, TM.IsInvited, 
						 	a.Username, a.FullName , 
							IsMuted  as TicketMuted , Tm.IsLeft
			FROM            CHA.TicketMembers as TM LEFT OUTER JOIN
							 UserMaster a  ON TM.UserID = a.UserID
			WHERE        (TM.TicketID = @TicketID) and IsLeft=0 
		

		end
		
		
		if @operation='Channel List'
		begin
			select x.ChannelID , x.Name , x.CategoryID , a.CategoryDescription , x.IsPrivate  , ( select Count(*) from cha.ChannelUserFavorite z where z.ChannelID=x.ChannelID and z.UserID=@UserID ) IsFavorite
			
			from cha.ChannelMaster x left outer join cha.ChannelCategory a on a.ChannelCategoryID =x.CategoryID  
			--where x.ChannelID in ( select z.ChannelID from cha.ChannelMembers z where z.UserID=@UserID) 
			select * from cha.ChannelMembers x  ---- where x.ChannelID in ( select z.ChannelID from cha.ChannelMembers z where z.UserID=@UserID) 
		end


		if @Operation='New Ticket'
		begin
		select @Cnt=Count(*) from  Cha.TicketHistory where TempTicketID=@TempTicketID and  TempTicketID<>0
		if @cnt=0
		begin 	
			Declare @LastCreadtedDate datetime='2026-01-01'
			select @LastCreadtedDate = isnull ( max( CreatedDate), '2026-01-01' ) from cha.TicketHistory where CreatedByUser=@user
			if abs ( DATEDIFF (  SECOND , @LastCreadtedDate , getdate())  ) >10 
			begin

				insert into #TempTicketHistory select * from openjson(@LineData) 
				with ( TicketSubject nvarchar(max), TicketChannelID int , TicketText nvarchar(max) );

				insert into #TempMember select * from openjson(@LineMember) 
				with ( UserID int  , IsAdmin int  , IsTeamLeader  int  , IsCreatedBy int , IsCC int  );

				select top 1  @TicketSubject = TicketSubject, @TicketChannelID = TicketChannelID ,@TicketText=  TicketText from #TempTicketHistory;
				set @TicketID=next value for dbo.TicketID 
			
				insert into CHA.TicketHistory
				( TicketID , TicketSubject, TicketChannelID, CreatedDate, CreatedByUser, LastMaintDate, LastMaintByUser , TempTicketID )
		 
				 select 
				 @TicketID , TicketSubject, TicketChannelID, getdate(), @User, getdate(), @User , @TempTicketID 
				 from #TempTicketHistory;


		 
		 
		
					
		insert into cha.TicketMembers 
		(ChannelID ,  TicketID  , UserID , IsAdmin , IsTeamLeader   , IsCreatedBy , IsCC ,IsMuted    ) 
		select @ChannelID ,    @TicketID , userid , isadmin ,  isTeamLeader  , IsCreatedBy , IsCC, 0
		from #TempMember a



		set @Text=@TicketText
		 set @TextStyle=@TicketText

		set @ChatID=NEXT VALUE FOR dbo.ChatTicket
		insert into cha.TicketChatHistory 
		( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate  ,LocalChatID , ChannelID , IsSystem ) 
		values
		( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , @ReplayMsgID , getdate()  ,@LocalChatID , @ChannelID , 0  ) 




	select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
					where a.TicketID =@TicketID 
			end 
		end 


		end
		IF (@Operation = 'Left Member')
		begin
			declare @username nvarchar(max) =''
			create table #TempLef (  UserID int  )   
			insert into #TempLef select * from openjson(@LineMember) with (UserID int ) 

			select @FullName = fullname , @Username=username  from UserMaster where UserID in ( select userid from #TempLef) 
			update  cha.TicketMembers  set IsLeft=1  where UserID in ( select UserID from #TempLef ) and TicketID=@TicketID 
			delete from dbo.SilaTicketAssignment where TicketID=@TicketID and UserID in ( select UserID from #TempLef )   -- added 2026-10-23
			if @username=@user 
			begin
				set @Text='@'+ @FullName+ ' has left Ticket #'+convert ( nvarchar , @TicketID) 
				set @TextStyle=@Text
			end
			else
			begin
				set @Text='@' + @FullName +  ' has been removed from this Ticket '
				set @TextStyle=@Text
			end 
				
			set @ChatID=NEXT VALUE FOR dbo.ChatTicket
			insert into cha.TicketChatHistory 
			( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem  ) 
			values
			( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , @ReplayMsgID , getdate() ,0 ,@LocalChatID , @ChannelID , 1   ) 
		end 

		if @operation='Invite Member'
		begin
			-- (4) only the ticket's admins / team leaders invite, and they may make the
			-- person a ticket admin (IsAdmin = 1, also when bringing back someone
			-- who had left); added 2026-10-23
			if not exists ( select 1 from cha.TicketMembers where TicketID=@TicketID and UserID=@UserID and IsLeft=0 and ( IsAdmin=1 or IsTeamLeader=1 ) )
			begin
				set @State = 1 ; set @Message = 'Only ticket admins and team leaders can invite people' ;
				return ;
			end
			create table  #TempInv (UserID  int , IsAdmin int  ) 
			insert into #TempInv select * from openjson(@LineMember) 
			with ( UserID int , IsAdmin int  );
			
			
			declare @InvUserID int=0 
			declare f cursor for  select userid  from #TempInv
			open f;
			fetch next from f into @InvUserID
			while @@fetch_status = 0
			begin
				set @Flag=0 
				select @Cnt= count(*) from CHA.TicketMembers where TicketID=@TicketID and UserID=@InvUserID 
				if @cnt=0
				begin 
					
					insert into cha.TicketMembers 
					(ChannelID ,  TicketID  , UserID ,IsInvited , IsAdmin    ) 
					select @ChannelID ,    @TicketID , userid , 1  , IsAdmin 
					from #TempInv a where UserID =@InvUserID
					set @Flag=1 
				end
				else
				begin
					select @Cnt= count(*) from CHA.TicketMembers where TicketID=@TicketID and UserID=@InvUserID and IsLeft=1
					if @cnt<>0
					begin
						 update CHA.TicketMembers set isleft=0 ,
								IsAdmin = case when ( select top 1 IsAdmin from #TempInv where UserID=@InvUserID ) = 1 then 1 else 0 end
						 where TicketID=@TicketID and UserID=@InvUserID and IsLeft=1
						 set @Flag=1 
					end
				end 
				if @flag=1 
				begin 
					select @FullName=fullname from UserMaster where UserID=@InvUserID
					set @ChatID=NEXT VALUE FOR dbo.ChatTicket
					set @Text='@'+ @FullName+ ' has been invited to Ticket #'+convert ( nvarchar , @TicketID) 
						+ case when ( select top 1 IsAdmin from #TempInv where UserID=@InvUserID ) = 1 then ' as admin' else '' end
					set @TextStyle=@Text
					insert into cha.TicketChatHistory 
					( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem ) 
					values
					( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , 0 , getdate() ,0  ,0 , @ChannelID , 1   ) 
				end 
			fetch next from f into @InvUserID
			end;

			close f;
			deallocate f;

				
				
			update cha.TicketHistory set  LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
				select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a 
					where a.TicketID =@TicketID 
		end 


		


		IF (@Operation = 'End Ticket')
		begin
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState in ( 0 , 1 )
			begin
				if @ticketState=0
				begin
					update cha.TicketHistory set TicketState=10 , StartDate=getdate() , StartBy =@user , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
				end 
				
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				set @Text='@'+ @FullName+ ' has ended Ticket #'+convert ( nvarchar , @TicketID) 
				set @TextStyle=@Text
				insert into cha.TicketChatHistory 
				( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem ) 
				values
				( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , 0 , getdate() ,0  ,0 , @ChannelID , 1   ) 
				
				
				update cha.TicketHistory set TicketState=10 , EndedDate=getdate() , EndedBy =@user , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
				select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
					where a.TicketID =@TicketID 
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 


		IF (@Operation = 'Start Ticket')
		begin
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState=0
			begin
				select @Cnt=count(*) from cha.TicketMembers where TicketID=@TicketID and userid=@UserID and ( IsAdmin=1 or IsTeamLeader=1 )
				if @Cnt>0
				begin 
					set @ChatID=NEXT VALUE FOR dbo.ChatTicket
					set @Text='@'+ @FullName+ ' has started Ticket #'+convert ( nvarchar , @TicketID) 
					set @TextStyle=@Text
					insert into cha.TicketChatHistory 
					( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem ) 
					values
					( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , 0 , getdate() ,0  ,0 , @ChannelID , 1   ) 
				
				
					update cha.TicketHistory set TicketState=1 , StartDate=getdate() , StartBy =@user , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
				select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 
					end
					else
					begin
						set @State=1
						set @Message='You do not have a permission to start Ticket  '
					end
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 





		IF (@Operation = 'Close Ticket')
		begin
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState in ( 10 , 0 )
			begin
				set @Text='@'+ @FullName+ ' has closed Ticket #'+convert ( nvarchar , @TicketID) 
				set @TextStyle=@Text
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				insert into cha.TicketChatHistory 
				( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem ) 
				values
				( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , 0 , getdate() ,0 ,0 , @ChannelID , 1  ) 
				update cha.TicketHistory set TicketState=50 , ClosedDate=getdate() , ClosedBy =@user , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
				delete from SilaHistory where TicketID=@TicketID and RecordType='C' 
				select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
					where a.TicketID =@TicketID 
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 
		IF (@Operation = 'Reopen Ticket')
		begin
			Declare @UserMember int 
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState in ( 10 , 5    ) 
			begin
				set @Text='@'+ @FullName+ ' has re-opened Ticket #'+convert ( nvarchar , @TicketID) 
				set @TextStyle=@Text
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				insert into cha.TicketChatHistory 
				( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem  ) 
				values
				( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , @ReplayMsgID , getdate() ,0  ,0 , @ChannelID , 1   ) 
				update cha.TicketHistory set TicketState=1 ,  EndedBy ='' , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
				--declare f cursor for  select userid  from cha.TicketMembers  where IsLeft=0 and TicketID=@ticketID 
				--open f
				--fetch next from f  into  @UserMember 
				--while @@fetch_status =0
				--begin
				--	if not exists ( select  userid  from quk.QuickHistory a  where  TicketID=@TicketID and UserID=@UserMember and QuickType='C'  ) 
				--begin
		
				--	insert into quk.QuickHistory 
				--	( QuickType ,   UserID  , LastMaintDate , ChannelID ,TicketID   )
				--	Values  
				--	( 'C' ,  @UserMember  , getdate() , @ChannelID , @TicketID )    
		
				--end
		
				--	fetch next from f  into  @UserMember 
				--end
				--close f
				--deallocate f

				select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
					where a.TicketID =@TicketID 
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 
		IF (@Operation = 'Hold Ticket')
		begin
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState=1
			begin
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				set @Text='@'+ @FullName+ ' has holded Ticket #'+convert ( nvarchar , @TicketID) 
				set @TextStyle=@Text

				insert into cha.TicketChatHistory 
				( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID ,IsSystem  ) 
				values
				( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , @ReplayMsgID , getdate() ,0  ,0 , @ChannelID, 1  ) 
				
				
				update cha.TicketHistory set TicketState=5 , HoldDate=getdate() , HoldBy =@user , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages ,
						-- the caller's own follow-up flag (dbo.SilaTicketFlag), added 2026-10-23
						case when exists ( select 1 from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) then 1 else 0 end as IsFlagged ,
						( select f.DueDate from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) as FlagDueDate ,
						isnull ( ( select f.Note from dbo.SilaTicketFlag f where f.TicketID=a.TicketID and f.UserID=@UserID ) , '' ) as FlagNote ,
						-- who owns the ticket (dbo.SilaTicketAssignment), added 2026-10-23
						( select ta.UserID from dbo.SilaTicketAssignment ta where ta.TicketID=a.TicketID ) as AssignedUserID ,
						isnull ( ( select isnull(nullif(u.FullName, ''), u.Username) from dbo.SilaTicketAssignment ta join UserMaster u on u.UserID=ta.UserID where ta.TicketID=a.TicketID ) , '' ) as AssignedName 
						From  CHA.V_TicketHistory a
					where a.TicketID =@TicketID 

					
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 

		if @Operation = ('New Chat' )
        begin
			insert into #TempChat
			select * from openjson(@LineData) with (
			ChatID int, TicketID int,    Text nvarchar(max), TextStyle nvarchar(max) ,  ReplayMsgID int,  LocalChatID int, OrginalChatID int , IsAdmin int );

			select top 1  @TicketID =  TicketID  ,   @Text = Text, @ReplayMsgID = ReplayMsgID,  @TextStyle=TextStyle , 
			@LocalChatID = LocalChatID, @OrginalChatID = OrginalChatID , @IsAdminChat =IsAdmin
			from #TempChat;
			
			select @ticketState= TicketState from cha.TicketHistory where TicketID=@TicketID
			if @ticketState =0
			begin
				select @cnt=count(*) from cha.TicketMembers where TicketID=@TicketID and UserID=@UserID and ( IsAdmin=1 or IsTeamLeader=1 ) 
				if @cnt<>0 and @IsAdminChat=0
				begin
					update cha.TicketHistory set TicketState=1 , StartDate=getdate() , StartBy=@User , LastMaintDate=GETDATE() where TicketID=@TicketID
				end
			end
			if @ticketState in (0 ,1 )
			begin

				insert into #TempChat
				select * from openjson(@LineData) with (
				ChatID int, TicketID int,    Text nvarchar(max), TextStyle nvarchar(max) ,  ReplayMsgID int,  LocalChatID int, OrginalChatID int , IsAdmin int );

				select top 1  @TicketID =  TicketID  ,   @Text = Text, @ReplayMsgID = ReplayMsgID,  @TextStyle=TextStyle , 
				@LocalChatID = LocalChatID, @OrginalChatID = OrginalChatID , @IsAdminChat =IsAdmin
				from #TempChat;
			
				select @ChannelID=TicketChannelID from cha.TicketHistory where TicketID=@TicketID


	
			-----Text Proccessing 
				Set @TexTStyle = REPLACE(@TexTStyle,'class="table table-bordered"' , 'border="1"')
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				select @Cnt=count(*) from CHA.TicketChatHistory  where FromUserID=@UserID and LocalChatID=@LocalChatID
				if @cnt=0
				begin 
					insert into  CHA.TicketChatHistory 
					(ChatID,ChannelID ,  TicketID, FromUserID, FromUserName , Text, ReplayMsgID,CreatedBy ,  CreatedDate, LastMaintBy, LastMaintDate, TextStyle,  LocalChatID, OrginalChatID , IsAdmin )
					select 
					@ChatID, @ChannelID ,   @TicketID, @UserID, @User ,   Text, ReplayMsgID ,@User ,  getdate(), @User, getdate(), @TextStyle,  LocalChatID, OrginalChatID , IsAdmin
					from #TempChat;
				end
				select * from CHA.V_TicketChatHistory  
				WHERE       TicketID=@TicketID and ChatID >@LastChatID 
				order BY ChatID DESC
              end
			  else
			  begin
					set @Message ='Ticket State is not correct '
					set @State=1 
			   end
        end
        if @Operation = 'Edit Chat'
            begin
                 
				insert into #TempChat
				select * from openjson(@LineData) with (
				ChatID int, TicketID int,    Text nvarchar(max), TextStyle nvarchar(max) ,  ReplayMsgID int,  LocalChatID int, OrginalChatID int , IsAdmin int);

				select top 1    @Text = Text, @ReplayMsgID = ReplayMsgID,  @TextStyle=TextStyle , 
				@LocalChatID = LocalChatID, @OrginalChatID = OrginalChatID ,@isAdminChat= isadmin 
				from #TempChat;
				Set @TexTStyle = REPLACE(@TexTStyle,'class="table table-bordered"' , 'border="1"')
				update CHA.TicketChatHistory set LastMaintBy=@user , LastMaintDate=getdate() , IsEdited = 1  where ChatID=@OrginalChatID 
				delete from grp.GroupUnreadChat where ChatID=@OrginalChatID
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				insert into CHA.TicketChatHistory 
				( ChatID , ChannelID ,  TicketID , FromUserID ,    FromUserName , Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID ,OrginalChatID , IsEdited,LastMaintBy , CreatedBy , LastMaintDate , IsAdmin ) 
			
				(select @ChatID, ChannelID , TicketID , FromUserID , FromUserName , @text , @TexTStyle , ReplayMsgID, GETDATE() , AttachmentID , @LocalChatID , @OrginalchatID , 0 ,@user , @user , GETDATE() , @isAdminChat
				From CHA.TicketChatHistory 
				where ChatID = @OrginalchatID)
				select * from CHA.V_TicketChatHistory  
				WHERE       TicketID=@TicketID and ChatID >@LastChatID 
				order BY ChatID DESC
            end
        if @Operation = 'Delete Chat'
            begin
				insert into #TempChat
				select * from openjson(@LineData) with (
				ChatID int, TicketID int,    Text nvarchar(max), TextStyle nvarchar(max) ,  ReplayMsgID int,  LocalChatID int, OrginalChatID int , IsAdmin int);
				select top 1    @Text = Text, @ReplayMsgID = ReplayMsgID,  @TextStyle=TextStyle , @LocalChatID = LocalChatID, @OrginalChatID = OrginalChatID
				from #TempChat;
				Set @TexTStyle = REPLACE(@TexTStyle,'class="table table-bordered"' , 'border="1"')
				update CHA.TicketChatHistory set LastMaintBy=@user , LastMaintDate=getdate() ,  IsDeleted = 1  where ChatID=@OrginalChatID 
				delete from GRP.GroupUnreadChat where ChatID=@OrginalChatID
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				insert into CHA.TicketChatHistory 
				( ChatID ,ChannelID ,  TicketID , FromUserID ,    FromUserName, Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID ,OrginalChatID , IsDeleted , CreatedBy , LastMaintBy , LastMaintDate  ) 
			
				select @ChatID,ChannelID ,  TicketID , FromUserID ,  FromUserName ,  'Text Is Deleted ********' , @TexTStyle , ReplayMsgID,getdate(), AttachmentID , @LocalChatID , @OrginalchatID , 1  , @User , @USER , GETDATE() 
				From CHA.TicketChatHistory 
				where ChatID = @OrginalchatID
				select * from CHA.V_TicketChatHistory  
				WHERE       TicketID=@TicketID and ChatID >@LastChatID 
				order BY ChatID DESC
            end
		

            drop table if exists #TempChat;
        
    end
    else
    begin
        set @Message = 'Inactive user. Operation blocked';
        set @State = 1;
        return;
    end


--		COMMIT TRANSACTION;
--end try 
--begin catch
--	IF @@TRANCOUNT > 0
--			ROLLBACK TRANSACTION;
--			set  @ErrorMessage  = ERROR_MESSAGE();
	
--			set @State=1
--			set @Message=@ErrorMessage 
--end Catch









end
GO
