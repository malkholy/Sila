using Sila.MailConnector.Sync;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class SchedulerTests
{
    private static readonly DateTime Now = new(2026, 10, 26, 15, 0, 0);

    private static SyncScheduler.Candidate Box(DateTime? lastSync, DateTime? lastAttempt, int failures = 0) =>
        new(4, lastSync, lastAttempt, failures);

    [Fact]
    public void A_copied_mailbox_syncs_its_changes_every_few_minutes()
    {
        Assert.Null(SyncScheduler.Due(Box(Now.AddMinutes(-2), Now.AddMinutes(-2)), Now, 3));   // 2 min ago: not yet
        var due = SyncScheduler.Due(Box(Now.AddMinutes(-4), Now.AddMinutes(-4)), Now, 3);
        Assert.Equal((SyncLane.Changes, "Safety", MailboxSync.AllFolders), (due!.Lane, due.Reason, due.Folder));
    }

    [Fact]
    public void An_unfinished_first_copy_resumes_in_the_initial_lane()
    {
        var due = SyncScheduler.Due(Box(null, null), Now, 3);
        Assert.Equal((SyncLane.Initial, "Resume"), (due!.Lane, due.Reason));
    }

    [Theory]
    [InlineData(1, 5, false)]     // 1 failure: waits 6 min
    [InlineData(1, 7, true)]
    [InlineData(3, 20, false)]    // 3 failures: waits 24 min
    [InlineData(3, 25, true)]
    [InlineData(10, 59, false)]   // many failures: at most an hour
    [InlineData(10, 61, true)]
    public void A_failing_mailbox_waits_longer_each_time(int failures, int minutesAgo, bool due) =>
        Assert.Equal(due, SyncScheduler.Due(Box(Now.AddDays(-1), Now.AddMinutes(-minutesAgo), failures), Now, 3) is not null);

    [Fact]
    public void A_mailbox_is_queued_once_until_its_sync_has_run()
    {
        var queue = new SyncQueue();
        Assert.True(queue.TryEnqueue(new SyncRequest(4, "all", "Safety", SyncLane.Changes)));
        Assert.True(queue.TryEnqueue(new SyncRequest(4, "all", "Admin", SyncLane.Changes)));   // "Sync now" again: the same sync
        Assert.True(queue.IsBusy(4));
        queue.Complete(4);
        Assert.False(queue.IsBusy(4));
    }

    [Fact]
    public async Task Each_lane_has_its_own_queue()
    {
        var queue = new SyncQueue();
        queue.TryEnqueue(new SyncRequest(10, "all", "Added", SyncLane.Initial));
        queue.TryEnqueue(new SyncRequest(4, "all", "Safety", SyncLane.Changes));
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await using var changes = queue.ReadAllAsync(SyncLane.Changes, stop.Token).GetAsyncEnumerator(stop.Token);
        Assert.True(await changes.MoveNextAsync());
        Assert.Equal(4, changes.Current.UserID);   // not behind user 10's first copy
        await using var initial = queue.ReadAllAsync(SyncLane.Initial, stop.Token).GetAsyncEnumerator(stop.Token);
        Assert.True(await initial.MoveNextAsync());
        Assert.Equal(10, initial.Current.UserID);
    }

    [Fact]
    public async Task Several_workers_share_a_lane_and_each_mailbox_goes_to_one()
    {
        var queue = new SyncQueue();
        foreach (var id in new[] { 1, 2, 3, 4 }) queue.TryEnqueue(new SyncRequest(id, "all", "Safety", SyncLane.Changes));
        queue.TryEnqueue(new SyncRequest(2, "all", "Admin", SyncLane.Changes));   // already queued: not again
        using var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        var taken = new System.Collections.Concurrent.ConcurrentBag<int>();
        async Task Worker()
        {
            try { await foreach (var r in queue.ReadAllAsync(SyncLane.Changes, stop.Token)) taken.Add(r.UserID); }
            catch (OperationCanceledException) { /* done */ }
        }
        await Task.WhenAll(Worker(), Worker(), Worker());
        Assert.Equal([1, 2, 3, 4], taken.Order());   // every mailbox once, spread over the workers
    }

    [Fact]
    public void The_lane_follows_the_first_full_sync() =>
        Assert.Equal((SyncLane.Initial, SyncLane.Changes), (SyncRequest.LaneFor(null), SyncRequest.LaneFor(Now)));
}
