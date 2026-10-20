-- Snapshot of the LIVE [CHA].[APITicketOperation] in SILA101, read via sila-db on 2026-10-20.
-- Reference only -- not ours to deploy. Re-fetch: .claude/skills/sila-db/db.sh def '[CHA].[APITicketOperation]'


CREATE procedure [CHA].[APITicketOperation]
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
		
		IF (@Operation = 'Forward Ticket')
		begin
			
			set @ForwardChannelID = @LineData
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState=0
			begin
				select @ForwardedCategoryID=CategoryID  from cha.ChannelMaster where ChannelID=@ForwardChannelID 
				select @OrginalCategoryID=CategoryID  from cha.ChannelMaster where ChannelID=@ChannelID
				if @ForwardedCategoryID=@OrginalCategoryID
				begin
						set @Text='@'+ @FullName+ ' has Forwarded Ticket #'+convert ( nvarchar , @TicketID) 
						set @TextStyle=@Text

						set @ChatID=NEXT VALUE FOR dbo.ChatTicket
						insert into cha.TicketChatHistory 
						( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate  ,LocalChatID , ChannelID , IsSystem ) 
						values
						( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , @ReplayMsgID , getdate()  ,@LocalChatID , @ChannelID , 1   ) 
				
				
						update cha.TicketHistory set TicketState=2 ,Forwarddate =getdate() , ForwardBy =@user , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
						set @orginalTicketID=@TicketID
						set @TicketID=next value for dbo.TicketID 
						insert into cha.TicketHistory 
						(  TicketID  , TicketSubject ,   CreatedByUser , CreatedDate , TicketChannelID  , OrginalChannelID , OrginalTicketID   ,TicketState    )
						select 
						 @TicketID  , TicketSubject ,  CreatedByUser , getdate() , @ForwardChannelID  ,TicketChannelID , TicketID , 3  from cha.TicketHistory 
						 
						 where TicketID=@orginalTicketID

						insert into #TempMemberFor select * from openjson(@LineMember) 
						with ( UserID int  , IsAdmin int  , IsTeamLeader  int  , IsCreatedBy int , IsCC int , IsInvited int   );
						insert into cha.TicketMembers 
						(ChannelID ,  TicketID  , UserID , IsAdmin , IsTeamLeader   , IsCreatedBy , IsCC ,IsMuted , IsInvited   ) 
						select @ChannelID ,    @TicketID , userid , isadmin ,  isTeamLeader  , IsCreatedBy , IsCC, 0 , IsInvited
						from #TempMemberFor a

						select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 

					end
					else
					begin
						set @state=1 
						set @Message= 'Forwarding Ticket is not Allowed ' 
					end 
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 
		IF (@Operation = 'Accept Forward')
		begin
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState=3
			begin
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				set @Text='@'+ @FullName+ ' has accepted forwarded Ticket #'+convert ( nvarchar , @TicketID) 
				set @TextStyle=@Text
			
				insert into cha.TicketChatHistory 
				( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem ) 
				values
				( @ChatID , @TicketID , @userID ,  @user ,   @text , @TexTStyle , @ReplayMsgID , getdate() ,0 ,@LocalChatID , @ChannelID , 1  ) 
				
				---delete Orginal Ticket 
				select @orginalTicketID = OrginalTicketID  from cha.TicketHistory where TicketID=@TicketID 
				insert into cha.TicketHistoryForward select * from  cha.TicketHistory where TicketID=@orginalTicketID 
				delete from cha.TicketHistory where ticketid=@orginalTicketID 
				delete from cha.TicketMembers where TicketID=@orginalTicketID
				---
				update cha.TicketHistory set TicketState=0   , LastMaintDate=getdate() , LastMaintByUser=@user  where TicketID=@TicketID 
				delete cha.TicketChatHistory where TicketID = @orginalTicketID and IsAdmin = 1
				update cha.TicketChatHistory set ChannelID=@ChannelID , TicketID =@TicketID where  TicketID=@orginalTicketID 
				update cha.TicketUnreadChat set   TicketID =@TicketID where  TicketID=@orginalTicketID and UserID in ( select x.userid from cha.TicketMembers x where TicketID=@TicketID ) 
				delete from cha.TicketUnreadChat where TicketID=@orginalTicketID 

					select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID  
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 
		IF (@Operation = 'Reject Forward')
		begin
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState=3
			begin
				set @Text='@'+ @FullName+ ' has rejected forwarded Ticket #'+convert ( nvarchar , @TicketID) 
				set @TextStyle=@Text
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				select @orginalTicketID = OrginalTicketID , @OrginlChannelID =  a.OrginalChannelID  from cha.TicketHistory a where TicketID=@TicketID 
			
				insert into cha.TicketChatHistory 
				( ChatID , TicketID  , FromUserID , FromUserName ,  Text , TextStyle ,  ReplayMsgID , CreatedDate ,AttachmentID ,LocalChatID , ChannelID , IsSystem  ) 
				values
				( @ChatID , @orginalTicketID , @userID ,  @user ,   @text , @TexTStyle , @ReplayMsgID , getdate() ,0 ,@LocalChatID , @OrginlChannelID , 1   ) 
			
				
				delete from cha.TicketHistory where ticketid=@TicketID 
				delete from cha.TicketMembers where TicketID=@TicketID
				delete from cha.TicketUnreadChat where TicketID=@ticketid 


				---Return Ticket Back
				update cha.TicketHistory set TicketState=0 , LastMaintDate=getdate() , LastMaintByUser=@user   where TicketID=@orginalTicketID 
				
	select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 


						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 
		IF (@Operation = 'Cancel Ticket')
		begin
			select @ticketState=TicketState from cha.TicketHistory where TicketID=@ticketID
			if @ticketState=2
			begin
				set @ChatID=NEXT VALUE FOR dbo.ChatTicket
				
			
				
				---delete forwarded Ticket 
				select @ForwardedTicketID = TicketID  from cha.TicketHistory where OrginalTicketID=@TicketID 
				
				delete from cha.TicketHistory where ticketid=@ForwardedTicketID 
				delete from cha.TicketMembers where TicketID=@ForwardedTicketID
				delete from cha.TicketUnreadChat where TicketID=@ForwardedTicketID 


				---Return Ticket Back
				update cha.TicketHistory set TicketState=0  , LastMaintDate=getdate() , LastMaintByUser=@user   where TicketID=@TicketID 
				

					select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
						From  CHA.V_TicketHistory a
						where a.TicketID =@TicketID 
			end
			else
			begin
				set @state=1
				set @message ='Ticket State is not Correct '
			end 
		end 
		if @operation='Get Closed Tickets'
		begin
			select a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
						From  CHA.V_TicketHistory a
					where a.TicketChannelID=@ChannelID and 
					 a.TicketID in ( select  x.TicketID from cha.TicketMembers  x where UserID=@userID and IsLeft=0  ) 
			end
			else
			begin
				select   @ForceFullSync as ForceFullSync , a.* , 
						( select Top 1  IsMuted  from CHA.TicketMembers M where a.ticketID=M.TicketID  and m.UserID=@userID ) as IsTicketMuted ,
						isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
						 update CHA.TicketMembers set isleft=0 where TicketID=@TicketID and UserID=@InvUserID and IsLeft=1
						 set @Flag=1 
					end
				end 
				if @flag=1 
				begin 
					select @FullName=fullname from UserMaster where UserID=@InvUserID
					set @ChatID=NEXT VALUE FOR dbo.ChatTicket
					set @Text='@'+ @FullName+ ' has been invited to Ticket #'+convert ( nvarchar , @TicketID) 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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
							isnull ( ( select Top 1  UnreadCount from cha.TicketMembers x where x.TicketID=a.TicketID and x.UserID=@UserID ) , 0 )  as UnreadMessages 
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

