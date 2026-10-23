using System.Data;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;

namespace Plus.Api.Live;

// One changed row of dbo.SilaHistory: a conversation of one user moved (new
// message, edit, delete, read on another device). Ids only, never content.
public sealed record LiveChange(string Username, long Seq, int SilaId, string RecordType,
    int SessionId, int GroupId, int TicketId, int MailId, int TaskId);

public interface ILiveChangeSource
{
    // Current high-water mark of SilaHistory.SynSequence (where watching starts).
    Task<long> CurrentAsync(string database, CancellationToken cancellationToken);
    // Rows with SynSequence > from, oldest first, at most max.
    Task<IReadOnlyList<LiveChange>> ReadAsync(string database, long from, int max, CancellationToken cancellationToken);
}

// Fixed queries, nothing from a client: SynSequence comes from one global
// sequence (dbo.SynSeq), bumped by TrgSilaHistoryafterUpdate whenever
// LastMaintDate or UnreadMessage changes -- the same signal 'Left side' deltas use.
public sealed class SqlLiveChangeSource(IConfiguration config, IOptionsMonitor<GatewayOptions> options) : ILiveChangeSource
{
    private async Task<SqlConnection> Open(string database, CancellationToken cancellationToken)
    {
        if (!options.CurrentValue.Databases.TryGetValue(database, out var db) || !db.Enabled)
            throw new GatewayException(403, "Database access denied.");
        var configured = config.GetConnectionString(db.ConnectionStringName);
        if (string.IsNullOrWhiteSpace(configured)) throw new GatewayException(503, "Database is not configured.");
        var connectionString = new SqlConnectionStringBuilder(configured)
        {
            // Preserve the server-configured TrustServerCertificate setting.
            Encrypt = SqlConnectionEncryptOption.Mandatory,
            PersistSecurityInfo = false, ConnectRetryCount = 0, ConnectTimeout = 10
        };
        var connection = new SqlConnection(connectionString.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    public async Task<long> CurrentAsync(string database, CancellationToken cancellationToken)
    {
        await using var connection = await Open(database, cancellationToken);
        await using var command = new SqlCommand("SELECT ISNULL(MAX(CAST(SynSequence AS bigint)), 0) FROM dbo.SilaHistory;", connection)
        { CommandTimeout = 15 };
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
    }

    public async Task<IReadOnlyList<LiveChange>> ReadAsync(string database, long from, int max, CancellationToken cancellationToken)
    {
        await using var connection = await Open(database, cancellationToken);
        const string sql = """
            SELECT TOP (@Max) u.Username, CAST(h.SynSequence AS bigint), h.SilaID, ISNULL(h.RecordType, ''),
                   ISNULL(h.SessionID, 0), ISNULL(h.GroupID, 0), ISNULL(h.TicketID, 0), ISNULL(h.MailID, 0), ISNULL(h.TaskID, 0)
            FROM dbo.SilaHistory AS h
            JOIN dbo.UserMaster AS u ON u.UserID = h.UserID
            WHERE h.SynSequence > @From
            ORDER BY h.SynSequence;
            """;
        await using var command = new SqlCommand(sql, connection) { CommandTimeout = 15 };
        command.Parameters.Add("@Max", SqlDbType.Int).Value = max;
        command.Parameters.Add("@From", SqlDbType.BigInt).Value = from;
        var rows = new List<LiveChange>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            rows.Add(new(reader.GetString(0), reader.GetInt64(1), Convert.ToInt32(reader.GetValue(2)), reader.GetString(3).Trim(),
                Convert.ToInt32(reader.GetValue(4)), Convert.ToInt32(reader.GetValue(5)), Convert.ToInt32(reader.GetValue(6)),
                Convert.ToInt32(reader.GetValue(7)), Convert.ToInt32(reader.GetValue(8))));
        return rows;
    }
}

// The change pump: while a database has open sockets, read SilaHistory rows
// whose SynSequence moved and tell each owner's sockets
//   {type:"changed", seq, items:[{kind, id, silaId, seq}]}
// kind: chat (id = SessionID) | group (GroupID) | ticket (TicketID) | mail | task | other.
// The client then fetches through /api/v2/exec as before ('Left side' with
// MaxSeq, a conversation's messages with AfterChatID).
//
// A sequence value can commit after a higher one was already read, so each
// read starts Overlap values back and skips the values already sent.
public sealed class LiveChangePump(LiveHub hub, ILiveChangeSource source, IOptionsMonitor<LiveOptions> options,
    ILogger<LiveChangePump> logger) : BackgroundService
{
    private const int MaxRows = 2000;
    // Poke() wakes the loop early (a write just went through /api/v2/exec), so a
    // new message reaches the other side right away instead of on the next
    // poll; never more often than MinGap. The poll stays as the safety net
    // (writes from elsewhere, e.g. the old gateway).
    private static readonly TimeSpan MinGap = TimeSpan.FromMilliseconds(300);
    private readonly SemaphoreSlim wake = new(0, 1);
    private readonly Dictionary<string, Watch> watches = new(StringComparer.Ordinal);

    public void Poke()
    {
        if (wake.CurrentCount == 0) try { wake.Release(); } catch (SemaphoreFullException) { /* already signalled */ }
    }

    private sealed class Watch
    {
        public long Mark;                         // highest SynSequence seen
        public readonly HashSet<long> Sent = [];  // values sent within the overlap window
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var current = options.CurrentValue;
            var delay = TimeSpan.FromSeconds(Math.Max(1, current.ChangePollSeconds));
            if (current.Enabled && current.ChangePollSeconds > 0)
            {
                try
                {
                    await Tick(current.ChangeOverlap, stoppingToken);
                    failures = 0;
                }
                catch (Exception error) when (error is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                {
                    // Exception text can contain SQL or values; log only the type. Back off up to a minute.
                    failures++;
                    logger.LogWarning("Live change read failed {ErrorType}", error.GetType().Name);
                    delay = TimeSpan.FromSeconds(Math.Min(60, delay.TotalSeconds * Math.Pow(2, Math.Min(failures, 5))));
                }
            }
            try
            {
                if (failures == 0) await Task.Delay(MinGap, stoppingToken);
                // the rest of the poll interval, or until a write pokes us
                await wake.WaitAsync(failures == 0 ? delay - MinGap : delay, stoppingToken);
            }
            catch (OperationCanceledException) { return; }
        }
    }

    // One pass over every database that has open sockets. Public for tests.
    public async Task Tick(int overlap, CancellationToken cancellationToken)
    {
        var databases = hub.Databases();
        // Nobody listening: forget the mark, start fresh when someone connects
        // (a reconnecting client catches up with its own MaxSeq delta).
        foreach (var gone in watches.Keys.Except(databases).ToArray()) watches.Remove(gone);
        foreach (var database in databases)
        {
            if (!watches.TryGetValue(database, out var watch))
            {
                // Start at the current mark; what is already inside the overlap
                // window counts as sent, so history is not replayed.
                var start = new Watch { Mark = await source.CurrentAsync(database, cancellationToken) };
                foreach (var old in await source.ReadAsync(database, Math.Max(0, start.Mark - overlap), MaxRows, cancellationToken))
                    if (old.Seq <= start.Mark) start.Sent.Add(old.Seq);
                watches[database] = start;
                continue;
            }
            var from = Math.Max(0, watch.Mark - overlap);
            var rows = await source.ReadAsync(database, from, MaxRows, cancellationToken);
            var fresh = rows.Where(r => watch.Sent.Add(r.Seq)).ToList();
            if (rows.Count > 0) watch.Mark = Math.Max(watch.Mark, rows[^1].Seq);
            watch.Sent.RemoveWhere(seq => seq <= watch.Mark - overlap);
            if (fresh.Count == 0) continue;
            var online = new HashSet<string>(hub.Online(database), StringComparer.OrdinalIgnoreCase);
            foreach (var user in fresh.Where(r => online.Contains(r.Username))
                .GroupBy(r => r.Username, StringComparer.OrdinalIgnoreCase))
            {
                var items = user.Select(r => new { kind = Kind(r.RecordType), id = Id(r), silaId = r.SilaId, seq = r.Seq }).ToArray();
                await hub.SendToUsers(database, [user.Key], new { type = "changed", seq = items.Max(i => i.seq), items });
            }
        }
    }

    private static string Kind(string recordType) => recordType switch
    {
        "O" => "chat", "G" => "group", "C" => "ticket", "M" => "mail", "K" => "task", _ => "other"
    };

    private static int Id(LiveChange r) => r.RecordType switch
    {
        "O" => r.SessionId, "G" => r.GroupId, "C" => r.TicketId, "M" => r.MailId, "K" => r.TaskId, _ => 0
    };
}
