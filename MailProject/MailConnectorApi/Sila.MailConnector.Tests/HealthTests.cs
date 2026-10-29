using Sila.MailConnector.Monitor;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class HealthTests
{
    [Fact]
    public void A_success_keeps_the_last_error_and_merges_figures()
    {
        var health = new ConnectorHealth();
        health.Failed(ConnectorHealth.Publisher, "HttpRequestException: 404", ("failuresInRow", 1));
        health.Ok(ConnectorHealth.Publisher, ("failuresInRow", 0), ("lastBatchChanges", 500));
        var state = health.Snapshot()[ConnectorHealth.Publisher];
        Assert.Equal("HttpRequestException: 404", state.LastError);   // still shown, with its time
        Assert.True(state.LastOkAt >= state.LastErrorAt);              // ... but it worked since
        Assert.Equal(0, state.Metrics["failuresInRow"]);
        Assert.Equal(500, state.Metrics["lastBatchChanges"]);
    }

    [Fact]
    public void A_long_error_is_cut_to_fit_the_table()
    {
        var health = new ConnectorHealth();
        health.Failed(ConnectorHealth.Connector, new string('x', 1500));
        Assert.Equal(1000, health.Snapshot()[ConnectorHealth.Connector].LastError!.Length);
    }

    [Fact]
    public void Sync_counts_follow_starts_and_ends()
    {
        var health = new ConnectorHealth();
        health.SyncStarted(); health.SyncStarted();
        health.SyncEnded(true);
        Assert.Equal((1, 1, 0), health.SyncCounts);
        health.SyncEnded(false);
        Assert.Equal((0, 1, 1), health.SyncCounts);
    }
}
