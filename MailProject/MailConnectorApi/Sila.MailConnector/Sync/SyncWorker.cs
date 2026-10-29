using System.Threading.Channels;
using Microsoft.Extensions.Options;
using Sila.MailConnector.Monitor;

namespace Sila.MailConnector.Sync;

// Initial: a mailbox's first full copy (can take hours). Changes: a mailbox that
// is already copied -- usually seconds. The two lanes run side by side, each
// syncing several mailboxes at once (AutoSync:InitialParallel / ChangesParallel),
// so a big first copy never holds up everyone's updates. One mailbox is never
// synced twice at once: the queue keeps it busy until its sync ends, and the
// mailbox lease (MailJobLease) guards across instances.
public enum SyncLane { Initial, Changes }

public sealed record SyncRequest(int UserID, string Folder, string Reason, SyncLane Lane = SyncLane.Changes)
{
    // A mailbox that has never finished a full sync goes to the Initial lane.
    public static SyncLane LaneFor(DateTime? lastSyncAt) => lastSyncAt is null ? SyncLane.Initial : SyncLane.Changes;
}

// Sync requests waiting for the Exchange Sync worker, one queue per lane.
// A mailbox already queued or running (in either lane) is not queued again --
// "Sync now" pressed twice, or the timer meeting a running sync, is one sync.
// Bounded: when a lane is full, a request is refused (the timer catches up).
public sealed class SyncQueue
{
    private readonly Channel<SyncRequest> initial = Channel.CreateBounded<SyncRequest>(
        new BoundedChannelOptions(500) { FullMode = BoundedChannelFullMode.DropWrite });
    private readonly Channel<SyncRequest> changes = Channel.CreateBounded<SyncRequest>(
        new BoundedChannelOptions(1000) { FullMode = BoundedChannelFullMode.DropWrite });
    private readonly HashSet<int> busy = [];   // queued or running
    private readonly object gate = new();

    // True when the mailbox is now queued, or already was.
    public bool TryEnqueue(SyncRequest request)
    {
        lock (gate)
        {
            if (busy.Contains(request.UserID)) return true;
            var channel = request.Lane == SyncLane.Initial ? initial : changes;
            if (!channel.Writer.TryWrite(request)) return false;
            busy.Add(request.UserID);
            return true;
        }
    }

    public bool IsBusy(int userId)
    {
        lock (gate) return busy.Contains(userId);
    }

    // The worker is done with the mailbox (succeeded or not).
    public void Complete(int userId)
    {
        lock (gate) busy.Remove(userId);
    }

    // How many mailboxes wait in a lane (the Mail Monitor's Connector tab).
    public int Waiting(SyncLane lane) => (lane == SyncLane.Initial ? initial : changes).Reader.Count;

    public IAsyncEnumerable<SyncRequest> ReadAllAsync(SyncLane lane, CancellationToken ct) =>
        (lane == SyncLane.Initial ? initial : changes).Reader.ReadAllAsync(ct);
}

// The Exchange Sync worker (MailPlan 7.3): per lane, as many loops as that
// lane's parallel setting, each taking the next queued mailbox when it is free.
public sealed class SyncWorker(SyncQueue queue, IServiceScopeFactory scopes, IOptions<AutoSyncOptions> options,
    ConnectorHealth health, ILogger<SyncWorker> log) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var settings = options.Value;
        var loops = Enumerable.Range(0, settings.InitialParallel).Select(_ => RunLaneAsync(SyncLane.Initial, stoppingToken))
            .Concat(Enumerable.Range(0, settings.ChangesParallel).Select(_ => RunLaneAsync(SyncLane.Changes, stoppingToken)));
        return Task.WhenAll(loops);
    }

    private async Task RunLaneAsync(SyncLane lane, CancellationToken stoppingToken)
    {
        await foreach (var request in queue.ReadAllAsync(lane, stoppingToken))
        {
            health.SyncStarted();
            var succeeded = false;
            try
            {
                using var scope = scopes.CreateScope();
                var outcome = await scope.ServiceProvider.GetRequiredService<MailboxSync>()
                    .RunAsync(request.UserID, request.Folder, request.Reason, stoppingToken);
                // A mailbox's own failure (sign-in, a folder ...) is on the Errors tab; the worker itself is fine.
                succeeded = outcome.Succeeded;
                health.Ok(ConnectorHealth.ExchangeSync, ("lastMailbox", request.UserID), ("lastLane", request.Lane.ToString()));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                // A database or unexpected error must not stop the worker; the next request runs.
                log.LogError(error, "Sync of user {UserID} stopped", request.UserID);
                health.Failed(ConnectorHealth.ExchangeSync, $"Sync of user {request.UserID} stopped: {error.GetType().Name}: {error.Message}");
            }
            finally
            {
                health.SyncEnded(succeeded);
                queue.Complete(request.UserID);
            }
        }
    }
}
