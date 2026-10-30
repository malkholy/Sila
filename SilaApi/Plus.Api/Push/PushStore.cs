using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;

namespace Plus.Api.Push;

// One message to push: an unread row of one of the queues (Src: O one-to-one,
// G group, C ticket, M mail, K task, N general notification) for one user,
// with the title / body / ids of the mobile app's payload and the user's
// device tokens. ChatType is the app's: 1..6 in the same order.
public sealed record PushItem(string Src, int Id, int UserId, int ChatType, string Title, string Body,
    int SessionId, int GroupId, int ChannelId, int TicketId, int MailId, int TaskId, bool Muted, IReadOnlyList<string> Tokens);

// What one claimed message came to (dbo.SilaPushLog, shown in the user form):
// Result Sent / Failed (retried) / TokenGone / NoDevice / Muted; Devices = tokens
// tried, Delivered = how many Firebase accepted.
public sealed record PushLogEntry(string Src, int Id, int UserId, int ChatType, string Title, string Body,
    int Devices, int Delivered, string Result);

public interface IPushStore
{
    // Claims up to top unsent messages (counts an attempt; see dbo.SilaPushOperation).
    Task<IReadOnlyList<PushItem>> ClaimAsync(int top, int maxAgeMinutes, int holdSeconds, CancellationToken cancellationToken);
    Task MarkSentAsync(IReadOnlyCollection<(string Src, int Id)> sent, CancellationToken cancellationToken);
    Task RemoveTokensAsync(IReadOnlyCollection<string> tokens, CancellationToken cancellationToken);
    Task LogAsync(IReadOnlyCollection<PushLogEntry> entries, CancellationToken cancellationToken);
}

// dbo.SilaPushOperation (SQLScript/SilaPushOperation.sql) on Push:Database,
// with SilaApi's own connection string -- never through /api/v2/exec.
public sealed class SqlPushStore(IConfiguration config, IOptionsMonitor<GatewayOptions> gateway, IOptionsMonitor<PushOptions> options)
    : IPushStore
{
    private async Task<SqlConnection> Open(CancellationToken cancellationToken)
    {
        var key = options.CurrentValue.Database;
        if (!gateway.CurrentValue.Databases.TryGetValue(key, out var db) || !db.Enabled)
            throw new InvalidOperationException($"Push database '{key}' is not configured.");
        var configured = config.GetConnectionString(db.ConnectionStringName);
        if (string.IsNullOrWhiteSpace(configured)) throw new InvalidOperationException("Push database has no connection string.");
        var builder = new SqlConnectionStringBuilder(configured)
        {
            Encrypt = SqlConnectionEncryptOption.Mandatory, PersistSecurityInfo = false, ConnectRetryCount = 0, ConnectTimeout = 10
        };
        var connection = new SqlConnection(builder.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private async Task<SqlDataReader> Run(SqlConnection connection, string operation, object line, CancellationToken cancellationToken)
    {
        var command = new SqlCommand("dbo.SilaPushOperation", connection) { CommandType = CommandType.StoredProcedure, CommandTimeout = 30 };
        command.Parameters.Add("@Operation", SqlDbType.NVarChar, 50).Value = operation;
        command.Parameters.Add("@LineData", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(line);
        command.Parameters.Add("@State", SqlDbType.Int).Direction = ParameterDirection.Output;
        command.Parameters.Add("@Message", SqlDbType.NVarChar, 500).Direction = ParameterDirection.Output;
        return await command.ExecuteReaderAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<PushItem>> ClaimAsync(int top, int maxAgeMinutes, int holdSeconds, CancellationToken cancellationToken)
    {
        await using var connection = await Open(cancellationToken);
        await using var reader = await Run(connection, "Claim",
            new { Top = top, MaxAgeMinutes = maxAgeMinutes, HoldSeconds = holdSeconds }, cancellationToken);
        var items = new List<PushItem>();
        int I(string name) => reader[name] is DBNull ? 0 : Convert.ToInt32(reader[name]);
        string S(string name) => reader[name] as string ?? "";
        while (await reader.ReadAsync(cancellationToken))
            items.Add(new(S("Src").Trim(), I("ID"), I("UserID"), I("ChatType"), S("Title"), S("Body"),
                I("SessionID"), I("GroupID"), I("ChannelID"), I("TicketID"), I("MailID"), I("TaskID"), I("Muted") == 1,
                S("Tokens").Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)));
        return items;
    }

    public async Task MarkSentAsync(IReadOnlyCollection<(string Src, int Id)> sent, CancellationToken cancellationToken)
    {
        if (sent.Count == 0) return;
        await using var connection = await Open(cancellationToken);
        await using var reader = await Run(connection, "Mark", new { Sent = sent.Select(s => new { s.Src, ID = s.Id }) }, cancellationToken);
    }

    public async Task RemoveTokensAsync(IReadOnlyCollection<string> tokens, CancellationToken cancellationToken)
    {
        if (tokens.Count == 0) return;
        await using var connection = await Open(cancellationToken);
        await using var reader = await Run(connection, "Remove tokens", new { Tokens = tokens }, cancellationToken);
    }

    public async Task LogAsync(IReadOnlyCollection<PushLogEntry> entries, CancellationToken cancellationToken)
    {
        if (entries.Count == 0) return;
        await using var connection = await Open(cancellationToken);
        await using var reader = await Run(connection, "Log", new
        {
            Items = entries.Select(e => new
            {
                e.Src, ID = e.Id, UserID = e.UserId, e.ChatType, e.Title, e.Body, e.Devices, e.Delivered, e.Result,
            }),
        }, cancellationToken);
    }
}
