using System.Threading.Channels;

namespace Sila.MailConnector.Sync;

public sealed record SyncRequest(int UserID, string Folder, string Reason);

// Sync requests waiting for the Exchange Sync worker. Bounded: when full, a
// request is refused (the safety sync will catch the mailbox up anyway).
public sealed class SyncQueue
{
    private readonly Channel<SyncRequest> channel = Channel.CreateBounded<SyncRequest>(
        new BoundedChannelOptions(100) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    public bool TryEnqueue(SyncRequest request) => channel.Writer.TryWrite(request);

    public IAsyncEnumerable<SyncRequest> ReadAllAsync(CancellationToken ct) => channel.Reader.ReadAllAsync(ct);
}

// The Exchange Sync worker (MailPlan 7.3), first version: runs queued syncs one
// at a time. Streaming notifications and the safety sync timer come next.
public sealed class SyncWorker(SyncQueue queue, IServiceScopeFactory scopes, ILogger<SyncWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var request in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<MailboxSync>()
                    .RunAsync(request.UserID, request.Folder, request.Reason, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                // A database or unexpected error must not stop the worker; the next request runs.
                log.LogError(error, "Sync of user {UserID} stopped", request.UserID);
            }
        }
    }
}
