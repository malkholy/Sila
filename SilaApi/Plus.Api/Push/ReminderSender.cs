using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using Plus.Api.Live;

namespace Plus.Api.Push;

// A My Day reminder whose time has come (dbo.SilaReminderOperation 'Claim due').
// Late = its time passed more than Push:MaxAgeMinutes ago (the server was down):
// fired without a push. LinkKind / LinkID: the conversation it is about.
public sealed record DueReminder(int Id, int UserId, string Username, string Title, string Note, DateTime DueAt, bool Late,
    bool Push, string LinkKind, int LinkId, int ChatId, IReadOnlyList<string> Tokens);

public interface IReminderStore
{
    Task<IReadOnlyList<DueReminder>> ClaimDueAsync(int top, int maxAgeMinutes, CancellationToken cancellationToken);
}

// dbo.SilaReminderOperation (SQLScript/SilaReminder.sql) on Push:Database with
// SilaApi's own connection string -- never through /api/v2/exec.
public sealed class SqlReminderStore(IConfiguration config, IOptionsMonitor<GatewayOptions> gateway, IOptionsMonitor<PushOptions> options)
    : IReminderStore
{
    public async Task<IReadOnlyList<DueReminder>> ClaimDueAsync(int top, int maxAgeMinutes, CancellationToken cancellationToken)
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
        await using var connection = new SqlConnection(builder.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = new SqlCommand("dbo.SilaReminderOperation", connection) { CommandType = CommandType.StoredProcedure, CommandTimeout = 30 };
        command.Parameters.Add("@Operation", SqlDbType.NVarChar, 50).Value = "Claim due";
        command.Parameters.Add("@LineData", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(new { Top = top, MaxAgeMinutes = maxAgeMinutes });
        command.Parameters.Add("@State", SqlDbType.Int).Direction = ParameterDirection.Output;
        command.Parameters.Add("@Message", SqlDbType.NVarChar, 500).Direction = ParameterDirection.Output;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var items = new List<DueReminder>();
        int I(string name) => reader[name] is DBNull ? 0 : Convert.ToInt32(reader[name]);
        string S(string name) => reader[name] as string ?? "";
        while (await reader.ReadAsync(cancellationToken))
            items.Add(new(I("ReminderID"), I("UserID"), S("Username"), S("Title"), S("Note"),
                reader["DueAt"] is DateTime due ? due : DateTime.Now, I("Late") == 1, I("Push") == 1,
                S("LinkKind").Trim(), I("LinkID"), I("ChatID"),
                S("Tokens").Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)));
        return items;
    }
}

// Fires My Day reminders: polls for the due ones, tells the user's open web
// sessions (live frame {type:"reminder", ...}: the app shows a pop-up) and
// pushes to their phones through Firebase (not for a late one, nor when the
// reminder's Push is off, nor while the service account is missing). Runs with
// the message push sender: on when Push:Enabled.
public sealed class ReminderSender(IReminderStore store, IPushStore tokens, IPushTransport transport, LiveHub hub,
    IOptionsMonitor<PushOptions> options, ILogger<ReminderSender> logger) : BackgroundService
{
    private static readonly TimeSpan Poll = TimeSpan.FromSeconds(20);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var delay = Poll;
            if (options.CurrentValue.Enabled)
            {
                try { await Tick(stoppingToken); failures = 0; }
                catch (Exception error) when (error is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                {
                    failures++;
                    logger.LogWarning("Reminder run failed {ErrorType}", error.GetType().Name);
                    delay = TimeSpan.FromSeconds(Math.Min(300, Poll.TotalSeconds * Math.Pow(2, Math.Min(failures, 4))));
                }
            }
            try { await Task.Delay(delay, stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    // One pass; returns how many reminders fired. Public for tests.
    public async Task<int> Tick(CancellationToken cancellationToken)
    {
        var o = options.CurrentValue;
        var due = await store.ClaimDueAsync(200, Math.Clamp(o.MaxAgeMinutes, 1, 1440), cancellationToken);
        if (due.Count == 0) return 0;
        var gone = new List<string>();
        var pushed = 0;
        foreach (var r in due)
        {
            await hub.SendToUsers(o.Database, [r.Username], LiveFrame(r));
            if (r.Late || !r.Push || !transport.Ready) continue;
            foreach (var token in r.Tokens)
            {
                var result = await transport.SendAsync(Message(r, token), cancellationToken);
                if (result == PushResult.Sent) pushed++;
                else if (result == PushResult.TokenGone) gone.Add(token);
            }
        }
        await tokens.RemoveTokensAsync(gone.Distinct().ToArray(), cancellationToken);
        logger.LogInformation("Reminder run {Due} due {Pushed} pushed {Gone} tokens gone", due.Count, pushed, gone.Count);
        return due.Count;
    }

    public static object LiveFrame(DueReminder r) => new
    {
        type = "reminder", id = r.Id, title = r.Title, note = r.Note, dueAt = r.DueAt.ToString("yyyy-MM-ddTHH:mm:ss"),
        linkKind = r.LinkKind, linkId = r.LinkId, chatId = r.ChatId, late = r.Late,
    };

    // The mobile app's payload, as for messages: a linked reminder opens its
    // conversation (ChatType 1 chat / 2 group / 3 ticket), any other the
    // notifications screen (6).
    public static JsonObject Message(DueReminder r, string token)
    {
        var chatType = r.LinkKind switch { "chat" => 1, "group" => 2, "ticket" => 3, _ => 6 };
        var body = string.IsNullOrWhiteSpace(r.Note) ? r.Title : $"{r.Title}\n{r.Note}";
        return new JsonObject
        {
            ["token"] = token,
            ["notification"] = new JsonObject { ["title"] = $"Reminder · {r.DueAt:HH:mm}", ["body"] = body.Length > 300 ? body[..300] : body },
            ["android"] = new JsonObject { ["priority"] = "HIGH", ["notification"] = new JsonObject { ["sound"] = "beep" } },
            ["apns"] = new JsonObject
            {
                ["headers"] = new JsonObject { ["apns-priority"] = "10" },
                ["payload"] = new JsonObject { ["aps"] = new JsonObject { ["sound"] = "beep", ["badge"] = 1, ["content-available"] = 1 } },
            },
            ["data"] = new JsonObject
            {
                ["id"] = r.Id.ToString(),
                ["ReminderID"] = r.Id.ToString(),
                ["SessionID"] = (r.LinkKind == "chat" ? r.LinkId : 0).ToString(),
                ["GroupID"] = (r.LinkKind == "group" ? r.LinkId : 0).ToString(),
                ["ChannelID"] = "0",
                ["TicketID"] = (r.LinkKind == "ticket" ? r.LinkId : 0).ToString(),
                ["MailID"] = "0",
                ["TaskID"] = "0",
                ["ChatType"] = chatType.ToString(),
                ["click_action"] = "FLUTTER_NOTIFICATION_CLICK",
            },
        };
    }
}
