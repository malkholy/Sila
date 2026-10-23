USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- Broadcast groups: an announcement group every active user is in. Only its
-- admins send (GroupMaster.ChatIsLocked = 1, which the mobile app already
-- honours); nobody is added, removed or leaves by hand.
--
-- A broadcast group is an ordinary GRP group (so messages, unread counts,
-- the Home list, push and the mobile app all work unchanged) plus a row here.
-- Its members are kept = the active users by dbo.SilaSyncBroadcastGroup:
--   * whole group: when it is made a broadcast group, and before each message
--     sent from the web (Send group chat / Send group chat file);
--   * one user: when he is created or re-activated (dbo.TrgUserMasterBroadcastGroups
--     on dbo.UserMaster, whichever app created him), and on his web Home list
--     ('Left side') as a fallback.
-- Deactivated users are taken out (admins stay, so the group keeps one): by
-- the same trigger, and by every whole-group sync.
--
--   dbo.SilaGroupType   GroupID -> GroupType ('Broadcast'); a group with no
--                       row is a normal group.
-- Idempotent. Deploy with deploy.sh or in SSMS.
-- =========================================================================
IF OBJECT_ID(N'dbo.SilaGroupType', N'U') IS NULL
    CREATE TABLE dbo.SilaGroupType (
        GroupID       INT          NOT NULL CONSTRAINT PK_SilaGroupType PRIMARY KEY,
        GroupType     VARCHAR(20)  NOT NULL CONSTRAINT CK_SilaGroupType_Type CHECK (GroupType IN ('Broadcast')),
        LastMaintBy   NVARCHAR(50) NOT NULL CONSTRAINT DF_SilaGroupType_By DEFAULT (N''),
        LastMaintDate DATETIME     NOT NULL CONSTRAINT DF_SilaGroupType_Date DEFAULT (GETDATE())
    );
GO
-- @GroupID 0 = every broadcast group; @UserID <> 0 = only add that user (no removals).
-- GRP.GroupMembers' insert trigger is set-based (adds the SilaHistory 'G' rows);
-- its delete trigger reads ONE row, so members are removed one at a time.
CREATE OR ALTER PROCEDURE dbo.SilaSyncBroadcastGroup
    @GroupID INT = 0,
    @UserID  INT = 0,
    @Added   INT = 0 OUTPUT,
    @Removed INT = 0 OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET @Added = 0; SET @Removed = 0;

    INSERT INTO GRP.GroupMembers (GroupID, UserID, IsAdmin, IsCreated, CreatedDate, UnreadCount)
    SELECT t.GroupID, u.UserID, 0, 0, GETDATE(), 0
    FROM dbo.SilaGroupType t
    JOIN GRP.GroupMaster g ON g.GroupID = t.GroupID AND ISNULL(g.Inactive, 0) = 0
    CROSS JOIN dbo.UserMaster u
    WHERE t.GroupType = 'Broadcast' AND (@GroupID = 0 OR t.GroupID = @GroupID)
      AND u.IsNotActive = 0 AND (@UserID = 0 OR u.UserID = @UserID)
      AND NOT EXISTS (SELECT 1 FROM GRP.GroupMembers m WHERE m.GroupID = t.GroupID AND m.UserID = u.UserID);
    SET @Added = @@ROWCOUNT;

    IF @UserID = 0
    BEGIN
        DECLARE @RG INT, @RU INT;
        DECLARE gone CURSOR LOCAL FAST_FORWARD FOR
            SELECT m.GroupID, m.UserID
            FROM GRP.GroupMembers m
            JOIN dbo.SilaGroupType t ON t.GroupID = m.GroupID AND t.GroupType = 'Broadcast'
            JOIN dbo.UserMaster u ON u.UserID = m.UserID
            WHERE (@GroupID = 0 OR m.GroupID = @GroupID) AND u.IsNotActive <> 0 AND ISNULL(m.IsAdmin, 0) = 0;
        OPEN gone;
        FETCH NEXT FROM gone INTO @RG, @RU;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            DELETE FROM GRP.GroupMembers WHERE GroupID = @RG AND UserID = @RU;
            SET @Removed += 1;
            FETCH NEXT FROM gone INTO @RG, @RU;
        END
        CLOSE gone; DEALLOCATE gone;
    END
END
GO
-- A new or re-activated user joins every broadcast group at once; a deactivated
-- one leaves them (not as an admin). Runs only on INSERT or a change of
-- IsNotActive, and only when a broadcast group exists. GRP.GroupMembers' delete
-- trigger reads ONE row, so leavers are removed one at a time.
CREATE OR ALTER TRIGGER dbo.TrgUserMasterBroadcastGroups
ON dbo.UserMaster
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF NOT EXISTS (SELECT 1 FROM dbo.SilaGroupType) RETURN;
    IF EXISTS (SELECT 1 FROM deleted) AND NOT UPDATE(IsNotActive) RETURN;

    INSERT INTO GRP.GroupMembers (GroupID, UserID, IsAdmin, IsCreated, CreatedDate, UnreadCount)
    SELECT t.GroupID, i.UserID, 0, 0, GETDATE(), 0
    FROM inserted i
    CROSS JOIN dbo.SilaGroupType t
    JOIN GRP.GroupMaster g ON g.GroupID = t.GroupID AND ISNULL(g.Inactive, 0) = 0
    WHERE t.GroupType = 'Broadcast' AND i.IsNotActive = 0
      AND NOT EXISTS (SELECT 1 FROM GRP.GroupMembers m WHERE m.GroupID = t.GroupID AND m.UserID = i.UserID);

    DECLARE @RG INT, @RU INT;
    DECLARE gone CURSOR LOCAL FAST_FORWARD FOR
        SELECT m.GroupID, m.UserID
        FROM inserted i
        JOIN GRP.GroupMembers m ON m.UserID = i.UserID AND ISNULL(m.IsAdmin, 0) = 0
        JOIN dbo.SilaGroupType t ON t.GroupID = m.GroupID AND t.GroupType = 'Broadcast'
        WHERE i.IsNotActive <> 0;
    OPEN gone;
    FETCH NEXT FROM gone INTO @RG, @RU;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        DELETE FROM GRP.GroupMembers WHERE GroupID = @RG AND UserID = @RU;
        FETCH NEXT FROM gone INTO @RG, @RU;
    END
    CLOSE gone; DEALLOCATE gone;
END
GO
