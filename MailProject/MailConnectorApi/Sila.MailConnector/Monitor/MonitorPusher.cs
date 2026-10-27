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
// what waits: mailboxes whose details are wanted (sent 1 s later), "sync now"
// requests (queued here like any other sync) and "add mailbox" requests
// (MailboxRegistration; each result goes back with the next push, 1 s later).
public sealed class MonitorPusher(IHttpClientFactory clients, IOptionsMonitor<MonitorOptions> options, MailStore store,
    SyncQueue queue, IServiceScopeFactory scopes, ILogger<MonitorPusher> log) : BackgroundService
{
    public const string ClientName = "monitor";
    private const int MaxDetailsPerPush = 5;

    public sealed record PushAnswer(int[]? WantDetails, SyncAsk[]? Syncs, AddAsk[]? Adds);
    public sealed record SyncAsk(int UserId, string? RequestedBy);
    public sealed record AddAsk(string RequestId, int UserId, string? Email, string? DisplayName, string? Username, string? RequestedBy);
    public sealed record AddResult(string RequestId, int UserId, string Email, bool Ok, string Message);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        int[] wanted = [];
        List<AddResult> results = [];   // "add mailbox" answers waiting for the next push
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
                var answer = await PushAsync(settings, wanted, results, stoppingToken);
                failures = 0;
                results = [];
                foreach (var ask in answer.Adds ?? [])
                {
                    if (string.IsNullOrEmpty(ask.RequestId) || ask.RequestId.Length > 64) continue;
                    using var scope = scopes.CreateScope();
                    var outcome = await scope.ServiceProvider.GetRequiredService<MailboxRegistration>()
                        .AddAsync(ask.UserId, ask.Email, ask.DisplayName, ask.Username, "Added", stoppingToken);
                    log.LogInformation("Add mailbox {Email} for user {UserID}, asked by {SilaUser}: {Result}",
                        ask.Email, ask.UserId, ask.RequestedBy, outcome.Message);
                    results.Add(new AddResult(ask.RequestId, ask.UserId, ask.Email ?? "", outcome.Ok, outcome.Message));
                }
                foreach (var ask in answer.Syncs ?? [])
                {
                    if (ask.UserId <= 0 || await store.GetUserAsync(ask.UserId, stoppingToken) is not { } user) continue;
                    var queued = queue.TryEnqueue(new SyncRequest(ask.UserId, MailboxSync.AllFolders, "Admin",
                        SyncRequest.LaneFor(user.LastSyncAt)));
                    log.LogInformation("Sync of user {UserID} asked by {SilaUser} from the Mail Monitor: {Queued}",
                        ask.UserId, ask.RequestedBy, queued ? "queued" : "queue full");
                }
                wanted = (answer.WantDetails ?? []).Where(id => id > 0).Distinct().Take(MaxDetailsPerPush).ToArray();
                // Someone is waiting for a mailbox's details or an "add mailbox" answer: send it straight away.
                if (wanted.Length > 0 || results.Count > 0) wait = TimeSpan.FromSeconds(1);
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

    private async Task<PushAnswer> PushAsync(MonitorOptions settings, int[] wanted, List<AddResult> results, CancellationToken ct)
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
            addResults = results,
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, settings.PushUrl) { Content = JsonContent.Create(snapshot) };
        request.Headers.TryAddWithoutValidation("X-Connector-Key", settings.PushKey);
        using var response = await clients.CreateClient(ClientName).SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"SilaApi answered {(int)response.StatusCode}.");
        return await response.Content.ReadFromJsonAsync<PushAnswer>(new JsonSerializerOptions(JsonSerializerDefaults.Web), ct)
               ?? new PushAnswer([], [], []);
    }

    private static async Task Delay(TimeSpan wait, CancellationToken ct)
    {
        try { await Task.Delay(wait, ct); }
        catch (OperationCanceledException) { /* stopping */ }
    }
}
