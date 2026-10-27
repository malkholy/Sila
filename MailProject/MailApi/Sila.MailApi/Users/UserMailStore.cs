using System.Data;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;

namespace Sila.MailApi.Users;

public sealed record Mailbox(int UserId, string Email, string? DisplayName, bool IsEnabled, string SyncStatus, DateTime? LastSyncAt,
    DateTime? PublishedAt);

public sealed record FolderItem(long FolderId, long? ParentFolderId, string Name, string Type, int Total, int Unread);

public sealed record MessageItem(long MessageId, long FolderId, string? Subject, string? FromName, string? FromAddress, DateTime ReceivedAt,
    bool IsRead, byte FlagStatus, byte Importance, bool HasAttachments, bool IsDraft, string? Preview);

public sealed record RecipientItem(byte Type, string? Name, string? Address);

public sealed record AttachmentItem(long AttachmentId, string Name, string? ContentType, long? Size, bool IsInline, string? ContentId);

public sealed record MessageDetail(MessageItem Message, DateTime? SentAt, string? InternetMessageId, string? ConversationId,
    List<RecipientItem> Recipients, List<AttachmentItem> Attachments, string? Html, string? Text);

// A page of a folder: the messages, and the cursor for the next (older) page.
public sealed record MessagePage(List<MessageItem> Messages, string? Next);

// Read-only mail of ONE mailbox: every query is bound to the mailbox's UserID,
// which comes from the signed-in user's token, never from the request.
public interface IUserMailStore
{
    Task<Mailbox?> FindMailboxAsync(string username, CancellationToken ct);
    Task<List<FolderItem>> FoldersAsync(int userId, CancellationToken ct);
    Task<MessagePage?> MessagesAsync(int userId, long folderId, string? before, int take, CancellationToken ct);
    Task<MessageDetail?> MessageAsync(int userId, long messageId, CancellationToken ct);
    Task<List<MessageItem>> SearchAsync(int userId, string text, int take, CancellationToken ct);
    Task<AttachmentItem?> AttachmentAsync(int userId, long attachmentId, CancellationToken ct);
}

// Both copies have the same mail tables. Internal rows may be marked deleted
// (DeletedAt, a possible move still being matched): those are never shown.
public sealed class SqlUserMailStore(IConfiguration configuration, IOptions<MailApiOptions> options) : IUserMailStore
{
    private string ConnectionString => configuration.GetConnectionString("Mail")
        ?? throw new InvalidOperationException("ConnectionStrings:Mail is not configured.");

    private bool Internal => options.Value.Role == MailRole.Internal;

    // Live rows only (the internal copy keeps moved messages marked for a while).
    private string Live(string alias) => Internal ? $" AND {alias}.[DeletedAt] IS NULL" : "";

    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var connection = new SqlConnection(ConnectionString);
        await connection.OpenAsync(ct);
        return connection;
    }

    private const string ListColumns = """
        m.[MessageID], m.[FolderID], m.[Subject], m.[FromName], m.[FromAddress], m.[ReceivedAt], m.[IsRead], m.[FlagStatus],
        m.[Importance], m.[HasAttachments], m.[IsDraft], m.[Preview]
        """;

    private static MessageItem ReadItem(SqlDataReader r) => new(r.GetInt64(0), r.GetInt64(1), S(r, 2), S(r, 3), S(r, 4),
        Utc(r.GetDateTime(5)), r.GetBoolean(6), r.GetByte(7), r.GetByte(8), r.GetBoolean(9), r.GetBoolean(10), S(r, 11));

    public async Task<Mailbox?> FindMailboxAsync(string username, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = new SqlCommand($"""
            SELECT [UserID], [SmtpAddress], [DisplayName], [IsEnabled], [SyncStatus], [LastSyncAt],
                   {(Internal ? "CAST(NULL AS DATETIME2)" : "[PublishedAt]")}
            FROM [mail].[MailUser] WHERE [Username] = @Username;
            """, connection);
        command.Parameters.Add("@Username", SqlDbType.NVarChar, 50).Value = username;
        await using var r = await command.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct)
            ? new Mailbox(r.GetInt32(0), r.GetString(1), S(r, 2), r.GetBoolean(3), r.GetString(4), D(r, 5), D(r, 6))
            : null;
    }

    public async Task<List<FolderItem>> FoldersAsync(int userId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = new SqlCommand("""
            SELECT [FolderID], [ParentFolderID], [DisplayName], [FolderType], [TotalCount], [UnreadCount]
            FROM [mail].[MailFolder] WHERE [UserID] = @UserID AND [FolderType] <> 'Root'
            ORDER BY CASE [FolderType] WHEN 'Inbox' THEN 0 WHEN 'Drafts' THEN 1 WHEN 'SentItems' THEN 2 WHEN 'DeletedItems' THEN 3
                     WHEN 'JunkEmail' THEN 4 WHEN 'Outbox' THEN 5 ELSE 6 END, [DisplayName];
            """, connection);
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        var folders = new List<FolderItem>();
        await using var r = await command.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            folders.Add(new FolderItem(r.GetInt64(0), r.IsDBNull(1) ? null : r.GetInt64(1), r.GetString(2).Trim(), r.GetString(3),
                r.GetInt32(4), r.GetInt32(5)));
        return folders;
    }

    // Newest first, keyset paging on (ReceivedAt, MessageID). null = not this mailbox's folder.
    public async Task<MessagePage?> MessagesAsync(int userId, long folderId, string? before, int take, CancellationToken ct)
    {
        take = Math.Clamp(take, 1, 100);
        var cursor = Cursor.Parse(before);
        await using var connection = await OpenAsync(ct);
        await using (var owns = new SqlCommand("SELECT 1 FROM [mail].[MailFolder] WHERE [FolderID] = @FolderID AND [UserID] = @UserID", connection))
        {
            owns.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
            owns.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
            if (await owns.ExecuteScalarAsync(ct) is null) return null;
        }
        await using var command = new SqlCommand($"""
            SELECT TOP (@Take) {ListColumns}
            FROM [mail].[MailMessage] m
            WHERE m.[UserID] = @UserID AND m.[FolderID] = @FolderID{Live("m")}
              AND (@BeforeAt IS NULL OR m.[ReceivedAt] < @BeforeAt OR (m.[ReceivedAt] = @BeforeAt AND m.[MessageID] < @BeforeId))
            ORDER BY m.[ReceivedAt] DESC, m.[MessageID] DESC;
            """, connection);
        command.Parameters.Add("@Take", SqlDbType.Int).Value = take + 1;   // one more: is there a next page?
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@FolderID", SqlDbType.BigInt).Value = folderId;
        command.Parameters.Add("@BeforeAt", SqlDbType.DateTime2).Value = (object?)cursor?.At ?? DBNull.Value;
        command.Parameters.Add("@BeforeId", SqlDbType.BigInt).Value = (object?)cursor?.Id ?? DBNull.Value;
        var items = new List<MessageItem>();
        await using var r = await command.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) items.Add(ReadItem(r));
        string? next = null;
        if (items.Count > take)
        {
            items.RemoveAt(take);
            next = Cursor.Make(items[^1].ReceivedAt, items[^1].MessageId);
        }
        return new MessagePage(items, next);
    }

    public async Task<MessageDetail?> MessageAsync(int userId, long messageId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = new SqlCommand($"""
            SELECT {ListColumns}, m.[SentAt], m.[InternetMessageId], m.[ConversationId], b.[BodyHtmlGz], b.[BodyText]
            FROM [mail].[MailMessage] m
            LEFT JOIN [mail].[MailMessageBody] b ON b.[MessageID] = m.[MessageID]
            WHERE m.[MessageID] = @MessageID AND m.[UserID] = @UserID{Live("m")};

            SELECT [RecipientType], [Name], [Address] FROM [mail].[MailRecipient]
            WHERE [MessageID] = @MessageID AND EXISTS (SELECT 1 FROM [mail].[MailMessage] x WHERE x.[MessageID] = @MessageID AND x.[UserID] = @UserID)
            ORDER BY [RecipientType], [Position];

            SELECT [AttachmentID], [Name], [ContentType], [Size], [IsInline], [ContentId] FROM [mail].[MailAttachment]
            WHERE [MessageID] = @MessageID AND EXISTS (SELECT 1 FROM [mail].[MailMessage] x WHERE x.[MessageID] = @MessageID AND x.[UserID] = @UserID)
            ORDER BY [IsInline], [AttachmentID];
            """, connection);
        command.Parameters.Add("@MessageID", SqlDbType.BigInt).Value = messageId;
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        await using var r = await command.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        var item = ReadItem(r);
        var sentAt = D(r, 12) is { } sent ? Utc(sent) : (DateTime?)null;
        var internetId = S(r, 13);
        var conversation = S(r, 14);
        var html = r.IsDBNull(15) ? null : Gunzip((byte[])r.GetValue(15));
        var text = S(r, 16);
        await r.NextResultAsync(ct);
        var recipients = new List<RecipientItem>();
        while (await r.ReadAsync(ct)) recipients.Add(new RecipientItem(r.GetByte(0), S(r, 1), S(r, 2)));
        await r.NextResultAsync(ct);
        var attachments = new List<AttachmentItem>();
        while (await r.ReadAsync(ct))
            attachments.Add(new AttachmentItem(r.GetInt64(0), r.GetString(1), S(r, 2), r.IsDBNull(3) ? null : r.GetInt64(3), r.GetBoolean(4), S(r, 5)));
        // The text is only for search when there is HTML; send it when there is no HTML.
        return new MessageDetail(item, sentAt, internetId, conversation, recipients, attachments, html, html is null ? text : null);
    }

    // Subject, sender and recipients (body search comes with full-text indexing).
    public async Task<List<MessageItem>> SearchAsync(int userId, string text, int take, CancellationToken ct)
    {
        take = Math.Clamp(take, 1, 100);
        await using var connection = await OpenAsync(ct);
        await using var command = new SqlCommand($"""
            SELECT TOP (@Take) {ListColumns}
            FROM [mail].[MailMessage] m
            WHERE m.[UserID] = @UserID{Live("m")}
              AND (m.[Subject] LIKE @Like ESCAPE '\' OR m.[FromName] LIKE @Like ESCAPE '\' OR m.[FromAddress] LIKE @Like ESCAPE '\'
                   OR EXISTS (SELECT 1 FROM [mail].[MailRecipient] x WHERE x.[MessageID] = m.[MessageID]
                              AND (x.[Name] LIKE @Like ESCAPE '\' OR x.[Address] LIKE @Like ESCAPE '\')))
            ORDER BY m.[ReceivedAt] DESC, m.[MessageID] DESC;
            """, connection) { CommandTimeout = 60 };
        command.Parameters.Add("@Take", SqlDbType.Int).Value = take;
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        command.Parameters.Add("@Like", SqlDbType.NVarChar, 210).Value = "%" + EscapeLike(text) + "%";
        var items = new List<MessageItem>();
        await using var r = await command.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) items.Add(ReadItem(r));
        return items;
    }

    // One attachment's details, only when it is on a live message of this mailbox.
    public async Task<AttachmentItem?> AttachmentAsync(int userId, long attachmentId, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = new SqlCommand($"""
            SELECT a.[AttachmentID], a.[Name], a.[ContentType], a.[Size], a.[IsInline], a.[ContentId]
            FROM [mail].[MailAttachment] a
            JOIN [mail].[MailMessage] m ON m.[MessageID] = a.[MessageID]
            WHERE a.[AttachmentID] = @AttachmentID AND m.[UserID] = @UserID{Live("m")};
            """, connection);
        command.Parameters.Add("@AttachmentID", SqlDbType.BigInt).Value = attachmentId;
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        await using var r = await command.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct)
            ? new AttachmentItem(r.GetInt64(0), r.GetString(1), S(r, 2), r.IsDBNull(3) ? null : r.GetInt64(3), r.GetBoolean(4), S(r, 5))
            : null;
    }

    // The user's words are a value, never a pattern: %, _ and [ match themselves.
    internal static string EscapeLike(string text) =>
        text.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace("[", "\\[");

    // BodyHtmlGz: gzip of the UTF-16 text (the format of SQL Server's COMPRESS(nvarchar)).
    internal static string Gunzip(byte[] stored)
    {
        using var gzip = new GZipStream(new MemoryStream(stored), CompressionMode.Decompress);
        using var text = new MemoryStream();
        gzip.CopyTo(text);
        return Encoding.Unicode.GetString(text.GetBuffer(), 0, (int)text.Length);
    }

    private static string? S(SqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    private static DateTime? D(SqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetDateTime(i);
    // Message dates are stored in UTC.
    private static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);
}

// The "older than" cursor of a message page: "<UTC ticks>.<MessageID>".
public static class Cursor
{
    public static string Make(DateTime receivedAt, long messageId) =>
        $"{receivedAt.Ticks.ToString(CultureInfo.InvariantCulture)}.{messageId.ToString(CultureInfo.InvariantCulture)}";

    public static (DateTime At, long Id)? Parse(string? cursor)
    {
        if (string.IsNullOrEmpty(cursor) || cursor.Length > 40) return null;
        var parts = cursor.Split('.');
        return parts.Length == 2 && long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)
               && ticks >= DateTime.MinValue.Ticks && ticks <= DateTime.MaxValue.Ticks
               && long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var id)
            ? (new DateTime(ticks, DateTimeKind.Utc), id)
            : null;
    }
}
