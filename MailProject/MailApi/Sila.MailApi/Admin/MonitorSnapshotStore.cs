namespace Sila.MailApi.Admin;

// External role: the last Mail Monitor snapshot the Mail Connector API pushed
// out (it cannot be asked: the company opens no inbound port), and what waits
// for its next push -- mailboxes whose details are wanted, "sync now" and
// "add mailbox" requests, and their answers. Memory only: after a restart the
// screen is empty until the next push (at most 15 s).
public sealed class MonitorSnapshotStore
{
    public sealed record SyncAsk(int UserId, string RequestedBy);
    public sealed record AddAsk(string RequestId, int UserId, string Email, string? DisplayName, string Username, string RequestedBy);
    public sealed record AddResult(string RequestId, int UserId, string Email, bool Ok, string Message);
    public sealed record Snapshot(string Overview, string Accounts, string Errors, DateTimeOffset PushedAt);

    private static readonly TimeSpan WantFor = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan KeepDetails = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan KeepResults = TimeSpan.FromHours(1);
    private readonly object gate = new();
    private Snapshot? current;
    private readonly Dictionary<int, (string Json, DateTimeOffset At)> details = [];
    private readonly Dictionary<int, DateTimeOffset> wanted = [];
    private readonly List<SyncAsk> syncs = [];
    private readonly List<AddAsk> adds = [];
    private readonly Dictionary<string, (AddResult Result, DateTimeOffset At)> addResults = [];

    // A push arrived: keep it, and hand back what waits (sync and add requests are handed over once).
    public (int[] WantDetails, SyncAsk[] Syncs, AddAsk[] Adds) Accept(string overview, string accounts, string errors,
        IReadOnlyDictionary<int, string> newDetails, IReadOnlyList<AddResult> results, DateTimeOffset now)
    {
        lock (gate)
        {
            current = new Snapshot(overview, accounts, errors, now);
            foreach (var result in results) addResults[result.RequestId] = (result, now);
            foreach (var old in addResults.Where(r => now - r.Value.At > KeepResults).Select(r => r.Key).ToList()) addResults.Remove(old);
            foreach (var (userId, json) in newDetails)
            {
                details[userId] = (json, now);
                wanted.Remove(userId);
            }
            foreach (var old in details.Where(d => now - d.Value.At > KeepDetails).Select(d => d.Key).ToList()) details.Remove(old);
            foreach (var old in wanted.Where(w => now - w.Value > WantFor).Select(w => w.Key).ToList()) wanted.Remove(old);
            var handedSyncs = syncs.ToArray();
            syncs.Clear();
            var handedAdds = adds.ToArray();
            adds.Clear();
            return (wanted.Keys.Take(10).ToArray(), handedSyncs, handedAdds);
        }
    }

    public Snapshot? Current()
    {
        lock (gate) return current;
    }

    // The mailbox's details if they arrived within maxAge; otherwise asks for them.
    public (string Json, DateTimeOffset At)? Details(int userId, TimeSpan maxAge, DateTimeOffset now)
    {
        lock (gate)
        {
            if (details.TryGetValue(userId, out var d) && now - d.At <= maxAge) return d;
            wanted.TryAdd(userId, now);
            return null;
        }
    }

    public bool QueueSync(int userId, string requestedBy)
    {
        lock (gate)
        {
            if (syncs.Any(s => s.UserId == userId)) return true;
            if (syncs.Count >= 50) return false;
            syncs.Add(new SyncAsk(userId, requestedBy));
            return true;
        }
    }

    public bool QueueAdd(AddAsk ask)
    {
        lock (gate)
        {
            if (adds.Count >= 50) return false;
            adds.Add(ask);
            return true;
        }
    }

    public AddResult? AddResultFor(string requestId)
    {
        lock (gate) return addResults.TryGetValue(requestId, out var r) ? r.Result : null;
    }
}
