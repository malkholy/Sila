using Microsoft.Extensions.Options;
using Sila.MailConnector.Data;
using Sila.MailConnector.Monitor;

namespace Sila.MailConnector.Sync;

// AutoSync: the safety sync (MailPlan 2.1, layer 3). Enabled = false stops the
// timer (syncs then run only when asked). CheckSeconds: how often the due
// mailboxes are looked up. How often each mailbox syncs is MailSettings
// SafetySyncMinutes (default 3), so an admin can change it without a restart.
// InitialParallel / ChangesParallel: how many mailboxes each lane syncs at the
// same time (read at start). Every sync is one EWS caller for the service
// account: keep the sum well inside its throttling policy (MailPlan 1.1).
public sealed class AutoSyncOptions
{
    public bool Enabled { get; set; } = true;
    public int CheckSeconds { get; set; } = 60;
    public int InitialParallel { get; set; } = 2;
    public int ChangesParallel { get; set; } = 4;
}

// Every enabled mailbox syncs at least every SafetySyncMinutes: a copied
// mailbox in the Changes lane (only what changed -- seconds), one whose first
// copy never finished in the Initial lane (it resumes from its checkpoints,
// e.g. after a restart). A failing mailbox waits longer each time (x2 per
// failure in a row, at most an hour). Already queued or running = skipped.
public sealed class SyncScheduler(SyncQueue queue, MailStore store, IOptionsMonitor<AutoSyncOptions> options,
    ConnectorHealth health, ILogger<SyncScheduler> log) : BackgroundService
{
    public sealed record Candidate(int UserID, DateTime? LastSyncAt, DateTime? LastSyncAttemptAt, int ConsecutiveFailures);

    public static readonly TimeSpan MaxWait = TimeSpan.FromHours(1);

    // The sync this mailbox is due for now, or null.
    public static SyncRequest? Due(Candidate mailbox, DateTime now, int safetyMinutes)
    {
        var wait = TimeSpan.FromMinutes(Math.Max(1, safetyMinutes) * Math.Pow(2, Math.Min(Math.Max(0, mailbox.ConsecutiveFailures), 6)));
        if (wait > MaxWait) wait = MaxWait;
        var last = mailbox.LastSyncAttemptAt ?? mailbox.LastSyncAt;
        if (last is not null && now - last.Value < wait) return null;
        var lane = SyncRequest.LaneFor(mailbox.LastSyncAt);
        return new SyncRequest(mailbox.UserID, MailboxSync.AllFolders, lane == SyncLane.Initial ? "Resume" : "Safety", lane);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // A short pause after start, so a restart does not hit Exchange at once.
        await Delay(TimeSpan.FromSeconds(20), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            var settings = options.CurrentValue;
            if (settings.Enabled)
            {
                try
                {
                    var minutes = await store.GetSettingAsync("SafetySyncMinutes", 3, stoppingToken);
                    var queued = 0;
                    foreach (var mailbox in await store.GetSyncCandidatesAsync(stoppingToken))
                    {
                        if (queue.IsBusy(mailbox.UserID) || Due(mailbox, DateTime.Now, minutes) is not { } request) continue;
                        if (queue.TryEnqueue(request)) queued++;
                    }
                    if (queued > 0) log.LogInformation("Safety sync: {Count} mailbox(es) queued", queued);
                    health.Set(ConnectorHealth.ExchangeSync, ("timerCheckedAt", DateTime.Now), ("timerEnabled", true));
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception error)
                {
                    log.LogWarning("Safety sync check failed ({ErrorType}: {Message})", error.GetType().Name, error.Message);
                    health.Failed(ConnectorHealth.ExchangeSync, $"Safety sync check failed: {error.GetType().Name}: {error.Message}");
                }
            }
            else health.Set(ConnectorHealth.ExchangeSync, ("timerEnabled", false));
            await Delay(TimeSpan.FromSeconds(Math.Clamp(settings.CheckSeconds, 10, 600)), stoppingToken);
        }
    }

    private static async Task Delay(TimeSpan wait, CancellationToken ct)
    {
        try { await Task.Delay(wait, ct); }
        catch (OperationCanceledException) { /* stopping */ }
    }
}
