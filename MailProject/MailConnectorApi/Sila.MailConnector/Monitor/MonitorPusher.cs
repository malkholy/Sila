using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Sila.MailConnector.Data;
using Sila.MailConnector.Sync;

namespace Sila.MailConnector.Monitor;

// Mail Monitor feed (MailPlan 6): SilaApi (7400) is hosted outside the company
// and the company opens no inbound port, so this service calls out. Every
// Monitor:IntervalSeconds it sends a snapshot -- overview, accounts, errors,
// plus the details of mailboxes someone opened in the screen -- to
// SilaApi's /api/v2/mail/monitor/push with Monitor:PushKey. The answer carries
// what waits: mailboxes whose details are wanted (sent 1 s later) and
// "sync now" requests (queued here like any other sync).
public sealed class MonitorPusher(IHttpClientFactory clients, IOptionsMonitor<MonitorOptions> options, MailStore store,
    SyncQueue queue, ILogger<MonitorPusher> log) : BackgroundService
{
    public const string ClientName = "monitor";
    private const int MaxDetailsPerPush = 5;

    public sealed record PushAnswer(int[]? WantDetails, SyncAsk[]? Syncs);
    public sealed record SyncAsk(int UserId, string? RequestedBy);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        int[] wanted = [];
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var settings = options.CurrentValue;
            var wait = TimeSpan.FromSeconds(settings.IntervalSeconds);
            if (!settings.Configured)
            {
                await Delay(TimeSpan.FromMinutes(1), stoppingToken);
                continue;
            }
            try
            {
                var answer = await PushAsync(settings, wanted, stoppingToken);
                failures = 0;
                foreach (var ask in answer.Syncs ?? [])
                {
                    if (ask.UserId <= 0 || await store.GetUserAsync(ask.UserId, stoppingToken) is null) continue;
                    var queued = queue.TryEnqueue(new SyncRequest(ask.UserId, MailboxSync.AllFolders, "Admin"));
                    log.LogInformation("Sync of user {UserID} asked by {SilaUser} from the Mail Monitor: {Queued}",
                        ask.UserId, ask.RequestedBy, queued ? "queued" : "queue full");
                }
                wanted = (answer.WantDetails ?? []).Where(id => id > 0).Distinct().Take(MaxDetailsPerPush).ToArray();
                // Someone is waiting for a mailbox's details: send them straight away.
                if (wanted.Length > 0) wait = TimeSpan.FromSeconds(1);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                // SilaApi or the database unreachable: try again, waiting longer each time (at most a
                // minute, so the screen recovers soon after SilaApi is back or updated).
                failures++;
                wait = TimeSpan.FromSeconds(Math.Min(60, settings.IntervalSeconds * Math.Pow(2, Math.Min(failures, 3))));
                log.LogWarning("Mail Monitor push failed ({ErrorType}: {Message}); next try in {Seconds} s",
                    error.GetType().Name, error.Message, (int)wait.TotalSeconds);
            }
            await Delay(wait, stoppingToken);
        }
    }

    private async Task<PushAnswer> PushAsync(MonitorOptions settings, int[] wanted, CancellationToken ct)
    {
        var details = new Dictionary<string, object>();
        foreach (var userId in wanted)
            if (await store.GetStatusAsync(userId, ct) is { } status) details[userId.ToString()] = status;
        var snapshot = new
        {
            overview = await store.GetOverviewAsync(ct),
            accounts = await store.GetAccountsAsync(ct),
            errors = await store.GetErrorsAsync(ct),
            details,
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, settings.PushUrl) { Content = JsonContent.Create(snapshot) };
        request.Headers.TryAddWithoutValidation("X-Connector-Key", settings.PushKey);
        using var response = await clients.CreateClient(ClientName).SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"SilaApi answered {(int)response.StatusCode}.");
        return await response.Content.ReadFromJsonAsync<PushAnswer>(new JsonSerializerOptions(JsonSerializerDefaults.Web), ct)
               ?? new PushAnswer([], []);
    }

    private static async Task Delay(TimeSpan wait, CancellationToken ct)
    {
        try { await Task.Delay(wait, ct); }
        catch (OperationCanceledException) { /* stopping */ }
    }
}
