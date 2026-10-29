using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Sila.MailConnector.Data;
using Sila.MailConnector.Publish;
using Sila.MailConnector.Sync;

namespace Sila.MailConnector.Monitor;

// What each worker of this service last did (MailPlan 6.1 "Workers"), kept in
// memory: when it last worked, its last error, a few figures. HeartbeatWriter
// saves it to MailServiceHeartbeat every 15 s, so the Mail Monitor's Connector
// tab sees whether the service is alive (a heartbeat older than a minute or two
// means it stopped) and what is failing. Components are the table's names:
//   Connector     the service itself, and its Mail Monitor push
//   ExchangeSync  the sync worker and the safety-sync timer
//   Publisher     InternalMail -> the external Mail database
public sealed class ConnectorHealth
{
    public const string Connector = "Connector", ExchangeSync = "ExchangeSync", Publisher = "Publisher";

    public sealed record State(DateTime? LastOkAt, string? LastError, DateTime? LastErrorAt, IReadOnlyDictionary<string, object?> Metrics);

    private static readonly State Empty = new(null, null, null, new Dictionary<string, object?>());
    private readonly ConcurrentDictionary<string, State> states = new();

    public DateTime StartedAt { get; } = DateTime.Now;

    // The component worked; the figures given replace those of the same name.
    public void Ok(string component, params (string Key, object? Value)[] metrics) =>
        states.AddOrUpdate(component, _ => With(Empty, metrics) with { LastOkAt = DateTime.Now },
            (_, s) => With(s, metrics) with { LastOkAt = DateTime.Now });

    // The component failed (the message is cut to fit the table).
    public void Failed(string component, string error, params (string Key, object? Value)[] metrics)
    {
        var text = error.Length > 1000 ? error[..1000] : error;
        states.AddOrUpdate(component, _ => With(Empty, metrics) with { LastError = text, LastErrorAt = DateTime.Now },
            (_, s) => With(s, metrics) with { LastError = text, LastErrorAt = DateTime.Now });
    }

    // Figures only (no success or failure), e.g. a worker that is switched off.
    public void Set(string component, params (string Key, object? Value)[] metrics) =>
        states.AddOrUpdate(component, _ => With(Empty, metrics), (_, s) => With(s, metrics));

    public IReadOnlyDictionary<string, State> Snapshot() => new Dictionary<string, State>(states);

    private static State With(State state, (string Key, object? Value)[] metrics)
    {
        if (metrics.Length == 0) return state;
        var copy = new Dictionary<string, object?>(state.Metrics);
        foreach (var (key, value) in metrics) copy[key] = value;
        return state with { Metrics = copy };
    }

    // Counts kept by the sync worker between beats.
    private int running, done, failed;
    public void SyncStarted() => Interlocked.Increment(ref running);
    public void SyncEnded(bool succeeded)
    {
        Interlocked.Decrement(ref running);
        if (succeeded) Interlocked.Increment(ref done);
        else Interlocked.Increment(ref failed);
    }
    public (int Running, int Done, int Failed) SyncCounts => (Volatile.Read(ref running), Volatile.Read(ref done), Volatile.Read(ref failed));
}

// Writes ConnectorHealth to MailServiceHeartbeat every 15 s, one row per
// component for this server (Instance = the machine name). The Mail Monitor
// reads the rows (Shared/MonitorQueries.cs) inside, and gets them with each
// push outside. A failed write is logged and tried again next time.
public sealed class HeartbeatWriter(ConnectorHealth health, MailStore store, SyncQueue queue,
    IOptionsMonitor<ExchangeOptions> exchange, IOptionsMonitor<PublishOptions> publish, IOptionsMonitor<MonitorOptions> monitor,
    ILogger<HeartbeatWriter> log) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(15);
    private static readonly DateTime Built = File.GetLastWriteTime(typeof(HeartbeatWriter).Assembly.Location);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var warned = false;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // lastOkAt travels in Metrics (the table has no column for it): the screen tells an old error from a current one.
                foreach (var (component, state) in Beat()) await store.BeatAsync(component, Environment.MachineName, health.StartedAt,
                    JsonSerializer.Serialize(new Dictionary<string, object?>(state.Metrics) { ["lastOkAt"] = state.LastOkAt }),
                    state.LastError, state.LastErrorAt, stoppingToken);
                warned = false;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                // Once per outage, not every 15 s.
                if (!warned) log.LogWarning("Heartbeat not saved ({ErrorType}: {Message})", error.GetType().Name, error.Message);
                warned = true;
            }
            try { await Task.Delay(Interval, stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    // The figures read at beat time, on top of what the workers reported.
    private IEnumerable<(string, ConnectorHealth.State)> Beat()
    {
        using var process = Process.GetCurrentProcess();
        health.Set(ConnectorHealth.Connector,
            ("built", Built), ("exchangeConfigured", exchange.CurrentValue.Configured),
            ("pushEnabled", monitor.CurrentValue.Configured), ("memoryMb", process.WorkingSet64 / (1024 * 1024)));
        var (running, done, failed) = health.SyncCounts;
        health.Set(ConnectorHealth.ExchangeSync,
            ("running", running), ("queuedInitial", queue.Waiting(SyncLane.Initial)), ("queuedChanges", queue.Waiting(SyncLane.Changes)),
            ("done", done), ("failed", failed));
        health.Set(ConnectorHealth.Publisher, ("enabled", publish.CurrentValue.Configured));
        return health.Snapshot().Select(x => (x.Key, x.Value));
    }
}
