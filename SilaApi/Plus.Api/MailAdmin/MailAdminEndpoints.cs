using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Plus.Api.MailAdmin;

// The Mail Monitor tab of System Settings (MailPlan 6). The mail statistics live
// in InternalMail, inside the company; this API is hosted outside, and the
// company opens no inbound port. So the Mail Connector API (MailProject) pushes:
//
//   POST /api/v2/mail/monitor/push   (Mail Connector API only: X-Connector-Key)
//     every 15 s, a snapshot -- overview, accounts, errors, and the details of
//     any mailbox someone asked for. The answer hands back what waits for it:
//     mailboxes whose details are wanted, and "sync now" requests.
//   POST /api/v2/mail/admin  { action, userId? }   (the web app)
//     served from the last snapshot, for a signed-in user in MailAdmin:Users
//     calling from MailAdmin:AllowedNetworks (the username from the validated
//     token, GatewayPolicy.ResolveCaller). "account" waits briefly for the
//     mailbox's details to arrive; "sync" is queued for the next push.
//
// The snapshot is kept in memory only (MailMonitorStore): after a restart the
// screen is empty until the next push, at most 15 s later.
public sealed class MailAdminOptions
{
    // Shared with the Mail Connector API (its Monitor:PushKey), at least 32
    // characters. Server configuration only. Empty = the Mail Monitor is off.
    public string ConnectorKey { get; set; } = "";
    // Optional: the addresses the Mail Connector API pushes from (the company's
    // public address). Empty = any address with the key.
    public string[] ConnectorNetworks { get; set; } = [];
    // The database key whose login identifies the caller.
    public string Database { get; set; } = "SILA101";
    // Sila usernames allowed to see the Mail Monitor.
    public string[] Users { get; set; } = [];
    // The company network as this API sees callers (CIDR). Anyone else is
    // refused, signed in or not. Empty = nobody.
    public string[] AllowedNetworks { get; set; } = [];

    public bool Configured => ConnectorKey.Length >= 32;

    public static bool InNetworks(IPAddress? ip, IEnumerable<string> networks)
    {
        if (ip is null) return false;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return networks.Any(n => System.Net.IPNetwork.TryParse(n, out var network) && network.Contains(ip));
    }

    public bool IsConnectorKey(string? presented) =>
        Configured && presented is not null
        && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(ConnectorKey));
}

public sealed record MailAdminRequest(string? Action, int? UserId);

// The latest snapshot from the Mail Connector API, and what waits for it.
public sealed class MailMonitorStore
{
    public sealed record SyncAsk(int UserId, string RequestedBy);
    public sealed record Snapshot(string Overview, string Accounts, string Errors, DateTimeOffset PushedAt);

    private static readonly TimeSpan WantFor = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan KeepDetails = TimeSpan.FromMinutes(10);
    private readonly object gate = new();
    private Snapshot? current;
    private readonly Dictionary<int, (string Json, DateTimeOffset At)> details = [];
    private readonly Dictionary<int, DateTimeOffset> wanted = [];
    private readonly List<SyncAsk> syncs = [];

    // A push arrived: keep it, and hand back what waits (the sync requests are handed over once).
    public (int[] WantDetails, SyncAsk[] Syncs) Accept(string overview, string accounts, string errors,
        IReadOnlyDictionary<int, string> newDetails, DateTimeOffset now)
    {
        lock (gate)
        {
            current = new Snapshot(overview, accounts, errors, now);
            foreach (var (userId, json) in newDetails)
            {
                details[userId] = (json, now);
                wanted.Remove(userId);
            }
            foreach (var old in details.Where(d => now - d.Value.At > KeepDetails).Select(d => d.Key).ToList()) details.Remove(old);
            foreach (var old in wanted.Where(w => now - w.Value > WantFor).Select(w => w.Key).ToList()) wanted.Remove(old);
            var handed = syncs.ToArray();
            syncs.Clear();
            return (wanted.Keys.Take(10).ToArray(), handed);
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
}

public static class MailAdminEndpoints
{
    private const int MaxPushBytes = 8 * 1024 * 1024;
    private static readonly TimeSpan DetailsMaxAge = TimeSpan.FromSeconds(30);

    // How long "account" waits for the mailbox's details (the next push is at most 15 s away).
    public static TimeSpan DetailsWait { get; set; } = TimeSpan.FromSeconds(25);

    public static RouteHandlerBuilder MapMailMonitorPush(this WebApplication app) =>
        app.MapPost("/api/v2/mail/monitor/push", async (HttpContext http, MailMonitorStore store,
            IOptionsMonitor<MailAdminOptions> options, CancellationToken ct) =>
        {
            var settings = options.CurrentValue;
            // Off, or not from the connector's address: answer as if nothing were here.
            if (!settings.Configured || (settings.ConnectorNetworks.Length > 0
                    && !MailAdminOptions.InNetworks(http.Connection.RemoteIpAddress, settings.ConnectorNetworks)))
                throw new GatewayException(404, "Not found.");
            if (!settings.IsConnectorKey(http.Request.Headers["X-Connector-Key"]))
                throw new GatewayException(401, "Connector key missing or wrong.");

            JsonDocument document;
            try
            {
                document = await JsonDocument.ParseAsync(http.Request.Body, default, ct);
            }
            catch (JsonException)
            {
                throw new GatewayException(400, "The snapshot is not valid JSON.");
            }
            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("overview", out var overview) || overview.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("accounts", out var accounts) || accounts.ValueKind != JsonValueKind.Array
                    || !root.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array)
                    throw new GatewayException(400, "A snapshot needs overview, accounts and errors.");
                var newDetails = new Dictionary<int, string>();
                if (root.TryGetProperty("details", out var detailList) && detailList.ValueKind == JsonValueKind.Object)
                    foreach (var item in detailList.EnumerateObject())
                        if (int.TryParse(item.Name, out var userId) && userId > 0 && item.Value.ValueKind == JsonValueKind.Object)
                            newDetails[userId] = item.Value.GetRawText();
                var (wantDetails, syncs) = store.Accept(overview.GetRawText(), accounts.GetRawText(), errors.GetRawText(),
                    newDetails, DateTimeOffset.UtcNow);
                return Results.Ok(new
                {
                    wantDetails,
                    syncs = syncs.Select(s => new { userId = s.UserId, requestedBy = s.RequestedBy }),
                });
            }
        }).WithMetadata(new RequestSizeLimitAttribute(MaxPushBytes));

    public static RouteHandlerBuilder MapMailAdmin(this WebApplication app) =>
        app.MapPost("/api/v2/mail/admin", async (MailAdminRequest body, HttpContext http, GatewayPolicy policy,
            MailMonitorStore store, IOptionsMonitor<MailAdminOptions> options, CancellationToken ct) =>
        {
            var settings = options.CurrentValue;
            var ip = http.Connection.RemoteIpAddress;
            var (_, _, username) = policy.ResolveCaller(settings.Database, http.User, ip);
            if (!settings.Users.Contains(username, StringComparer.OrdinalIgnoreCase))
                throw new GatewayException(403, "The Mail Monitor is for mail admins only.");
            if (!MailAdminOptions.InNetworks(ip, settings.AllowedNetworks))
                throw new GatewayException(403,
                    $"The Mail Monitor opens only from the company network (this server sees your address as {Shown(ip)}).");
            if (!settings.Configured) throw new GatewayException(503, "The Mail Monitor is not configured on this server.");

            switch (body.Action)
            {
                case "overview" or "accounts" or "errors":
                {
                    var snapshot = store.Current()
                        ?? throw new GatewayException(503, "The Mail Connector API has not reported yet. It sends figures every 15 seconds.");
                    var json = body.Action == "overview" ? snapshot.Overview : body.Action == "accounts" ? snapshot.Accounts : snapshot.Errors;
                    return Wrapped(json, snapshot.PushedAt);
                }
                case "account" when body.UserId is > 0:
                {
                    var until = DateTimeOffset.UtcNow + DetailsWait;
                    while (true)
                    {
                        if (store.Details(body.UserId.Value, DetailsMaxAge, DateTimeOffset.UtcNow) is { } d) return Wrapped(d.Json, d.At);
                        if (DateTimeOffset.UtcNow >= until)
                            throw new GatewayException(504, "The Mail Connector API has not sent this mailbox yet. Try again in a moment.");
                        await Task.Delay(250, ct);
                    }
                }
                case "sync" when body.UserId is > 0:
                    return store.QueueSync(body.UserId.Value, username)
                        ? Results.Ok(new { queued = true, userId = body.UserId })
                        : throw new GatewayException(503, "Too many syncs are waiting. Try again shortly.");
                default:
                    throw new GatewayException(400, "Unknown Mail Monitor action.");
            }
        }).RequireAuthorization("gateway");

    // { "pushedAt": "...", "data": <the connector's JSON, already parsed and checked on arrival> }
    private static IResult Wrapped(string json, DateTimeOffset pushedAt) =>
        Results.Text($"{{\"pushedAt\":\"{pushedAt:O}\",\"data\":{json}}}", "application/json");

    private static string Shown(IPAddress? ip) =>
        ip is null ? "unknown" : (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip).ToString();
}
