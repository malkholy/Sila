using System.Data;
using Microsoft.Data.SqlClient;
using Sila.Mail.Contract;

namespace Sila.MailExternal.Data;

public sealed record ApplyOutcome(bool Gap, long LastAppliedSeq, int Applied, int Skipped);

// Applies publish batches to the external Mail database ([mail] schema), one
// batch per transaction (MailPlan 7.2):
// - MailApplyState is locked first, so batches apply one at a time, and a batch
//   whose AfterSeq is beyond LastAppliedSeq is refused (it would skip changes).
// - Deletes run before upserts: a moved message's old row must be gone before
//   its Exchange ID moves to the row that keeps the MessageID (unique per user).
// - A row is written, or deleted, only when its stored PublishSeq is not newer
//   than the change's Seq: the same batch applied twice changes nothing.
// - A body or attachment whose message is not here (deleted later) is skipped.
// Every statement is parameterized.
public sealed class ApplyStore(IConfiguration configuration)
{
    private string ConnectionString => configuration.GetConnectionString("Mail")
        ?? throw new InvalidOperationException("ConnectionStrings:Mail is not configured.");

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.GetConnectionString("Mail"));

    private static SqlCommand Command(SqlConnection connection, string sql, SqlTransaction? transaction = null) =>
        new(sql, connection, transaction) { CommandTimeout = 120 };

    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var connection = new SqlConnection(ConnectionString);
        await connection.OpenAsync(ct);
        return connection;
    }

    // Reachable, the schema has the compressed body column (Mail_002), and where the copy stands.
    public async Task<(bool Ok, bool SchemaOk, long LastAppliedSeq, DateTime? LastAppliedAt)> StateAsync(CancellationToken ct)
    {
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var command = Command(connection, """
                SELECT CASE WHEN COL_LENGTH(N'mail.MailMessageBody', N'BodyHtmlGz') IS NULL THEN 0 ELSE 1 END,
                       ISNULL((SELECT [LastAppliedSeq] FROM [mail].[MailApplyState] WHERE [StateID] = 1), 0),
                       (SELECT [LastAppliedAt] FROM [mail].[MailApplyState] WHERE [StateID] = 1);
                """);
            await using var reader = await command.ExecuteReaderAsync(ct);
            await reader.ReadAsync(ct);
            return (true, reader.GetInt32(0) == 1, reader.GetInt64(1), reader.IsDBNull(2) ? null : reader.GetDateTime(2));
        }
        catch (SqlException)
        {
            return (false, false, 0, null);
        }
    }

    public async Task<ApplyOutcome> ApplyAsync(PublishBatch batch, CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);
        try
        {
            long last;
            await using (var state = Command(connection,
                "SELECT [LastAppliedSeq] FROM [mail].[MailApplyState] WITH (UPDLOCK, HOLDLOCK) WHERE [StateID] = 1", transaction))
                last = (long)(await state.ExecuteScalarAsync(ct) ?? 0L);
            if (batch.AfterSeq > last)
            {
                await transaction.RollbackAsync(ct);
                return new ApplyOutcome(true, last, 0, 0);
            }

            int applied = 0, skipped = 0;
            void Count(bool done) { if (done) applied++; else skipped++; }

            foreach (var d in batch.Deletes.Attachments) Count(await DeleteAsync(connection, transaction, "MailAttachment", "AttachmentID", d, ct));
            foreach (var d in batch.Deletes.Bodies) Count(await DeleteAsync(connection, transaction, "MailMessageBody", "MessageID", d, ct));
            foreach (var d in batch.Deletes.Messages) Count(await DeleteAsync(connection, transaction, "MailMessage", "MessageID", d, ct));
            foreach (var d in batch.Deletes.Folders) Count(await DeleteAsync(connection, transaction, "MailFolder", "FolderID", d, ct));
            foreach (var d in batch.Deletes.Users) Count(await DeleteAsync(connection, transaction, "MailUser", "UserID", d, ct));

            foreach (var u in batch.Users) Count(await UpsertUserAsync(connection, transaction, u, ct));
            foreach (var f in batch.Folders) Count(await UpsertFolderAsync(connection, transaction, f, ct));
            foreach (var m in batch.Messages) Count(await UpsertMessageAsync(connection, transaction, m, ct));
            foreach (var b in batch.Bodies) Count(await UpsertBodyAsync(connection, transaction, b, ct));
            foreach (var a in batch.Attachments) Count(await UpsertAttachmentAsync(connection, transaction, a, ct));

            var newLast = Math.Max(last, batch.ToSeq);
            await using (var state = Command(connection, """
                UPDATE [mail].[MailApplyState]
                SET [LastAppliedSeq] = @Last, [LastAppliedAt] = SYSDATETIME(), [LastBatchSize] = @Size, [LastError] = NULL, [LastErrorAt] = NULL
                WHERE [StateID] = 1;
                """, transaction))
            {
                state.Parameters.Add("@Last", SqlDbType.BigInt).Value = newLast;
                state.Parameters.Add("@Size", SqlDbType.Int).Value = applied + skipped;
                await state.ExecuteNonQueryAsync(ct);
            }
            await transaction.CommitAsync(ct);
            return new ApplyOutcome(false, newLast, applied, skipped);
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException)
        {
            try { await transaction.RollbackAsync(CancellationToken.None); } catch { /* already gone */ }
            await RecordErrorAsync(error.Message);
            throw;
        }
    }

    // A failed batch is logged on the state row (outside the rolled-back transaction).
    private async Task RecordErrorAsync(string message)
    {
        try
        {
            await using var connection = await OpenAsync(CancellationToken.None);
            await using var command = Command(connection,
                "UPDATE [mail].[MailApplyState] SET [LastError] = @Message, [LastErrorAt] = SYSDATETIME() WHERE [StateID] = 1");
            command.Parameters.Add("@Message", SqlDbType.NVarChar, 1000).Value = message.Length > 1000 ? message[..1000] : message;
            await command.ExecuteNonQueryAsync(CancellationToken.None);
        }
        catch (SqlException) { /* best effort */ }
    }

    // table / key come from the fixed calls above, never from the batch.
    private static async Task<bool> DeleteAsync(SqlConnection c, SqlTransaction t, string table, string key, KeySeq d, CancellationToken ct)
    {
        await using var command = Command(c, $"DELETE FROM [mail].[{table}] WHERE [{key}] = @ID AND [PublishSeq] <= @Seq", t);
        command.Parameters.Add("@ID", SqlDbType.BigInt).Value = d.Id;
        command.Parameters.Add("@Seq", SqlDbType.BigInt).Value = d.Seq;
        return await command.ExecuteNonQueryAsync(ct) > 0;
    }

    // UPDATE when not newer; INSERT when absent; nothing when a newer version is there.
    private const string Upsert = """
        UPDATE {0} WHERE {1} AND [PublishSeq] <= @Seq;
        IF @@ROWCOUNT > 0 SELECT 1;
        ELSE IF NOT EXISTS (SELECT 1 FROM {2} WHERE {1}) BEGIN {3}; SELECT 1; END
        ELSE SELECT 0;
        """;

    private static async Task<bool> UpsertUserAsync(SqlConnection c, SqlTransaction t, UserRow u, CancellationToken ct)
    {
        await using var command = Command(c, string.Format(Upsert,
            """
            [mail].[MailUser] SET [SmtpAddress] = @Smtp, [DisplayName] = @Name, [IsEnabled] = @Enabled, [SyncStatus] = @Status,
                [LastSyncAt] = @LastSync, [LastNotificationAt] = @LastNote, [ExchangeItemCount] = @Items,
                [ExchangeUnreadCount] = @Unread, [PublishSeq] = @Seq, [PublishedAt] = SYSDATETIME()
            """,
            "[UserID] = @ID", "[mail].[MailUser]",
            """
            INSERT INTO [mail].[MailUser] ([UserID], [SmtpAddress], [DisplayName], [IsEnabled], [SyncStatus], [LastSyncAt],
                [LastNotificationAt], [ExchangeItemCount], [ExchangeUnreadCount], [PublishSeq])
            VALUES (@ID, @Smtp, @Name, @Enabled, @Status, @LastSync, @LastNote, @Items, @Unread, @Seq)
            """), t);
        var p = command.Parameters;
        p.Add("@ID", SqlDbType.Int).Value = u.UserId;
        p.Add("@Smtp", SqlDbType.NVarChar, 320).Value = u.SmtpAddress;
        p.Add("@Name", SqlDbType.NVarChar, 256).Value = (object?)u.DisplayName ?? DBNull.Value;
        p.Add("@Enabled", SqlDbType.Bit).Value = u.IsEnabled;
        p.Add("@Status", SqlDbType.VarChar, 10).Value = u.SyncStatus;
        p.Add("@LastSync", SqlDbType.DateTime2).Value = (object?)u.LastSyncAt ?? DBNull.Value;
        p.Add("@LastNote", SqlDbType.DateTime2).Value = (object?)u.LastNotificationAt ?? DBNull.Value;
        p.Add("@Items", SqlDbType.Int).Value = (object?)u.ExchangeItemCount ?? DBNull.Value;
        p.Add("@Unread", SqlDbType.Int).Value = (object?)u.ExchangeUnreadCount ?? DBNull.Value;
        p.Add("@Seq", SqlDbType.BigInt).Value = u.Seq;
        return Equals(await command.ExecuteScalarAsync(ct), 1);
    }

    private static async Task<bool> UpsertFolderAsync(SqlConnection c, SqlTransaction t, FolderRow f, CancellationToken ct)
    {
        await using var command = Command(c, string.Format(Upsert,
            """
            [mail].[MailFolder] SET [UserID] = @User, [ParentFolderID] = @Parent, [ExchangeFolderId] = @ExId, [DisplayName] = @Name,
                [FolderType] = @Type, [TotalCount] = @Total, [UnreadCount] = @Unread, [LastSyncAt] = @LastSync,
                [PublishSeq] = @Seq, [PublishedAt] = SYSDATETIME()
            """,
            "[FolderID] = @ID", "[mail].[MailFolder]",
            """
            INSERT INTO [mail].[MailFolder] ([FolderID], [UserID], [ParentFolderID], [ExchangeFolderId], [DisplayName], [FolderType],
                [TotalCount], [UnreadCount], [LastSyncAt], [PublishSeq])
            VALUES (@ID, @User, @Parent, @ExId, @Name, @Type, @Total, @Unread, @LastSync, @Seq)
            """), t);
        var p = command.Parameters;
        p.Add("@ID", SqlDbType.BigInt).Value = f.FolderId;
        p.Add("@User", SqlDbType.Int).Value = f.UserId;
        p.Add("@Parent", SqlDbType.BigInt).Value = (object?)f.ParentFolderId ?? DBNull.Value;
        p.Add("@ExId", SqlDbType.VarChar, 512).Value = f.ExchangeFolderId;
        p.Add("@Name", SqlDbType.NVarChar, 255).Value = f.DisplayName;
        p.Add("@Type", SqlDbType.VarChar, 20).Value = f.FolderType;
        p.Add("@Total", SqlDbType.Int).Value = f.TotalCount;
        p.Add("@Unread", SqlDbType.Int).Value = f.UnreadCount;
        p.Add("@LastSync", SqlDbType.DateTime2).Value = (object?)f.LastSyncAt ?? DBNull.Value;
        p.Add("@Seq", SqlDbType.BigInt).Value = f.Seq;
        return Equals(await command.ExecuteScalarAsync(ct), 1);
    }

    private static async Task<bool> UpsertMessageAsync(SqlConnection c, SqlTransaction t, MessageRow m, CancellationToken ct)
    {
        await using var command = Command(c, string.Format(Upsert,
            """
            [mail].[MailMessage] SET [UserID] = @User, [FolderID] = @Folder, [ExchangeItemId] = @ItemId, [ChangeKey] = @ChangeKey,
                [InternetMessageId] = @InternetId, [ConversationId] = @Conversation, [Subject] = @Subject, [FromName] = @FromName,
                [FromAddress] = @FromAddress, [SentAt] = @SentAt, [ReceivedAt] = @ReceivedAt, [IsRead] = @IsRead,
                [FlagStatus] = @Flag, [Importance] = @Importance, [HasAttachments] = @HasAttachments, [IsDraft] = @IsDraft,
                [Preview] = @Preview, [PublishSeq] = @Seq, [PublishedAt] = SYSDATETIME()
            """,
            "[MessageID] = @ID", "[mail].[MailMessage]",
            """
            INSERT INTO [mail].[MailMessage] ([MessageID], [UserID], [FolderID], [ExchangeItemId], [ChangeKey], [InternetMessageId],
                [ConversationId], [Subject], [FromName], [FromAddress], [SentAt], [ReceivedAt], [IsRead], [FlagStatus], [Importance],
                [HasAttachments], [IsDraft], [Preview], [PublishSeq])
            VALUES (@ID, @User, @Folder, @ItemId, @ChangeKey, @InternetId, @Conversation, @Subject, @FromName, @FromAddress, @SentAt,
                @ReceivedAt, @IsRead, @Flag, @Importance, @HasAttachments, @IsDraft, @Preview, @Seq)
            """), t);
        var p = command.Parameters;
        p.Add("@ID", SqlDbType.BigInt).Value = m.MessageId;
        p.Add("@User", SqlDbType.Int).Value = m.UserId;
        p.Add("@Folder", SqlDbType.BigInt).Value = m.FolderId;
        p.Add("@ItemId", SqlDbType.VarChar, 512).Value = m.ExchangeItemId;
        p.Add("@ChangeKey", SqlDbType.VarChar, 128).Value = m.ChangeKey;
        p.Add("@InternetId", SqlDbType.NVarChar, 500).Value = (object?)m.InternetMessageId ?? DBNull.Value;
        p.Add("@Conversation", SqlDbType.VarChar, 512).Value = (object?)m.ConversationId ?? DBNull.Value;
        p.Add("@Subject", SqlDbType.NVarChar, 1000).Value = (object?)m.Subject ?? DBNull.Value;
        p.Add("@FromName", SqlDbType.NVarChar, 320).Value = (object?)m.FromName ?? DBNull.Value;
        p.Add("@FromAddress", SqlDbType.NVarChar, 320).Value = (object?)m.FromAddress ?? DBNull.Value;
        p.Add("@SentAt", SqlDbType.DateTime2).Value = (object?)m.SentAt ?? DBNull.Value;
        p.Add("@ReceivedAt", SqlDbType.DateTime2).Value = m.ReceivedAt;
        p.Add("@IsRead", SqlDbType.Bit).Value = m.IsRead;
        p.Add("@Flag", SqlDbType.TinyInt).Value = m.FlagStatus;
        p.Add("@Importance", SqlDbType.TinyInt).Value = m.Importance;
        p.Add("@HasAttachments", SqlDbType.Bit).Value = m.HasAttachments;
        p.Add("@IsDraft", SqlDbType.Bit).Value = m.IsDraft;
        p.Add("@Preview", SqlDbType.NVarChar, 400).Value = (object?)m.Preview ?? DBNull.Value;
        p.Add("@Seq", SqlDbType.BigInt).Value = m.Seq;
        if (!Equals(await command.ExecuteScalarAsync(ct), 1)) return false;

        // Written: its recipients are replaced with the ones sent.
        await using (var clear = Command(c, "DELETE FROM [mail].[MailRecipient] WHERE [MessageID] = @ID", t))
        {
            clear.Parameters.Add("@ID", SqlDbType.BigInt).Value = m.MessageId;
            await clear.ExecuteNonQueryAsync(ct);
        }
        foreach (var r in m.Recipients)
        {
            await using var add = Command(c, """
                INSERT INTO [mail].[MailRecipient] ([MessageID], [RecipientType], [Position], [Name], [Address])
                VALUES (@ID, @Type, @Position, @Name, @Address);
                """, t);
            add.Parameters.Add("@ID", SqlDbType.BigInt).Value = m.MessageId;
            add.Parameters.Add("@Type", SqlDbType.TinyInt).Value = r.Type;
            add.Parameters.Add("@Position", SqlDbType.SmallInt).Value = r.Position;
            add.Parameters.Add("@Name", SqlDbType.NVarChar, 320).Value = (object?)r.Name ?? DBNull.Value;
            add.Parameters.Add("@Address", SqlDbType.NVarChar, 320).Value = (object?)r.Address ?? DBNull.Value;
            await add.ExecuteNonQueryAsync(ct);
        }
        return true;
    }

    private static async Task<bool> UpsertBodyAsync(SqlConnection c, SqlTransaction t, BodyRow b, CancellationToken ct)
    {
        await using var command = Command(c, "IF NOT EXISTS (SELECT 1 FROM [mail].[MailMessage] WHERE [MessageID] = @ID) SELECT 0; ELSE BEGIN "
            + string.Format(Upsert,
                "[mail].[MailMessageBody] SET [BodyHtmlGz] = @Html, [BodyText] = @Text, [PublishSeq] = @Seq",
                "[MessageID] = @ID", "[mail].[MailMessageBody]",
                "INSERT INTO [mail].[MailMessageBody] ([MessageID], [BodyHtmlGz], [BodyText], [PublishSeq]) VALUES (@ID, @Html, @Text, @Seq)")
            + " END", t);
        command.Parameters.Add("@ID", SqlDbType.BigInt).Value = b.MessageId;
        command.Parameters.Add("@Html", SqlDbType.VarBinary, -1).Value = (object?)b.HtmlGz ?? DBNull.Value;
        command.Parameters.Add("@Text", SqlDbType.NVarChar, -1).Value = (object?)b.Text ?? DBNull.Value;
        command.Parameters.Add("@Seq", SqlDbType.BigInt).Value = b.Seq;
        return Equals(await command.ExecuteScalarAsync(ct), 1);
    }

    // StoredName / StoredAt are this site's own (the file once fetched here): never overwritten.
    private static async Task<bool> UpsertAttachmentAsync(SqlConnection c, SqlTransaction t, AttachmentRow a, CancellationToken ct)
    {
        await using var command = Command(c, "IF NOT EXISTS (SELECT 1 FROM [mail].[MailMessage] WHERE [MessageID] = @Message) SELECT 0; ELSE BEGIN "
            + string.Format(Upsert,
                """
                [mail].[MailAttachment] SET [MessageID] = @Message, [ExchangeAttachmentId] = @ExId, [Name] = @Name, [ContentType] = @Type,
                    [Size] = @Size, [IsInline] = @Inline, [ContentId] = @Cid, [PublishSeq] = @Seq
                """,
                "[AttachmentID] = @ID", "[mail].[MailAttachment]",
                """
                INSERT INTO [mail].[MailAttachment] ([AttachmentID], [MessageID], [ExchangeAttachmentId], [Name], [ContentType], [Size],
                    [IsInline], [ContentId], [PublishSeq])
                VALUES (@ID, @Message, @ExId, @Name, @Type, @Size, @Inline, @Cid, @Seq)
                """)
            + " END", t);
        var p = command.Parameters;
        p.Add("@ID", SqlDbType.BigInt).Value = a.AttachmentId;
        p.Add("@Message", SqlDbType.BigInt).Value = a.MessageId;
        p.Add("@ExId", SqlDbType.VarChar, 512).Value = a.ExchangeAttachmentId;
        p.Add("@Name", SqlDbType.NVarChar, 255).Value = a.Name;
        p.Add("@Type", SqlDbType.VarChar, 255).Value = (object?)a.ContentType ?? DBNull.Value;
        p.Add("@Size", SqlDbType.BigInt).Value = (object?)a.Size ?? DBNull.Value;
        p.Add("@Inline", SqlDbType.Bit).Value = a.IsInline;
        p.Add("@Cid", SqlDbType.NVarChar, 255).Value = (object?)a.ContentId ?? DBNull.Value;
        p.Add("@Seq", SqlDbType.BigInt).Value = a.Seq;
        return Equals(await command.ExecuteScalarAsync(ct), 1);
    }
}
