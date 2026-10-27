using System.Data;
using Microsoft.Data.SqlClient;

namespace Sila.Mail.Monitor;

// The Mail Monitor's figures from InternalMail (MailPlan 6): read by the Mail
// Connector API (pushed out to the external Sila Mail API) and by the Sila Mail
// API inside (served live). Shared by both projects (linked source file).
// Read-only, parameterized. Needs InternalMail 004 (MailUser.Username).
public static class MonitorQueries
{
    // Mail Monitor (MailPlan 6.1): totals across every mailbox, the publish
    // state, open errors and the latest sync runs.
    public static async Task<object> OverviewAsync(SqlConnection connection, CancellationToken ct)
    {
        await using var command = new SqlCommand("""
            SELECT COUNT(*) AS [Mailboxes],
                   SUM(CASE WHEN [IsEnabled] = 1 AND [SyncStatus] = 'OK' THEN 1 ELSE 0 END) AS [Ok],
                   SUM(CASE WHEN [IsEnabled] = 1 AND [SyncStatus] = 'Behind' THEN 1 ELSE 0 END) AS [Behind],
                   SUM(CASE WHEN [IsEnabled] = 1 AND [SyncStatus] = 'Error' THEN 1 ELSE 0 END) AS [Error],
                   SUM(CASE WHEN [IsEnabled] = 0 THEN 1 ELSE 0 END) AS [Disabled],
                   MIN(CASE WHEN [IsEnabled] = 1 THEN [LastSyncAt] END) AS [OldestSyncAt],
                   MAX([LastSyncAt]) AS [LastSyncAt]
            FROM [mail].[MailUser];

            SELECT (SELECT COUNT(*) FROM [mail].[MailFolder] WHERE [IsSynced] = 1 AND [FolderType] <> 'Root') AS [Folders],
                   (SELECT ISNULL(SUM(CAST([TotalCount] AS BIGINT)), 0) FROM [mail].[MailFolder] WHERE [IsSynced] = 1 AND [FolderType] <> 'Root') AS [ExchangeItems],
                   (SELECT ISNULL(SUM(CAST([UnreadCount] AS BIGINT)), 0) FROM [mail].[MailFolder] WHERE [IsSynced] = 1 AND [FolderType] <> 'Root') AS [ExchangeUnread],
                   (SELECT COUNT_BIG(*) FROM [mail].[MailMessage] WHERE [DeletedAt] IS NULL) AS [Messages],
                   (SELECT COUNT_BIG(*) FROM [mail].[MailMessage] WHERE [DeletedAt] IS NULL AND [IsRead] = 0) AS [Unread],
                   (SELECT COUNT_BIG(*) FROM [mail].[MailMessage] WHERE [DeletedAt] IS NOT NULL) AS [MarkedDeleted],
                   (SELECT COUNT_BIG(*) FROM [mail].[MailMessageBody]) AS [Bodies],
                   (SELECT COUNT_BIG(*) FROM [mail].[MailAttachment]) AS [Attachments],
                   (SELECT COUNT_BIG(*) FROM [mail].[MailAttachment] WHERE [IsInline] = 1) AS [InlineImages],
                   (SELECT ISNULL(SUM([Size]), 0) FROM [mail].[MailAttachment]) AS [AttachmentBytes];

            SELECT p.[LastPublishedSeq], p.[LastPublishedAt], p.[LinkStatus], p.[LastError], p.[LastErrorAt],
                   ISNULL((SELECT MAX([Seq]) FROM [mail].[MailChange]), 0) AS [LastChangeSeq]
            FROM [mail].[MailPublishState] p;

            SELECT COUNT(*) AS [OpenErrors], ISNULL(SUM([Count]), 0) AS [Occurrences]
            FROM [mail].[MailSyncError] WHERE [ResolvedAt] IS NULL;

            SELECT TOP (20) l.[SyncLogID], l.[UserID], u.[SmtpAddress], l.[Kind], l.[Reason], f.[DisplayName] AS [Folder],
                   l.[StartedAt], l.[EndedAt], l.[Pages], l.[Added], l.[Changed], l.[Deleted], l.[Matched],
                   l.[Succeeded], l.[ErrorKind], l.[ErrorCode], l.[ErrorMessage]
            FROM [mail].[MailSyncLog] l
            JOIN [mail].[MailUser] u ON u.[UserID] = l.[UserID]
            LEFT JOIN [mail].[MailFolder] f ON f.[FolderID] = l.[FolderID]
            ORDER BY l.[SyncLogID] DESC;
            """, connection) { CommandTimeout = 60 };
        await using var reader = await command.ExecuteReaderAsync(ct);
        var accounts = (await ReadRowsAsync(reader, ct))[0];
        await reader.NextResultAsync(ct);
        var content = (await ReadRowsAsync(reader, ct))[0];
        await reader.NextResultAsync(ct);
        var publish = (await ReadRowsAsync(reader, ct)).FirstOrDefault();
        await reader.NextResultAsync(ct);
        var errors = (await ReadRowsAsync(reader, ct))[0];
        await reader.NextResultAsync(ct);
        var runs = await ReadRowsAsync(reader, ct);
        return new { accounts, content, publish, errors, recentSyncs = runs, time = DateTime.Now };
    }

    // Mail Monitor, Accounts tab (MailPlan 6.2): one row per mailbox.
    public static async Task<List<Dictionary<string, object?>>> AccountsAsync(SqlConnection connection, CancellationToken ct)
    {
        await using var command = new SqlCommand("""
            SELECT u.[UserID], u.[SmtpAddress], u.[DisplayName], u.[Username], u.[IsEnabled], u.[SyncStatus], u.[SubscriptionStatus],
                   u.[LastSyncAt], u.[LastSyncAttemptAt], u.[ConsecutiveFailures], u.[LastErrorKind], u.[LastErrorCode], u.[LastErrorAt],
                   f.[Folders], f.[FoldersOk], f.[ExchangeItems], f.[ExchangeUnread],
                   m.[Messages], m.[Unread], b.[Bodies], a.[Attachments], e.[OpenErrors],
                   CASE WHEN r.[SyncLogID] IS NULL THEN 0 ELSE 1 END AS [Running], r.[Kind] AS [RunningKind], r.[Folder] AS [RunningFolder]
            FROM [mail].[MailUser] u
            OUTER APPLY (SELECT COUNT(*) AS [Folders], SUM(CASE WHEN [FolderSyncStatus] = 'OK' THEN 1 ELSE 0 END) AS [FoldersOk],
                                ISNULL(SUM(CAST([TotalCount] AS BIGINT)), 0) AS [ExchangeItems],
                                ISNULL(SUM(CAST([UnreadCount] AS BIGINT)), 0) AS [ExchangeUnread]
                         FROM [mail].[MailFolder] WHERE [UserID] = u.[UserID] AND [IsSynced] = 1 AND [FolderType] <> 'Root') f
            OUTER APPLY (SELECT COUNT_BIG(*) AS [Messages], ISNULL(SUM(CASE WHEN [IsRead] = 0 THEN 1 ELSE 0 END), 0) AS [Unread]
                         FROM [mail].[MailMessage] WHERE [UserID] = u.[UserID] AND [DeletedAt] IS NULL) m
            OUTER APPLY (SELECT COUNT_BIG(*) AS [Bodies] FROM [mail].[MailMessage] x
                         JOIN [mail].[MailMessageBody] y ON y.[MessageID] = x.[MessageID]
                         WHERE x.[UserID] = u.[UserID] AND x.[DeletedAt] IS NULL) b
            OUTER APPLY (SELECT COUNT_BIG(*) AS [Attachments] FROM [mail].[MailMessage] x
                         JOIN [mail].[MailAttachment] y ON y.[MessageID] = x.[MessageID]
                         WHERE x.[UserID] = u.[UserID] AND x.[DeletedAt] IS NULL) a
            OUTER APPLY (SELECT COUNT(*) AS [OpenErrors] FROM [mail].[MailSyncError]
                         WHERE [UserID] = u.[UserID] AND [ResolvedAt] IS NULL) e
            OUTER APPLY (SELECT TOP (1) l.[SyncLogID], l.[Kind], f2.[DisplayName] AS [Folder] FROM [mail].[MailSyncLog] l
                         LEFT JOIN [mail].[MailFolder] f2 ON f2.[FolderID] = l.[FolderID]
                         WHERE l.[UserID] = u.[UserID] AND l.[Succeeded] IS NULL AND l.[StartedAt] > DATEADD(HOUR, -12, SYSDATETIME())
                         ORDER BY l.[SyncLogID] DESC) r
            ORDER BY u.[SmtpAddress];
            """, connection) { CommandTimeout = 60 };
        await using var reader = await command.ExecuteReaderAsync(ct);
        return await ReadRowsAsync(reader, ct);
    }

    // Mail Monitor, Errors tab (MailPlan 6.3): open grouped errors, newest first.
    public static async Task<List<Dictionary<string, object?>>> ErrorsAsync(SqlConnection connection, CancellationToken ct)
    {
        await using var command = new SqlCommand("""
            SELECT TOP (500) e.[ErrorID], e.[ErrorType], e.[UserID], u.[SmtpAddress], e.[FolderID], f.[DisplayName] AS [Folder],
                   e.[Code], e.[Message], e.[Count], e.[FirstSeenAt], e.[LastSeenAt]
            FROM [mail].[MailSyncError] e
            LEFT JOIN [mail].[MailUser] u ON u.[UserID] = e.[UserID]
            LEFT JOIN [mail].[MailFolder] f ON f.[FolderID] = e.[FolderID]
            WHERE e.[ResolvedAt] IS NULL
            ORDER BY e.[LastSeenAt] DESC;
            """, connection) { CommandTimeout = 60 };
        await using var reader = await command.ExecuteReaderAsync(ct);
        return await ReadRowsAsync(reader, ct);
    }

    // The mailbox's state for an admin: account, folders (Exchange vs DB counts), recent sync runs.
    public static async Task<object?> AccountAsync(SqlConnection connection, int userId, CancellationToken ct)
    {
        await using var command = new SqlCommand("""
            SELECT [UserID], [SmtpAddress], [DisplayName], [Username], [IsEnabled], [SyncStatus], [LastSyncAt], [LastSyncAttemptAt],
                   [ConsecutiveFailures], [LastErrorKind], [LastErrorCode], [LastErrorAt]
            FROM [mail].[MailUser] WHERE [UserID] = @UserID;

            SELECT f.[FolderID], f.[DisplayName], f.[FolderType], f.[TotalCount], f.[UnreadCount],
                   (SELECT COUNT(*) FROM [mail].[MailMessage] m WHERE m.[FolderID] = f.[FolderID] AND m.[DeletedAt] IS NULL) AS [DbCount],
                   (SELECT COUNT(*) FROM [mail].[MailMessage] m WHERE m.[FolderID] = f.[FolderID] AND m.[DeletedAt] IS NULL AND m.[IsRead] = 0) AS [DbUnread],
                   (SELECT COUNT(*) FROM [mail].[MailMessage] m JOIN [mail].[MailMessageBody] b ON b.[MessageID] = m.[MessageID]
                    WHERE m.[FolderID] = f.[FolderID] AND m.[DeletedAt] IS NULL) AS [DbBodies],
                   (SELECT COUNT(*) FROM [mail].[MailMessage] m JOIN [mail].[MailAttachment] a ON a.[MessageID] = m.[MessageID]
                    WHERE m.[FolderID] = f.[FolderID] AND m.[DeletedAt] IS NULL) AS [DbAttachments],
                   f.[FolderSyncStatus], f.[LastSyncAt]
            FROM [mail].[MailFolder] f WHERE f.[UserID] = @UserID AND f.[FolderType] <> 'Root'
            ORDER BY CASE f.[FolderType] WHEN 'Inbox' THEN 0 WHEN 'Custom' THEN 2 ELSE 1 END, f.[DisplayName];

            SELECT TOP (30) l.[SyncLogID], l.[Kind], l.[Reason], l.[FolderID], f.[DisplayName] AS [Folder], l.[StartedAt], l.[EndedAt],
                   l.[Pages], l.[Added], l.[Changed], l.[Deleted], l.[Matched], l.[Succeeded], l.[ErrorKind], l.[ErrorCode], l.[ErrorMessage]
            FROM [mail].[MailSyncLog] l LEFT JOIN [mail].[MailFolder] f ON f.[FolderID] = l.[FolderID]
            WHERE l.[UserID] = @UserID ORDER BY l.[SyncLogID] DESC;

            SELECT e.[ErrorID], e.[ErrorType], e.[FolderID], f.[DisplayName] AS [Folder], e.[Code], e.[Message], e.[Count],
                   e.[FirstSeenAt], e.[LastSeenAt]
            FROM [mail].[MailSyncError] e LEFT JOIN [mail].[MailFolder] f ON f.[FolderID] = e.[FolderID]
            WHERE e.[UserID] = @UserID AND e.[ResolvedAt] IS NULL ORDER BY e.[LastSeenAt] DESC;
            """, connection) { CommandTimeout = 60 };
        command.Parameters.Add("@UserID", SqlDbType.Int).Value = userId;
        await using var reader = await command.ExecuteReaderAsync(ct);
        var account = await ReadRowsAsync(reader, ct);
        if (account.Count == 0) return null;
        await reader.NextResultAsync(ct);
        var folders = await ReadRowsAsync(reader, ct);
        await reader.NextResultAsync(ct);
        var runs = await ReadRowsAsync(reader, ct);
        await reader.NextResultAsync(ct);
        var errors = await ReadRowsAsync(reader, ct);
        return new { account = account[0], folders, recentSyncs = runs, errors };
    }

    private static async Task<List<Dictionary<string, object?>>> ReadRowsAsync(SqlDataReader reader, CancellationToken ct)
    {
        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync(ct))
        {
            var row = new Dictionary<string, object?>(reader.FieldCount);
            for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

}
