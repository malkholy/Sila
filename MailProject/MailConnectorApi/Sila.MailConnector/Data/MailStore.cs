using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Sila.MailConnector.Ews;
using Sila.Mail.Monitor;
using Sila.MailConnector.Sync;

namespace Sila.MailConnector.Data;

public sealed record MailUserRow(int UserID, string SmtpAddress, bool IsEnabled, string? HierarchySyncState, int ConsecutiveFailures,
    string? Username = null, DateTime? LastSyncAt = null);

public sealed record FolderRow(long FolderID, string ExchangeFolderId, string DisplayName, string FolderType, string? SyncState);

public sealed record PageResult(int Added, int Changed, int Deleted);

// One attachment of one mailbox, with what is needed to fetch it from Exchange.
public sealed record AttachmentFileRow(long AttachmentID, string ExchangeAttachmentId, string Name, string? ContentType, long? Size,
    string? StoredPath, string SmtpAddress, bool IsEnabled);

// InternalMail ([mail] schema): every statement is parameterized; every write to
// a copied table adds its MailChange row in the same transaction (the outbox,
// MailPlan 7.2); a folder's SyncState moves only in the transaction that wrote
// the rows it covers (MailPlan 7.5). A MailMessage change also covers its
// recipients: the publisher sends the message with them.
public sealed class MailStore(IConfiguration configuration)
{
    private string ConnectionString => configuration.GetConnectionString("InternalMail")
        ?? throw new InvalidOperationException("ConnectionStrings:InternalMail is not configured.");

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.GetConnectionString("InternalMail"));

    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var connection = new SqlConnection(ConnectionString);
        await connection.OpenAsync(ct);
        return connection;
    }

    private static SqlCommand Command(SqlConnection connection, string sql, SqlTransaction? transaction = null) =>
        new(sql, connection, transaction) { CommandTimeout = 60 };

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var command = Command(connection, "SELECT 1");
            return Equals(await command.ExecuteScalarAsync(ct), 1);
        }
        catch (SqlException)
        {
            return false;
        }
    }

    public async Task<int> GetSettingAsync(string key, int fallback, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, "SELECT [Value] FROM [mail].[MailSettings] WHERE [SettingKey] = @Key");
        command.Parameters.Add("@Key", SqlDbType.VarChar, 50).Value = key;
        return int.TryParse(await command.ExecuteScalarAsync(ct) as string, out var value) ? value : fallback;
    }

    public async Task<MailUserRow?> GetUserAsync(int userId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT [UserID], [SmtpAddress], [IsEnabled], [HierarchySyncState], [ConsecutiveFailures], [Username], [LastSyncAt]
            FROM [mail].[MailUser] WHERE [UserID] = @UserID
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        await using var reader = await command.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct)
            ? new MailUserRow(reader.GetInt32(0), reader.GetString(1), reader.GetBoolean(2),
                reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetInt32(4), reader.IsDBNull(5) ? null : reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetDateTime(6))
            : null;
    }

    // The attachment, only when it belongs to a live message of this mailbox.
    public async Task<AttachmentFileRow?> GetAttachmentAsync(int userId, long attachmentId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT a.[AttachmentID], a.[ExchangeAttachmentId], a.[Name], a.[ContentType], a.[Size], a.[StoredPath], u.[SmtpAddress], u.[IsEnabled]
            FROM [mail].[MailAttachment] a
            JOIN [mail].[MailMessage] m ON m.[MessageID] = a.[MessageID]
            JOIN [mail].[MailUser] u ON u.[UserID] = m.[UserID]
            WHERE a.[AttachmentID] = @AttachmentID AND m.[UserID] = @UserID AND m.[DeletedAt] IS NULL
            """);
        command.Parameters.Add("@AttachmentID", SqlDbType.BigInt).Value = attachmentId;
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        await using var r = await command.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct)
            ? new AttachmentFileRow(r.GetInt64(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3),
                r.IsDBNull(4) ? null : r.GetInt64(4), r.IsDBNull(5) ? null : r.GetString(5), r.GetString(6), r.GetBoolean(7))
            : null;
    }

    // Where the fetched file is kept (relative to Attachments:Root). Not copied
    // outside, so no MailChange row: the external copy keeps its own files.
    public async Task SetAttachmentStoredAsync(long attachmentId, string? storedPath, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailAttachment]
            SET [StoredPath] = @StoredPath, [StoredAt] = CASE WHEN @StoredPath IS NULL THEN NULL ELSE SYSDATETIME() END
            WHERE [AttachmentID] = @AttachmentID
            """);
        command.Parameters.Add("@AttachmentID", SqlDbType.BigInt).Value = attachmentId;
        command.Parameters.Add("@StoredPath", SqlDbType.VarChar, 400).Value = (object?)storedPath ?? DBNull.Value;
        await command.ExecuteNonQueryAsync(ct);
    }

    // Every enabled mailbox, for the safety sync timer.
    public async Task<List<SyncScheduler.Candidate>> GetSyncCandidatesAsync(CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT [UserID], [LastSyncAt], [LastSyncAttemptAt], [ConsecutiveFailures]
            FROM [mail].[MailUser] WHERE [IsEnabled] = 1 ORDER BY [UserID];
            """);
        var list = new List<SyncScheduler.Candidate>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(new(reader.GetInt32(0), reader.IsDBNull(1) ? null : reader.GetDateTime(1),
                reader.IsDBNull(2) ? null : reader.GetDateTime(2), reader.GetInt32(3)));
        return list;
    }

    // Which Sila user has this username's mailbox, if any.
    public async Task<int?> GetUserIdByUsernameAsync(string username, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, "SELECT [UserID] FROM [mail].[MailUser] WHERE [Username] = @Username");
        command.Parameters.Add("@Username", SqlDbType.NVarChar, 50).Value = username;
        return await command.ExecuteScalarAsync(ct) is int id ? id : null;
    }

    // Which Sila user has this mailbox address, if any.
    public async Task<int?> GetUserIdByAddressAsync(string smtpAddress, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, "SELECT [UserID] FROM [mail].[MailUser] WHERE [SmtpAddress] = @Smtp");
        command.Parameters.Add("@Smtp", SqlDbType.NVarChar, 320).Value = smtpAddress;
        return await command.ExecuteScalarAsync(ct) is int id ? id : null;
    }

    // Adds the mailbox, or updates its address / name / username. Returns true when it is new.
    public async Task<bool> SaveUserAsync(int userId, string smtpAddress, string? displayName, string? username, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);
        await using var command = Command(connection, """
            DECLARE @Added BIT = 0;
            IF EXISTS (SELECT 1 FROM [mail].[MailUser] WITH (UPDLOCK, HOLDLOCK) WHERE [UserID] = @UserID)
                UPDATE [mail].[MailUser] SET [SmtpAddress] = @Smtp, [DisplayName] = @Name,
                    [Username] = COALESCE(@Username, [Username]) WHERE [UserID] = @UserID;
            ELSE
            BEGIN
                INSERT INTO [mail].[MailUser] ([UserID], [SmtpAddress], [DisplayName], [Username]) VALUES (@UserID, @Smtp, @Name, @Username);
                SET @Added = 1;
            END
            INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
            VALUES ('MailUser', CAST(@UserID AS VARCHAR(20)), 'U', @UserID);
            SELECT @Added;
            """, transaction);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@Smtp", SqlDbType.NVarChar, 320).Value = smtpAddress;
        command.Parameters.Add("@Name", SqlDbType.NVarChar, 256).Value = (object?)displayName ?? DBNull.Value;
        command.Parameters.Add("@Username", SqlDbType.NVarChar, 50).Value = (object?)username ?? DBNull.Value;
        var added = Equals(await command.ExecuteScalarAsync(ct), true);
        await transaction.CommitAsync(ct);
        return added;
    }

    // Job leasing (MailPlan 7.3): true when this owner holds the job until now + seconds.
    public async Task<bool> TryLeaseAsync(string jobKey, string owner, int seconds, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailJobLease]
            SET [AcquiredAt] = CASE WHEN [Owner] = @Owner THEN [AcquiredAt] ELSE SYSDATETIME() END,
                [Owner] = @Owner, [LeaseUntil] = DATEADD(SECOND, @Seconds, SYSDATETIME()), [RenewedAt] = SYSDATETIME()
            WHERE [JobKey] = @Key AND ([Owner] = @Owner OR [LeaseUntil] < SYSDATETIME());
            IF @@ROWCOUNT = 0 AND NOT EXISTS (SELECT 1 FROM [mail].[MailJobLease] WHERE [JobKey] = @Key)
                INSERT INTO [mail].[MailJobLease] ([JobKey], [Owner], [LeaseUntil], [AcquiredAt], [RenewedAt])
                VALUES (@Key, @Owner, DATEADD(SECOND, @Seconds, SYSDATETIME()), SYSDATETIME(), SYSDATETIME());
            SELECT CASE WHEN [Owner] = @Owner THEN 1 ELSE 0 END FROM [mail].[MailJobLease] WHERE [JobKey] = @Key;
            """);
        command.Parameters.Add("@Key", SqlDbType.VarChar, 100).Value = jobKey;
        command.Parameters.Add("@Owner", SqlDbType.VarChar, 100).Value = owner;
        command.Parameters.Add("@Seconds", SqlDbType.Int).Value = seconds;
        try
        {
            return Equals(await command.ExecuteScalarAsync(ct), 1);
        }
        catch (SqlException error) when (error.Number is 2627 or 2601)
        {
            return false;   // another instance inserted it first
        }
    }

    public async Task ReleaseLeaseAsync(string jobKey, string owner, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, "DELETE FROM [mail].[MailJobLease] WHERE [JobKey] = @Key AND [Owner] = @Owner");
        command.Parameters.Add("@Key", SqlDbType.VarChar, 100).Value = jobKey;
        command.Parameters.Add("@Owner", SqlDbType.VarChar, 100).Value = owner;
        await command.ExecuteNonQueryAsync(ct);
    }

    public async Task<long> StartSyncLogAsync(int userId, long? folderId, string kind, string reason, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            INSERT INTO [mail].[MailSyncLog] ([UserID], [FolderID], [Kind], [Reason], [Worker])
            OUTPUT inserted.[SyncLogID] VALUES (@UserID, @FolderID, @Kind, @Reason, 'ExchangeSync');
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = (object?)folderId ?? DBNull.Value;
        command.Parameters.Add("@Kind", SqlDbType.VarChar, 12).Value = kind;
        command.Parameters.Add("@Reason", SqlDbType.VarChar, 30).Value = reason;
        return (long)(await command.ExecuteScalarAsync(ct))!;
    }

    public async Task FinishSyncLogAsync(long syncLogId, int pages, PageResult totals, EwsException? error, CancellationToken ct,
        int matched = 0)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailSyncLog]
            SET [EndedAt] = SYSDATETIME(), [Pages] = @Pages, [Added] = @Added, [Changed] = @Changed, [Deleted] = @Deleted,
                [Matched] = @Matched, [Succeeded] = @Succeeded, [ErrorKind] = @Kind, [ErrorCode] = @Code, [ErrorMessage] = @Message
            WHERE [SyncLogID] = @ID;
            """);
        command.Parameters.Add("@Matched", SqlDbType.Int).Value = matched;
        command.Parameters.Add("@ID", SqlDbType.BigInt).Value = syncLogId;
        command.Parameters.Add("@Pages", SqlDbType.Int).Value = pages;
        command.Parameters.Add("@Added", SqlDbType.Int).Value = totals.Added;
        command.Parameters.Add("@Changed", SqlDbType.Int).Value = totals.Changed;
        command.Parameters.Add("@Deleted", SqlDbType.Int).Value = totals.Deleted;
        command.Parameters.Add("@Succeeded", SqlDbType.Bit).Value = error is null;
        command.Parameters.Add("@Kind", SqlDbType.VarChar, 20).Value = (object?)error?.Kind.ToString() ?? DBNull.Value;
        command.Parameters.Add("@Code", SqlDbType.VarChar, 100).Value = (object?)Cut(error?.Code, 100) ?? DBNull.Value;
        command.Parameters.Add("@Message", SqlDbType.NVarChar, 1000).Value = (object?)Cut(error?.Message, 1000) ?? DBNull.Value;
        await command.ExecuteNonQueryAsync(ct);
    }

    // One page of the folder tree. root: msgfolderroot itself (the hierarchy
    // sync lists only what is under it). types: Exchange folder ID -> FolderType.
    public async Task<PageResult> ApplyHierarchyAsync(int userId, FolderInfo root, IReadOnlyList<FolderChange> changes,
        IReadOnlyDictionary<string, string> types, string syncState, CancellationToken ct)
    {
        int added = 0, changed = 0, deleted = 0;
        await using var connection = await OpenAsync(ct);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);

        if (await UpsertFolderAsync(connection, transaction, userId, root.Id, root.ChangeKey, "Top of Information Store",
                "Root", root.TotalCount, root.UnreadCount, isSynced: false, ct)) added++;
        foreach (var folder in changes.Where(c => c.Change != EwsChange.Delete && c.IsMail))
        {
            var type = types.TryGetValue(folder.Id, out var t) ? t : "Custom";
            if (await UpsertFolderAsync(connection, transaction, userId, folder.Id, folder.ChangeKey,
                    Cut(folder.DisplayName, 255) ?? "(no name)", type, folder.TotalCount, folder.UnreadCount, isSynced: true, ct))
                added++;
            else changed++;
        }
        // Parents once every folder of the page exists.
        foreach (var folder in changes.Where(c => c.Change != EwsChange.Delete && c.IsMail && c.ParentId is not null))
        {
            await using var parent = Command(connection, """
                UPDATE [mail].[MailFolder]
                SET [ParentFolderID] = (SELECT [FolderID] FROM [mail].[MailFolder] WHERE [UserID] = @UserID AND [ExchangeFolderId] = @ParentId)
                WHERE [UserID] = @UserID AND [ExchangeFolderId] = @Id;
                """, transaction);
            parent.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            parent.Parameters.Add("@Id", SqlDbType.VarChar, 512).Value = folder.Id;
            parent.Parameters.Add("@ParentId", SqlDbType.VarChar, 512).Value = folder.ParentId;
            await parent.ExecuteNonQueryAsync(ct);
        }
        // A folder Exchange no longer has goes. Its messages are only marked: a
        // deleted folder's mail usually moves to Deleted Items (matched as moves).
        foreach (var folder in changes.Where(c => c.Change == EwsChange.Delete))
        {
            await using var remove = Command(connection, """
                DECLARE @FolderID BIGINT = (SELECT [FolderID] FROM [mail].[MailFolder] WHERE [UserID] = @UserID AND [ExchangeFolderId] = @Id);
                DECLARE @Gone TABLE ([MessageID] BIGINT);
                IF @FolderID IS NOT NULL
                BEGIN
                    UPDATE [mail].[MailMessage] SET [DeletedAt] = SYSDATETIME()
                    OUTPUT inserted.[MessageID] INTO @Gone
                    WHERE [FolderID] = @FolderID AND [DeletedAt] IS NULL;
                    INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                    SELECT 'MailMessage', CAST([MessageID] AS VARCHAR(20)), 'D', @UserID FROM @Gone;
                    UPDATE [mail].[MailFolder] SET [ParentFolderID] = NULL WHERE [ParentFolderID] = @FolderID;
                    DELETE FROM [mail].[MailFolder] WHERE [FolderID] = @FolderID;
                    INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                    VALUES ('MailFolder', CAST(@FolderID AS VARCHAR(20)), 'D', @UserID);
                END
                SELECT CASE WHEN @FolderID IS NULL THEN 0 ELSE 1 END;
                """, transaction);
            remove.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            remove.Parameters.Add("@Id", SqlDbType.VarChar, 512).Value = folder.Id;
            if (Equals(await remove.ExecuteScalarAsync(ct), 1)) deleted++;
        }

        await using var state = Command(connection,
            "UPDATE [mail].[MailUser] SET [HierarchySyncState] = @State WHERE [UserID] = @UserID", transaction);
        state.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        state.Parameters.Add("@State", SqlDbType.VarChar, -1).Value = syncState;
        await state.ExecuteNonQueryAsync(ct);

        await transaction.CommitAsync(ct);
        return new PageResult(added, changed, deleted);
    }

    private static async Task<bool> UpsertFolderAsync(SqlConnection connection, SqlTransaction transaction, int userId,
        string exchangeId, string? changeKey, string displayName, string type, int total, int unread, bool isSynced, CancellationToken ct)
    {
        await using var command = Command(connection, """
            DECLARE @FolderID BIGINT, @Added BIT = 0;
            SELECT @FolderID = [FolderID] FROM [mail].[MailFolder] WITH (UPDLOCK, HOLDLOCK)
            WHERE [UserID] = @UserID AND [ExchangeFolderId] = @Id;
            IF @FolderID IS NULL
            BEGIN
                INSERT INTO [mail].[MailFolder] ([UserID], [ExchangeFolderId], [ExchangeChangeKey], [DisplayName], [FolderType],
                                                 [TotalCount], [UnreadCount], [IsSynced])
                VALUES (@UserID, @Id, @ChangeKey, @Name, @Type, @Total, @Unread, @IsSynced);
                SET @FolderID = SCOPE_IDENTITY();
                SET @Added = 1;
            END
            ELSE
                UPDATE [mail].[MailFolder]
                SET [ExchangeChangeKey] = @ChangeKey, [DisplayName] = @Name, [FolderType] = @Type,
                    [TotalCount] = @Total, [UnreadCount] = @Unread
                WHERE [FolderID] = @FolderID;
            INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
            VALUES ('MailFolder', CAST(@FolderID AS VARCHAR(20)), 'U', @UserID);
            SELECT @Added;
            """, transaction);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@Id", SqlDbType.VarChar, 512).Value = exchangeId;
        command.Parameters.Add("@ChangeKey", SqlDbType.VarChar, 128).Value = (object?)changeKey ?? DBNull.Value;
        command.Parameters.Add("@Name", SqlDbType.NVarChar, 255).Value = displayName;
        command.Parameters.Add("@Type", SqlDbType.VarChar, 20).Value = type;
        command.Parameters.Add("@Total", SqlDbType.Int).Value = total;
        command.Parameters.Add("@Unread", SqlDbType.Int).Value = unread;
        command.Parameters.Add("@IsSynced", SqlDbType.Bit).Value = isSynced;
        return Equals(await command.ExecuteScalarAsync(ct), true);
    }

    public async Task<FolderRow?> GetFolderAsync(int userId, string folderType, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT TOP (1) [FolderID], [ExchangeFolderId], [DisplayName], [FolderType], [SyncState]
            FROM [mail].[MailFolder] WHERE [UserID] = @UserID AND [FolderType] = @Type ORDER BY [FolderID];
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@Type", SqlDbType.VarChar, 20).Value = folderType;
        await using var reader = await command.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct)
            ? new FolderRow(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4))
            : null;
    }

    // Every folder whose items are copied, Inbox and Sent Items first, Deleted
    // Items and Junk last; a folder waiting for a rebuild is left out.
    public async Task<List<FolderRow>> GetSyncFoldersAsync(int userId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT [FolderID], [ExchangeFolderId], [DisplayName], [FolderType], [SyncState]
            FROM [mail].[MailFolder]
            WHERE [UserID] = @UserID AND [IsSynced] = 1 AND [FolderType] <> 'Root' AND [FolderSyncStatus] <> 'Rebuilding'
            ORDER BY CASE [FolderType] WHEN 'Inbox' THEN 0 WHEN 'SentItems' THEN 1 WHEN 'Drafts' THEN 2 WHEN 'Custom' THEN 3
                                       WHEN 'Outbox' THEN 4 WHEN 'DeletedItems' THEN 5 ELSE 6 END, [FolderID];
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        var folders = new List<FolderRow>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            folders.Add(new FolderRow(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4)));
        return folders;
    }

    // Moves (MailPlan 7.5): a marked (deleted) row whose message is live again in
    // another row -- same InternetMessageId and ReceivedAt, created after it -- is
    // that message moved. The old row takes over the new row's Exchange ID,
    // folder, flags, body and attachments (attachment IDs change with the item),
    // so the Sila MessageID stays; the new row goes. Copies are never merged: a
    // copy does not delete the original. Returns the number of moves matched.
    public async Task<int> MergeMovesAsync(int userId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        var pairs = new List<(long Old, long New)>();
        await using (var find = Command(connection, """
            SELECT d.[MessageID], n.[MessageID]
            FROM [mail].[MailMessage] d
            CROSS APPLY (SELECT TOP (1) x.[MessageID] FROM [mail].[MailMessage] x
                         WHERE x.[UserID] = d.[UserID] AND x.[DeletedAt] IS NULL AND x.[MessageID] > d.[MessageID]
                           AND x.[InternetMessageId] = d.[InternetMessageId] AND x.[ReceivedAt] = d.[ReceivedAt]
                         ORDER BY x.[MessageID] DESC) n
            WHERE d.[UserID] = @UserID AND d.[DeletedAt] IS NOT NULL AND d.[InternetMessageId] IS NOT NULL
            ORDER BY d.[MessageID];
            """))
        {
            find.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            await using var reader = await find.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) pairs.Add((reader.GetInt64(0), reader.GetInt64(1)));
        }

        var merged = 0;
        var used = new HashSet<long>();
        foreach (var (oldId, newId) in pairs)
        {
            if (!used.Add(newId)) continue;   // one live row answers one marked row
            await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);
            await using var command = Command(connection, """
                DECLARE @FolderID BIGINT, @ItemId VARCHAR(512), @ChangeKey VARCHAR(128), @IsRead BIT, @FlagStatus TINYINT,
                        @Importance TINYINT, @IsDraft BIT, @HasAttachments BIT;
                SELECT @FolderID = [FolderID], @ItemId = [ExchangeItemId], @ChangeKey = [ChangeKey], @IsRead = [IsRead],
                       @FlagStatus = [FlagStatus], @Importance = [Importance], @IsDraft = [IsDraft], @HasAttachments = [HasAttachments]
                FROM [mail].[MailMessage] WITH (UPDLOCK, HOLDLOCK)
                WHERE [MessageID] = @New AND [UserID] = @UserID AND [DeletedAt] IS NULL;
                IF @ItemId IS NULL OR NOT EXISTS (SELECT 1 FROM [mail].[MailMessage] WITH (UPDLOCK, HOLDLOCK)
                                                  WHERE [MessageID] = @Old AND [UserID] = @UserID AND [DeletedAt] IS NOT NULL)
                BEGIN
                    SELECT 0;
                    RETURN;
                END

                DECLARE @GoneAttachments TABLE ([AttachmentID] BIGINT);
                DECLARE @MovedAttachments TABLE ([AttachmentID] BIGINT);
                DECLARE @HasBody BIT = 0;
                -- Body and attachments: the new row's (current Exchange IDs), when it has them.
                IF EXISTS (SELECT 1 FROM [mail].[MailMessageBody] WHERE [MessageID] = @New)
                BEGIN
                    DELETE FROM [mail].[MailAttachment] OUTPUT deleted.[AttachmentID] INTO @GoneAttachments WHERE [MessageID] = @Old;
                    DELETE FROM [mail].[MailMessageBody] WHERE [MessageID] = @Old;
                    UPDATE [mail].[MailMessageBody] SET [MessageID] = @Old WHERE [MessageID] = @New;
                    UPDATE [mail].[MailAttachment] SET [MessageID] = @Old OUTPUT inserted.[AttachmentID] INTO @MovedAttachments
                    WHERE [MessageID] = @New;
                    SET @HasBody = 1;
                END
                ELSE
                BEGIN
                    -- No body fetched for the new row yet: the body pass fetches it for the old row.
                    DELETE FROM [mail].[MailAttachment] OUTPUT deleted.[AttachmentID] INTO @GoneAttachments WHERE [MessageID] = @Old;
                    DELETE FROM [mail].[MailMessageBody] WHERE [MessageID] = @Old;
                END
                UPDATE l SET [MessageID] = @Old FROM [mail].[MailTicketLink] l
                WHERE l.[MessageID] = @New
                  AND NOT EXISTS (SELECT 1 FROM [mail].[MailTicketLink] k WHERE k.[MessageID] = @Old AND k.[TicketID] = l.[TicketID]);
                DELETE FROM [mail].[MailMessage] WHERE [MessageID] = @New;   -- its recipients go with it (same as the old row's)
                UPDATE [mail].[MailMessage]
                SET [FolderID] = @FolderID, [ExchangeItemId] = @ItemId, [ChangeKey] = @ChangeKey, [IsRead] = @IsRead,
                    [FlagStatus] = @FlagStatus, [Importance] = @Importance, [IsDraft] = @IsDraft, [HasAttachments] = @HasAttachments,
                    [DeletedAt] = NULL, [SyncedAt] = SYSDATETIME()
                WHERE [MessageID] = @Old;

                INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                SELECT 'MailMessage', CAST(@New AS VARCHAR(20)), 'D', @UserID
                UNION ALL SELECT 'MailMessage', CAST(@Old AS VARCHAR(20)), 'U', @UserID
                UNION ALL SELECT 'MailMessageBody', CAST(@Old AS VARCHAR(20)), 'U', @UserID WHERE @HasBody = 1
                UNION ALL SELECT 'MailAttachment', CAST([AttachmentID] AS VARCHAR(20)), 'D', @UserID FROM @GoneAttachments
                UNION ALL SELECT 'MailAttachment', CAST([AttachmentID] AS VARCHAR(20)), 'U', @UserID FROM @MovedAttachments;
                SELECT 1;
                """, transaction);
            command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            command.Parameters.Add("@Old", SqlDbType.BigInt).Value = oldId;
            command.Parameters.Add("@New", SqlDbType.BigInt).Value = newId;
            if (Equals(await command.ExecuteScalarAsync(ct), 1)) merged++;
            await transaction.CommitAsync(ct);
        }
        return merged;
    }

    // Marked rows that no move claimed within the grace time are removed. The
    // external copy was already told (MailChange 'D' when they were marked).
    public async Task<int> PurgeDeletedAsync(int userId, int graceMinutes, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            DELETE FROM [mail].[MailMessage]
            WHERE [UserID] = @UserID AND [DeletedAt] < DATEADD(MINUTE, -@Grace, SYSDATETIME());
            SELECT @@ROWCOUNT;
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@Grace", SqlDbType.Int).Value = graceMinutes;
        return (int)(await command.ExecuteScalarAsync(ct))!;
    }

    // One page of a folder's item changes, and the checkpoint after it, in one transaction.
    public async Task<PageResult> ApplyItemPageAsync(int userId, long folderId, IReadOnlyList<MailItem> upserts,
        IReadOnlyList<string> deletes, IReadOnlyList<(string ItemId, bool IsRead)> readChanges,
        string syncState, bool done, CancellationToken ct)
    {
        int added = 0, changed = 0, deleted = 0;
        await using var connection = await OpenAsync(ct);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);

        foreach (var item in upserts)
        {
            await using var command = Command(connection, """
                DECLARE @MessageID BIGINT, @Added BIT = 0, @WasDeleted BIT = 0;
                SELECT @MessageID = [MessageID], @WasDeleted = CASE WHEN [DeletedAt] IS NULL THEN 0 ELSE 1 END
                FROM [mail].[MailMessage] WITH (UPDLOCK, HOLDLOCK)
                WHERE [UserID] = @UserID AND [ExchangeItemId] = @ItemId;
                IF @MessageID IS NULL
                BEGIN
                    INSERT INTO [mail].[MailMessage] ([UserID], [FolderID], [ExchangeItemId], [ChangeKey], [InternetMessageId],
                        [ConversationId], [Subject], [FromName], [FromAddress], [SentAt], [ReceivedAt], [IsRead], [FlagStatus],
                        [Importance], [HasAttachments], [IsDraft], [Preview])
                    VALUES (@UserID, @FolderID, @ItemId, @ChangeKey, @InternetMessageId, @ConversationId, @Subject, @FromName,
                        @FromAddress, @SentAt, @ReceivedAt, @IsRead, @FlagStatus, @Importance, @HasAttachments, @IsDraft, @Preview);
                    SET @MessageID = SCOPE_IDENTITY();
                    SET @Added = 1;
                END
                ELSE
                    UPDATE [mail].[MailMessage]
                    SET [FolderID] = @FolderID, [ChangeKey] = @ChangeKey, [InternetMessageId] = @InternetMessageId,
                        [ConversationId] = @ConversationId, [Subject] = @Subject, [FromName] = @FromName, [FromAddress] = @FromAddress,
                        [SentAt] = @SentAt, [ReceivedAt] = @ReceivedAt, [IsRead] = @IsRead, [FlagStatus] = @FlagStatus,
                        [Importance] = @Importance, [HasAttachments] = @HasAttachments, [IsDraft] = @IsDraft, [Preview] = @Preview,
                        [DeletedAt] = NULL, [SyncedAt] = SYSDATETIME()
                    WHERE [MessageID] = @MessageID;
                -- A draft's body can change, and a row brought back from deleted was removed
                -- from the external copy: drop the body so the body pass fetches and sends it again.
                IF @Added = 0 AND (@IsDraft = 1 OR @WasDeleted = 1)
                   AND EXISTS (SELECT 1 FROM [mail].[MailMessageBody] WHERE [MessageID] = @MessageID)
                BEGIN
                    DELETE FROM [mail].[MailMessageBody] WHERE [MessageID] = @MessageID;
                    INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                    VALUES ('MailMessageBody', CAST(@MessageID AS VARCHAR(20)), 'D', @UserID);
                END
                DELETE FROM [mail].[MailRecipient] WHERE [MessageID] = @MessageID;
                INSERT INTO [mail].[MailRecipient] ([MessageID], [RecipientType], [Position], [Name], [Address])
                SELECT @MessageID, r.[t], CAST(j.[key] AS SMALLINT), r.[n], r.[a]
                FROM OPENJSON(@Recipients) j
                CROSS APPLY OPENJSON(j.[value]) WITH ([t] TINYINT, [n] NVARCHAR(320), [a] NVARCHAR(320)) r;
                INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                VALUES ('MailMessage', CAST(@MessageID AS VARCHAR(20)), 'U', @UserID);
                SELECT @Added;
                """, transaction);
            var p = command.Parameters;
            p.Add("@UserID", SqlDbType.Int).Value = userId;
            p.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
            p.Add("@ItemId", SqlDbType.VarChar, 512).Value = item.ItemId;
            p.Add("@ChangeKey", SqlDbType.VarChar, 128).Value = item.ChangeKey;
            p.Add("@InternetMessageId", SqlDbType.NVarChar, 500).Value = (object?)item.InternetMessageId ?? DBNull.Value;
            p.Add("@ConversationId", SqlDbType.VarChar, 512).Value = (object?)item.ConversationId ?? DBNull.Value;
            p.Add("@Subject", SqlDbType.NVarChar, 1000).Value = (object?)item.Subject ?? DBNull.Value;
            p.Add("@FromName", SqlDbType.NVarChar, 320).Value = (object?)item.FromName ?? DBNull.Value;
            p.Add("@FromAddress", SqlDbType.NVarChar, 320).Value = (object?)item.FromAddress ?? DBNull.Value;
            p.Add("@SentAt", SqlDbType.DateTime2).Value = (object?)item.SentAt ?? DBNull.Value;
            p.Add("@ReceivedAt", SqlDbType.DateTime2).Value = item.ReceivedAt;
            p.Add("@IsRead", SqlDbType.Bit).Value = item.IsRead;
            p.Add("@FlagStatus", SqlDbType.TinyInt).Value = item.FlagStatus;
            p.Add("@Importance", SqlDbType.TinyInt).Value = item.Importance;
            p.Add("@HasAttachments", SqlDbType.Bit).Value = item.HasAttachments;
            p.Add("@IsDraft", SqlDbType.Bit).Value = item.IsDraft;
            p.Add("@Preview", SqlDbType.NVarChar, 400).Value = (object?)item.Preview ?? DBNull.Value;
            // At most 2000 recipients kept per message (Position is the index across To / Cc / Bcc).
            p.Add("@Recipients", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(
                item.Recipients.Take(2000).Select(r => new { t = r.Type, n = r.Name, a = r.Address }));
            if (Equals(await command.ExecuteScalarAsync(ct), true)) added++;
            else changed++;
        }

        // A delete only marks the row: it may be a move, matched at the end of the run (MergeMovesAsync).
        foreach (var itemId in deletes)
        {
            await using var command = Command(connection, """
                DECLARE @Gone TABLE ([MessageID] BIGINT);
                UPDATE [mail].[MailMessage] SET [DeletedAt] = SYSDATETIME()
                OUTPUT inserted.[MessageID] INTO @Gone
                WHERE [UserID] = @UserID AND [ExchangeItemId] = @ItemId AND [DeletedAt] IS NULL;
                INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                SELECT 'MailMessage', CAST([MessageID] AS VARCHAR(20)), 'D', @UserID FROM @Gone;
                SELECT COUNT(*) FROM @Gone;
                """, transaction);
            command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            command.Parameters.Add("@ItemId", SqlDbType.VarChar, 512).Value = itemId;
            deleted += (int)(await command.ExecuteScalarAsync(ct))!;
        }

        foreach (var (itemId, isRead) in readChanges)
        {
            await using var command = Command(connection, """
                DECLARE @Changed TABLE ([MessageID] BIGINT);
                UPDATE [mail].[MailMessage] SET [IsRead] = @IsRead, [SyncedAt] = SYSDATETIME()
                OUTPUT inserted.[MessageID] INTO @Changed
                WHERE [UserID] = @UserID AND [ExchangeItemId] = @ItemId AND [IsRead] <> @IsRead AND [DeletedAt] IS NULL;
                INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                SELECT 'MailMessage', CAST([MessageID] AS VARCHAR(20)), 'U', @UserID FROM @Changed;
                SELECT COUNT(*) FROM @Changed;
                """, transaction);
            command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            command.Parameters.Add("@ItemId", SqlDbType.VarChar, 512).Value = itemId;
            command.Parameters.Add("@IsRead", SqlDbType.Bit).Value = isRead;
            changed += (int)(await command.ExecuteScalarAsync(ct))!;
        }

        await using var checkpoint = Command(connection, """
            UPDATE [mail].[MailFolder]
            SET [SyncState] = @State, [SyncStateUpdatedAt] = SYSDATETIME(),
                [FolderSyncStatus] = CASE WHEN @Done = 1 THEN 'OK' ELSE 'Syncing' END,
                [LastSyncAt] = CASE WHEN @Done = 1 THEN SYSDATETIME() ELSE [LastSyncAt] END
            WHERE [FolderID] = @FolderID;
            """, transaction);
        checkpoint.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
        checkpoint.Parameters.Add("@State", SqlDbType.VarChar, -1).Value = syncState;
        checkpoint.Parameters.Add("@Done", SqlDbType.Bit).Value = done;
        await checkpoint.ExecuteNonQueryAsync(ct);

        await transaction.CommitAsync(ct);
        return new PageResult(added, changed, deleted);
    }

    // Messages of a folder that have no body row yet, newest first.
    public async Task<List<(long MessageID, string ItemId)>> GetMessagesWithoutBodyAsync(int userId, long folderId, int top, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT TOP (@Top) m.[MessageID], m.[ExchangeItemId]
            FROM [mail].[MailMessage] m
            WHERE m.[UserID] = @UserID AND m.[FolderID] = @FolderID AND m.[DeletedAt] IS NULL
              AND NOT EXISTS (SELECT 1 FROM [mail].[MailMessageBody] b WHERE b.[MessageID] = m.[MessageID])
            ORDER BY m.[ReceivedAt] DESC;
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
        command.Parameters.Add("@Top", SqlDbType.Int).Value = top;
        var rows = new List<(long, string)>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) rows.Add((reader.GetInt64(0), reader.GetString(1)));
        return rows;
    }

    // Bodies (already sanitized; HTML compressed, see BodySanitizer.Compress) and
    // attachment details of a few messages, in one transaction. A body row with no
    // HTML and no text marks a message whose body Exchange could not give (logged
    // as a BadItem), so it is not asked for again.
    public async Task SaveBodiesAsync(int userId, IReadOnlyList<(long MessageID, byte[]? HtmlGz, string? Text, IReadOnlyList<MailAttachmentInfo> Attachments)> bodies,
        CancellationToken ct)
    {
        if (bodies.Count == 0) return;
        await using var connection = await OpenAsync(ct);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);
        foreach (var body in bodies)
        {
            await using var command = Command(connection, """
                IF EXISTS (SELECT 1 FROM [mail].[MailMessage] WHERE [MessageID] = @MessageID AND [UserID] = @UserID)
                BEGIN
                    IF EXISTS (SELECT 1 FROM [mail].[MailMessageBody] WITH (UPDLOCK, HOLDLOCK) WHERE [MessageID] = @MessageID)
                        UPDATE [mail].[MailMessageBody] SET [BodyHtmlGz] = @HtmlGz, [BodyText] = @Text WHERE [MessageID] = @MessageID;
                    ELSE
                        INSERT INTO [mail].[MailMessageBody] ([MessageID], [BodyHtmlGz], [BodyText]) VALUES (@MessageID, @HtmlGz, @Text);
                    INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                    VALUES ('MailMessageBody', CAST(@MessageID AS VARCHAR(20)), 'U', @UserID);

                    DECLARE @New TABLE ([Id] VARCHAR(512) COLLATE Latin1_General_BIN2, [Name] NVARCHAR(255), [ContentType] VARCHAR(255),
                                        [Size] BIGINT, [IsInline] BIT, [ContentId] NVARCHAR(255));
                    INSERT INTO @New
                    SELECT [id], [name], [type], [size], [inline], [cid]
                    FROM OPENJSON(@Attachments) WITH ([id] VARCHAR(512), [name] NVARCHAR(255), [type] VARCHAR(255),
                                                       [size] BIGINT, [inline] BIT, [cid] NVARCHAR(255));
                    DECLARE @Gone TABLE ([AttachmentID] BIGINT);
                    DECLARE @Kept TABLE ([AttachmentID] BIGINT);
                    DELETE a OUTPUT deleted.[AttachmentID] INTO @Gone
                    FROM [mail].[MailAttachment] a
                    WHERE a.[MessageID] = @MessageID AND NOT EXISTS (SELECT 1 FROM @New n WHERE n.[Id] = a.[ExchangeAttachmentId]);
                    UPDATE a SET a.[Name] = n.[Name], a.[ContentType] = n.[ContentType], a.[Size] = n.[Size],
                                 a.[IsInline] = n.[IsInline], a.[ContentId] = n.[ContentId]
                    OUTPUT inserted.[AttachmentID] INTO @Kept
                    FROM [mail].[MailAttachment] a JOIN @New n ON n.[Id] = a.[ExchangeAttachmentId]
                    WHERE a.[MessageID] = @MessageID;
                    INSERT INTO [mail].[MailAttachment] ([MessageID], [ExchangeAttachmentId], [Name], [ContentType], [Size], [IsInline], [ContentId])
                    OUTPUT inserted.[AttachmentID] INTO @Kept
                    SELECT @MessageID, n.[Id], n.[Name], n.[ContentType], n.[Size], ISNULL(n.[IsInline], 0), n.[ContentId]
                    FROM @New n
                    WHERE NOT EXISTS (SELECT 1 FROM [mail].[MailAttachment] a WHERE a.[MessageID] = @MessageID AND a.[ExchangeAttachmentId] = n.[Id]);
                    INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                    SELECT 'MailAttachment', CAST([AttachmentID] AS VARCHAR(20)), 'D', @UserID FROM @Gone
                    UNION ALL
                    SELECT 'MailAttachment', CAST([AttachmentID] AS VARCHAR(20)), 'U', @UserID FROM @Kept;
                END
                """, transaction);
            command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            command.Parameters.Add("@MessageID", SqlDbType.BigInt).Value = body.MessageID;
            command.Parameters.Add("@HtmlGz", SqlDbType.VarBinary, -1).Value = (object?)body.HtmlGz ?? DBNull.Value;
            command.Parameters.Add("@Text", SqlDbType.NVarChar, -1).Value = (object?)body.Text ?? DBNull.Value;
            command.Parameters.Add("@Attachments", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(body.Attachments.Select(a =>
                new { id = a.AttachmentId, name = a.Name, type = a.ContentType, size = a.Size, inline = a.IsInline, cid = a.ContentId }));
            await command.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
    }

    public async Task SetFolderStateAsync(long folderId, string status, FolderInfo? counts, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailFolder]
            SET [FolderSyncStatus] = @Status,
                [TotalCount] = COALESCE(@Total, [TotalCount]), [UnreadCount] = COALESCE(@Unread, [UnreadCount])
            OUTPUT inserted.[UserID]
            WHERE [FolderID] = @FolderID;
            """, transaction);
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
        command.Parameters.Add("@Status", SqlDbType.VarChar, 12).Value = status;
        command.Parameters.Add("@Total", SqlDbType.Int).Value = (object?)counts?.TotalCount ?? DBNull.Value;
        command.Parameters.Add("@Unread", SqlDbType.Int).Value = (object?)counts?.UnreadCount ?? DBNull.Value;
        var userId = await command.ExecuteScalarAsync(ct);
        if (counts is not null && userId is int id)
        {
            await using var change = Command(connection, """
                INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
                VALUES ('MailFolder', CAST(@FolderID AS VARCHAR(20)), 'U', @UserID);
                """, transaction);
            change.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
            change.Parameters.Add("@UserID", SqlDbType.Int).Value = id;
            await change.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
    }

    public async Task RecordSuccessAsync(int userId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailUser]
            SET [SyncStatus] = 'OK', [LastSyncAt] = SYSDATETIME(), [LastSyncAttemptAt] = SYSDATETIME(), [ConsecutiveFailures] = 0
            WHERE [UserID] = @UserID AND [IsEnabled] = 1;
            INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
            VALUES ('MailUser', CAST(@UserID AS VARCHAR(20)), 'U', @UserID);
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        await command.ExecuteNonQueryAsync(ct);
    }

    // A failed sync: counts the account toward Error (MailPlan 6.5) and adds to
    // the grouped error row (one open row per type + account + folder + code).
    public async Task RecordFailureAsync(int userId, long? folderId, string errorType, EwsException error, int errorAfter, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailUser]
            SET [ConsecutiveFailures] = [ConsecutiveFailures] + 1, [LastSyncAttemptAt] = SYSDATETIME(),
                [SyncStatus] = CASE WHEN [IsEnabled] = 0 THEN 'Disabled'
                                    WHEN [ConsecutiveFailures] + 1 >= @ErrorAfter THEN 'Error' ELSE [SyncStatus] END,
                [LastErrorKind] = @Kind, [LastErrorCode] = @Code, [LastErrorAt] = SYSDATETIME()
            WHERE [UserID] = @UserID;
            UPDATE [mail].[MailSyncError]
            SET [Count] = [Count] + 1, [LastSeenAt] = SYSDATETIME(), [Message] = @Message
            WHERE [ErrorType] = @Type AND [UserID] = @UserID AND [Code] = @Code AND [ResolvedAt] IS NULL
              AND ([FolderID] = @FolderID OR ([FolderID] IS NULL AND @FolderID IS NULL));
            IF @@ROWCOUNT = 0
                INSERT INTO [mail].[MailSyncError] ([ErrorType], [UserID], [FolderID], [Code], [Message])
                VALUES (@Type, @UserID, @FolderID, @Code, @Message);
            INSERT INTO [mail].[MailChange] ([TableName], [RowKey], [Operation], [UserID])
            VALUES ('MailUser', CAST(@UserID AS VARCHAR(20)), 'U', @UserID);
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = (object?)folderId ?? DBNull.Value;
        command.Parameters.Add("@Type", SqlDbType.VarChar, 20).Value = errorType;
        command.Parameters.Add("@Kind", SqlDbType.VarChar, 20).Value = error.Kind.ToString();
        command.Parameters.Add("@Code", SqlDbType.VarChar, 100).Value = Cut(error.Code, 100);
        command.Parameters.Add("@Message", SqlDbType.NVarChar, 1000).Value = (object?)Cut(error.Message, 1000) ?? DBNull.Value;
        command.Parameters.Add("@ErrorAfter", SqlDbType.Int).Value = errorAfter;
        await command.ExecuteNonQueryAsync(ct);
    }

    // One folder failed while the rest of the mailbox synced: the grouped error
    // only, the account's status is not touched.
    public async Task RecordFolderErrorAsync(int userId, long folderId, string errorType, EwsException error, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailSyncError]
            SET [Count] = [Count] + 1, [LastSeenAt] = SYSDATETIME(), [Message] = @Message
            WHERE [ErrorType] = @Type AND [UserID] = @UserID AND [FolderID] = @FolderID AND [Code] = @Code AND [ResolvedAt] IS NULL;
            IF @@ROWCOUNT = 0
                INSERT INTO [mail].[MailSyncError] ([ErrorType], [UserID], [FolderID], [Code], [Message])
                VALUES (@Type, @UserID, @FolderID, @Code, @Message);
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
        command.Parameters.Add("@Type", SqlDbType.VarChar, 20).Value = errorType;
        command.Parameters.Add("@Code", SqlDbType.VarChar, 100).Value = Cut(error.Code, 100);
        command.Parameters.Add("@Message", SqlDbType.NVarChar, 1000).Value = (object?)Cut(error.Message, 1000) ?? DBNull.Value;
        await command.ExecuteNonQueryAsync(ct);
    }

    // A folder (folderId) or the whole account (folderId null) synced fine again:
    // its open errors are resolved. BadItem stays open -- those messages are still unreadable.
    public async Task ResolveErrorsAsync(int userId, long? folderId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailSyncError] SET [ResolvedAt] = SYSDATETIME()
            WHERE [UserID] = @UserID AND [ResolvedAt] IS NULL AND [ErrorType] <> 'BadItem'
              AND ([FolderID] = @FolderID OR ([FolderID] IS NULL AND @FolderID IS NULL));
            """);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = (object?)folderId ?? DBNull.Value;
        await command.ExecuteNonQueryAsync(ct);
    }

    // Items Exchange could not return: one grouped BadItem error per folder.
    public async Task RecordBadItemsAsync(int userId, long folderId, IReadOnlyList<ItemFailure> failures, CancellationToken ct)
    {
        if (failures.Count == 0) return;
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailSyncError]
            SET [Count] = [Count] + @Count, [LastSeenAt] = SYSDATETIME(), [Message] = @Message
            WHERE [ErrorType] = 'BadItem' AND [UserID] = @UserID AND [FolderID] = @FolderID AND [Code] = @Code AND [ResolvedAt] IS NULL;
            IF @@ROWCOUNT = 0
                INSERT INTO [mail].[MailSyncError] ([ErrorType], [UserID], [FolderID], [Code], [Message], [Count])
                VALUES ('BadItem', @UserID, @FolderID, @Code, @Message, @Count);
            """);
        var first = failures[0];
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
        command.Parameters.Add("@Code", SqlDbType.VarChar, 100).Value = Cut(first.Code, 100);
        command.Parameters.Add("@Message", SqlDbType.NVarChar, 1000).Value = Cut(first.Message, 1000) ?? "";
        command.Parameters.Add("@Count", SqlDbType.Int).Value = failures.Count;
        await command.ExecuteNonQueryAsync(ct);
    }

    // ---- Publisher (MailPlan 2.2): the change log -> the external Mail database ----

    public sealed record ChangeRow(long Seq, string Table, string RowKey, char Operation);

    public async Task<long> GetLastPublishedAsync(CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, "SELECT [LastPublishedSeq] FROM [mail].[MailPublishState] WHERE [StateID] = 1");
        return (long)(await command.ExecuteScalarAsync(ct) ?? 0L);
    }

    // The next changes after a sequence, in order. READCOMMITTEDLOCK: a change
    // still being written (lower Seq, not committed yet) is waited for, never skipped.
    public async Task<List<ChangeRow>> ReadChangesAsync(long afterSeq, int max, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT TOP (@Max) [Seq], [TableName], [RowKey], [Operation]
            FROM [mail].[MailChange] WITH (READCOMMITTEDLOCK)
            WHERE [Seq] > @After ORDER BY [Seq];
            """);
        command.Parameters.Add("@Max", SqlDbType.Int).Value = max;
        command.Parameters.Add("@After", SqlDbType.BigInt).Value = afterSeq;
        var rows = new List<ChangeRow>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            rows.Add(new ChangeRow(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3)[0]));
        return rows;
    }

    // The current rows for the given keys (rows that are gone are simply absent).
    public async Task<PublishRows> LoadPublishRowsAsync(IReadOnlyCollection<long> users, IReadOnlyCollection<long> folders,
        IReadOnlyCollection<long> messages, IReadOnlyCollection<long> bodies, IReadOnlyCollection<long> attachments, CancellationToken ct)
    {
        var rows = new PublishRows();
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            SELECT u.[UserID], u.[SmtpAddress], u.[DisplayName], u.[IsEnabled], u.[SyncStatus], u.[LastSyncAt], u.[LastNotificationAt],
                   u.[ExchangeItemCount], u.[ExchangeUnreadCount], u.[Username]
            FROM [mail].[MailUser] u JOIN OPENJSON(@Users) WITH ([id] BIGINT '$') k ON k.[id] = u.[UserID];

            SELECT f.[FolderID], f.[UserID], f.[ParentFolderID], f.[ExchangeFolderId], f.[DisplayName], f.[FolderType], f.[TotalCount],
                   f.[UnreadCount], f.[LastSyncAt]
            FROM [mail].[MailFolder] f JOIN OPENJSON(@Folders) WITH ([id] BIGINT '$') k ON k.[id] = f.[FolderID];

            SELECT m.[MessageID], m.[UserID], m.[FolderID], m.[ExchangeItemId], m.[ChangeKey], m.[InternetMessageId], m.[ConversationId],
                   m.[Subject], m.[FromName], m.[FromAddress], m.[SentAt], m.[ReceivedAt], m.[IsRead], m.[FlagStatus], m.[Importance],
                   m.[HasAttachments], m.[IsDraft], m.[Preview]
            FROM [mail].[MailMessage] m JOIN OPENJSON(@Messages) WITH ([id] BIGINT '$') k ON k.[id] = m.[MessageID]
            WHERE m.[DeletedAt] IS NULL;

            SELECT r.[MessageID], r.[RecipientType], r.[Position], r.[Name], r.[Address]
            FROM [mail].[MailRecipient] r JOIN OPENJSON(@Messages) WITH ([id] BIGINT '$') k ON k.[id] = r.[MessageID]
            ORDER BY r.[MessageID], r.[RecipientType], r.[Position];

            SELECT b.[MessageID], b.[BodyHtmlGz], b.[BodyText]
            FROM [mail].[MailMessageBody] b JOIN OPENJSON(@Bodies) WITH ([id] BIGINT '$') k ON k.[id] = b.[MessageID]
            JOIN [mail].[MailMessage] m ON m.[MessageID] = b.[MessageID] AND m.[DeletedAt] IS NULL;

            SELECT a.[AttachmentID], a.[MessageID], a.[ExchangeAttachmentId], a.[Name], a.[ContentType], a.[Size], a.[IsInline], a.[ContentId]
            FROM [mail].[MailAttachment] a JOIN OPENJSON(@Attachments) WITH ([id] BIGINT '$') k ON k.[id] = a.[AttachmentID]
            JOIN [mail].[MailMessage] m ON m.[MessageID] = a.[MessageID] AND m.[DeletedAt] IS NULL;
            """);
        command.Parameters.Add("@Users", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(users);
        command.Parameters.Add("@Folders", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(folders);
        command.Parameters.Add("@Messages", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(messages);
        command.Parameters.Add("@Bodies", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(bodies);
        command.Parameters.Add("@Attachments", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(attachments);
        await using var r = await command.ExecuteReaderAsync(ct);
        static string? S(SqlDataReader x, int i) => x.IsDBNull(i) ? null : x.GetString(i);
        static DateTime? D(SqlDataReader x, int i) => x.IsDBNull(i) ? null : x.GetDateTime(i);
        static int? I(SqlDataReader x, int i) => x.IsDBNull(i) ? null : x.GetInt32(i);
        while (await r.ReadAsync(ct))
            rows.Users[r.GetInt32(0)] = (r.GetInt32(0), r.GetString(1), S(r, 2), r.GetBoolean(3), r.GetString(4), D(r, 5), D(r, 6), I(r, 7), I(r, 8), S(r, 9));
        await r.NextResultAsync(ct);
        while (await r.ReadAsync(ct))
            rows.Folders[r.GetInt64(0)] = (r.GetInt64(0), r.GetInt32(1), r.IsDBNull(2) ? null : r.GetInt64(2), r.GetString(3), r.GetString(4),
                r.GetString(5), r.GetInt32(6), r.GetInt32(7), D(r, 8));
        await r.NextResultAsync(ct);
        while (await r.ReadAsync(ct))
            rows.Messages[r.GetInt64(0)] = (r.GetInt64(0), r.GetInt32(1), r.GetInt64(2), r.GetString(3), r.GetString(4), S(r, 5), S(r, 6),
                S(r, 7), S(r, 8), S(r, 9), D(r, 10), r.GetDateTime(11), r.GetBoolean(12), r.GetByte(13), r.GetByte(14), r.GetBoolean(15),
                r.GetBoolean(16), S(r, 17));
        await r.NextResultAsync(ct);
        while (await r.ReadAsync(ct))
        {
            if (!rows.Recipients.TryGetValue(r.GetInt64(0), out var list)) rows.Recipients[r.GetInt64(0)] = list = [];
            list.Add(new(r.GetByte(1), r.GetInt16(2), S(r, 3), S(r, 4)));
        }
        await r.NextResultAsync(ct);
        while (await r.ReadAsync(ct))
            rows.Bodies[r.GetInt64(0)] = (r.IsDBNull(1) ? null : (byte[])r.GetValue(1), S(r, 2));
        await r.NextResultAsync(ct);
        while (await r.ReadAsync(ct))
            rows.Attachments[r.GetInt64(0)] = (r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), S(r, 4),
                r.IsDBNull(5) ? null : r.GetInt64(5), r.GetBoolean(6), S(r, 7));
        return rows;
    }

    public sealed class PublishRows
    {
        public Dictionary<long, (int UserId, string Smtp, string? Name, bool Enabled, string Status, DateTime? LastSync,
            DateTime? LastNote, int? Items, int? Unread, string? Username)> Users { get; } = [];
        public Dictionary<long, (long Id, int UserId, long? Parent, string ExId, string Name, string Type, int Total, int Unread,
            DateTime? LastSync)> Folders { get; } = [];
        public Dictionary<long, (long Id, int UserId, long FolderId, string ItemId, string ChangeKey, string? InternetId,
            string? Conversation, string? Subject, string? FromName, string? FromAddress, DateTime? SentAt, DateTime ReceivedAt,
            bool IsRead, byte Flag, byte Importance, bool HasAttachments, bool IsDraft, string? Preview)> Messages { get; } = [];
        public Dictionary<long, List<(byte Type, short Position, string? Name, string? Address)>> Recipients { get; } = [];
        public Dictionary<long, (byte[]? HtmlGz, string? Text)> Bodies { get; } = [];
        public Dictionary<long, (long Id, long MessageId, string ExId, string Name, string? Type, long? Size, bool Inline,
            string? Cid)> Attachments { get; } = [];
    }

    // The external copy confirmed up to lastSeq (it may also move the pointer BACK,
    // when the external database is behind, e.g. restored from a backup).
    public async Task SetPublishedAsync(long lastSeq, int responseMs, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailPublishState]
            SET [LastPublishedSeq] = @Seq, [LastPublishedAt] = SYSDATETIME(), [LastAttemptAt] = SYSDATETIME(),
                [LinkStatus] = 'Up', [LastResponseMs] = @Ms
            WHERE [StateID] = 1;
            """);
        command.Parameters.Add("@Seq", SqlDbType.BigInt).Value = lastSeq;
        command.Parameters.Add("@Ms", SqlDbType.Int).Value = responseMs;
        await command.ExecuteNonQueryAsync(ct);
    }

    public async Task SetPublishErrorAsync(string message, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailPublishState]
            SET [LastAttemptAt] = SYSDATETIME(), [LinkStatus] = 'Down', [LastError] = @Message, [LastErrorAt] = SYSDATETIME()
            WHERE [StateID] = 1;
            """);
        command.Parameters.Add("@Message", SqlDbType.NVarChar, 1000).Value = Cut(message, 1000) ?? "";
        await command.ExecuteNonQueryAsync(ct);
    }

    // One component's heartbeat (Monitor/ConnectorHealth.cs): its row for this server, written every 15 s.
    public async Task BeatAsync(string component, string instance, DateTime startedAt, string metricsJson, string? lastError,
        DateTime? lastErrorAt, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = Command(connection, """
            UPDATE [mail].[MailServiceHeartbeat]
            SET [StartedAt] = @StartedAt, [LastBeatAt] = SYSDATETIME(), [Metrics] = @Metrics, [LastError] = @LastError, [LastErrorAt] = @LastErrorAt
            WHERE [Component] = @Component AND [Instance] = @Instance;
            IF @@ROWCOUNT = 0
                INSERT INTO [mail].[MailServiceHeartbeat] ([Component], [Instance], [StartedAt], [LastBeatAt], [Metrics], [LastError], [LastErrorAt])
                VALUES (@Component, @Instance, @StartedAt, SYSDATETIME(), @Metrics, @LastError, @LastErrorAt);
            """);
        command.Parameters.Add("@Component", SqlDbType.VarChar, 20).Value = component;
        command.Parameters.Add("@Instance", SqlDbType.VarChar, 100).Value = Cut(instance, 100);
        command.Parameters.Add("@StartedAt", SqlDbType.DateTime2).Value = startedAt;
        command.Parameters.Add("@Metrics", SqlDbType.NVarChar, 4000).Value = metricsJson.Length <= 4000 ? metricsJson : "{}";
        command.Parameters.Add("@LastError", SqlDbType.NVarChar, 1000).Value = (object?)Cut(lastError, 1000) ?? DBNull.Value;
        command.Parameters.Add("@LastErrorAt", SqlDbType.DateTime2).Value = (object?)lastErrorAt ?? DBNull.Value;
        await command.ExecuteNonQueryAsync(ct);
    }

    // The Mail Monitor's figures (Shared/MonitorQueries.cs, also used by the Sila Mail API inside).
    public async Task<object> GetOverviewAsync(CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        return await MonitorQueries.OverviewAsync(connection, ct);
    }

    public async Task<List<Dictionary<string, object?>>> GetAccountsAsync(CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        return await MonitorQueries.AccountsAsync(connection, ct);
    }

    public async Task<List<Dictionary<string, object?>>> GetErrorsAsync(CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        return await MonitorQueries.ErrorsAsync(connection, ct);
    }

    public async Task<object?> GetStatusAsync(int userId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        return await MonitorQueries.AccountAsync(connection, userId, ct);
    }

    private static string? Cut(string? value, int max) => value is null || value.Length <= max ? value : value[..max];
}
