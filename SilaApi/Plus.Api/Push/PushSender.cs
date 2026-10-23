using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;

namespace Plus.Api.Push;

// "Push" configuration section. Off unless Enabled; run it on ONE server role
// (the main API), not the Files API.
public sealed class PushOptions
{
    public bool Enabled { get; set; }
    public string Database { get; set; } = "SILA101";
    // the Firebase service account JSON; relative = under the site's folder
    public string ServiceAccountPath { get; set; } = "App_Data/firebase-service-account.json";
    public int PollSeconds { get; set; } = 3;
    // a message waits this long first: read on the web meanwhile = no push
    public int HoldSeconds { get; set; } = 5;
    // older unsent messages are never pushed (no burst of stale notifications)
    public int MaxAgeMinutes { get; set; } = 30;
    public int BatchSize { get; set; } = 200;
    public int Parallel { get; set; } = 8;
}

// Takes unsent messages from the unread queues (dbo.SilaPushOperation 'Claim'),
// sends each to every device of its user through Firebase, marks the delivered
// ones and removes tokens Firebase reports as gone. A message with no device,
// or for a muted ticket, is marked without a push; one whose every send failed
// for another reason is retried (up to 5 attempts, counted by the claim).
public sealed class PushSender(IPushStore store, IPushTransport transport, IOptionsMonitor<PushOptions> options,
    ILogger<PushSender> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var failures = 0;
        var toldMissing = false;
        while (!stoppingToken.IsCancellationRequested)
        {
            var o = options.CurrentValue;
            var delay = TimeSpan.FromSeconds(Math.Clamp(o.PollSeconds, 1, 60));
            if (o.Enabled && !transport.Ready)
            {
                // enabled but the service account isn't there yet: wait quietly (said once)
                if (!toldMissing) logger.LogWarning("Push is enabled but the Firebase service account file is missing; waiting for it");
                toldMissing = true;
                delay = TimeSpan.FromSeconds(30);
            }
            else if (o.Enabled)
            {
                toldMissing = false;
                try
                {
                    var claimed = await Tick(stoppingToken);
                    failures = 0;
                    if (claimed >= o.BatchSize) continue;   // more waiting: go again now
                }
                catch (Exception error) when (error is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                {
                    failures++;
                    logger.LogWarning("Push run failed {ErrorType}", error.GetType().Name);
                    delay = TimeSpan.FromSeconds(Math.Min(300, delay.TotalSeconds * Math.Pow(2, Math.Min(failures, 6))));
                }
            }
            try { await Task.Delay(delay, stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    // One pass; returns how many messages were claimed. Public for tests.
    public async Task<int> Tick(CancellationToken cancellationToken)
    {
        var o = options.CurrentValue;
        var items = await store.ClaimAsync(Math.Clamp(o.BatchSize, 1, 1000), o.MaxAgeMinutes, o.HoldSeconds, cancellationToken);
        if (items.Count == 0) return 0;
        var sent = new System.Collections.Concurrent.ConcurrentBag<(string, int)>();
        var gone = new System.Collections.Concurrent.ConcurrentBag<string>();
        var counts = new int[3];
        await System.Threading.Tasks.Parallel.ForEachAsync(items,
            new ParallelOptions { MaxDegreeOfParallelism = Math.Clamp(o.Parallel, 1, 32), CancellationToken = cancellationToken },
            async (item, ct) =>
            {
                if (item.Muted || item.Tokens.Count == 0) { sent.Add((item.Src, item.Id)); return; }
                var any = false;
                foreach (var token in item.Tokens)
                {
                    var result = await transport.SendAsync(Message(item, token), ct);
                    Interlocked.Increment(ref counts[(int)result]);
                    if (result == PushResult.Sent) any = true;
                    else if (result == PushResult.TokenGone) gone.Add(token);
                }
                // delivered somewhere, or no device left: done; otherwise retried
                if (any || item.Tokens.All(t => gone.Contains(t))) sent.Add((item.Src, item.Id));
            });
        await store.MarkSentAsync(sent.ToArray(), cancellationToken);
        await store.RemoveTokensAsync(gone.Distinct().ToArray(), cancellationToken);
        logger.LogInformation("Push run {Claimed} claimed {Sent} sent {Gone} tokens gone {Failed} failed",
            items.Count, counts[(int)PushResult.Sent], counts[(int)PushResult.TokenGone], counts[(int)PushResult.Failed]);
        return items.Count;
    }

    // The mobile app's payload (as the old sender sent it): title = FromAccount,
    // body = the text, sound "beep", and the ids it opens the conversation with.
    public static JsonObject Message(PushItem item, string token) => new()
    {
        ["token"] = token,
        ["notification"] = new JsonObject { ["title"] = item.Title, ["body"] = item.Body },
        ["android"] = new JsonObject
        {
            ["priority"] = "HIGH",
            ["notification"] = new JsonObject { ["sound"] = "beep" },
        },
        ["apns"] = new JsonObject
        {
            ["headers"] = new JsonObject { ["apns-priority"] = "10" },
            ["payload"] = new JsonObject
            {
                ["aps"] = new JsonObject { ["sound"] = "beep", ["badge"] = 1, ["content-available"] = 1 },
            },
        },
        // FCM data values must be strings
        ["data"] = new JsonObject
        {
            ["id"] = item.Id.ToString(),
            ["SessionID"] = item.SessionId.ToString(),
            ["GroupID"] = item.GroupId.ToString(),
            ["ChannelID"] = item.ChannelId.ToString(),
            ["TicketID"] = item.TicketId.ToString(),
            ["MailID"] = item.MailId.ToString(),
            ["TaskID"] = item.TaskId.ToString(),
            ["ChatType"] = item.ChatType.ToString(),
            ["click_action"] = "FLUTTER_NOTIFICATION_CLICK",
        },
    };
}
