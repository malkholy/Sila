using System.Net;
using System.Net.Mail;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Sila.MailApi.Admin;

public sealed record AdminRequest(string? Action, int? UserId, string? Email = null, string? DisplayName = null,
    string? Username = null, string? RequestId = null);

// The Mail Monitor (System Settings), for a mail admin (MailAdmin:Users) from an
// allowed place (MailAdmin:AllowedNetworks / AnyNetworkUsers), the username
// from the validated token. Answers { pushedAt, data } for the figures.
//   Internal role: live from InternalMail; "sync" and "add" go straight to the
//     Mail Connector API on this server, and "add" answers at once (done: true).
//   External role: from the snapshot the connector pushes (POST
//     /mail/v1/monitor/push); "account" waits briefly for the mailbox's details,
//     "sync" and "add" are handed over with the next push, "addResult" reads
//     the answer.
public static class AdminEndpoints
{
    private const int MaxPushBytes = 8 * 1024 * 1024;
    private static readonly TimeSpan DetailsMaxAge = TimeSpan.FromSeconds(30);
    public static TimeSpan DetailsWait { get; set; } = TimeSpan.FromSeconds(25);

    public static void MapAdmin(this WebApplication app)
    {
        app.MapPost("/mail/v1/admin", async (AdminRequest body, HttpContext http, IOptionsMonitor<MailApiOptions> api,
            IOptionsMonitor<MailAdminOptions> admins, IServiceProvider services, CancellationToken ct) =>
        {
            var username = Caller.Username(http.User, api.CurrentValue)!;
            var settings = admins.CurrentValue;
            if (!settings.IsAdmin(username)) return Error(403, "The Mail Monitor is for mail admins only.");
            var ip = http.Connection.RemoteIpAddress;
            if (!settings.FromAllowedPlace(username, ip))
                return Error(403, $"The Mail Monitor opens only from the company network (this server sees your address as {Shown(ip)}).");
            return api.CurrentValue.Role == MailRole.Internal
                ? await InternalAsync(body, username, services, ct)
                : await ExternalAsync(body, username, services.GetRequiredService<MonitorSnapshotStore>(), ct);
        }).RequireAuthorization();

        // External role only: the Mail Connector API pushes the snapshot here.
        app.MapPost("/mail/v1/monitor/push", async (HttpContext http, IOptionsMonitor<MailApiOptions> api,
            IOptionsMonitor<ConnectorOptions> connector, MonitorSnapshotStore store, ILoggerFactory logs, CancellationToken ct) =>
        {
            var settings = connector.CurrentValue;
            if (api.CurrentValue.Role != MailRole.External || !settings.PushConfigured) return Results.NotFound();
            if (settings.PushNetworks.Length > 0 && !MailAdminOptions.InNetworks(http.Connection.RemoteIpAddress, settings.PushNetworks))
            {
                // Logged so the connector's real address can be added to Connector:PushNetworks.
                logs.CreateLogger("Monitor").LogWarning("Mail Monitor push refused from {Address}: not in Connector:PushNetworks",
                    Shown(http.Connection.RemoteIpAddress));
                return Results.NotFound();
            }
            if (!settings.IsPushKey(http.Request.Headers["X-Connector-Key"])) return Error(401, "Connector key missing or wrong.");

            JsonDocument document;
            try { document = await JsonDocument.ParseAsync(http.Request.Body, default, ct); }
            catch (JsonException) { return Error(400, "The snapshot is not valid JSON."); }
            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("overview", out var overview) || overview.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("accounts", out var accounts) || accounts.ValueKind != JsonValueKind.Array
                    || !root.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array)
                    return Error(400, "A snapshot needs overview, accounts and errors.");
                var newDetails = new Dictionary<int, string>();
                if (root.TryGetProperty("details", out var detailList) && detailList.ValueKind == JsonValueKind.Object)
                    foreach (var item in detailList.EnumerateObject())
                        if (int.TryParse(item.Name, out var userId) && userId > 0 && item.Value.ValueKind == JsonValueKind.Object)
                            newDetails[userId] = item.Value.GetRawText();
                var results = new List<MonitorSnapshotStore.AddResult>();
                if (root.TryGetProperty("addResults", out var resultList) && resultList.ValueKind == JsonValueKind.Array)
                    foreach (var item in resultList.EnumerateArray())
                        if (item.ValueKind == JsonValueKind.Object
                            && item.TryGetProperty("requestId", out var id) && id.ValueKind == JsonValueKind.String && IsRequestId(id.GetString())
                            && item.TryGetProperty("userId", out var uid) && uid.TryGetInt32(out var resultUser)
                            && item.TryGetProperty("ok", out var ok) && ok.ValueKind is JsonValueKind.True or JsonValueKind.False)
                            results.Add(new(id.GetString()!, resultUser, Text(item, "email", 320), ok.GetBoolean(), Text(item, "message", 500)));
                var (wantDetails, syncs, adds) = store.Accept(overview.GetRawText(), accounts.GetRawText(), errors.GetRawText(),
                    newDetails, results, DateTimeOffset.UtcNow);
                return Results.Ok(new
                {
                    wantDetails,
                    syncs = syncs.Select(s => new { userId = s.UserId, requestedBy = s.RequestedBy }),
                    adds = adds.Select(a => new { requestId = a.RequestId, userId = a.UserId, email = a.Email, displayName = a.DisplayName,
                        username = a.Username, requestedBy = a.RequestedBy }),
                });
            }
        }).WithMetadata(new RequestSizeLimitAttribute(MaxPushBytes));
    }

    private static async Task<IResult> InternalAsync(AdminRequest body, string username, IServiceProvider services, CancellationToken ct)
    {
        var monitor = services.GetRequiredService<IInternalMonitor>();
        var connector = services.GetRequiredService<IConnectorClient>();
        switch (body.Action)
        {
            case "overview": return Wrapped(await monitor.OverviewAsync(ct));
            case "accounts": return Wrapped(await monitor.AccountsAsync(ct));
            case "errors": return Wrapped(await monitor.ErrorsAsync(ct));
            case "account" when body.UserId is > 0:
                return await monitor.AccountAsync(body.UserId.Value, ct) is { } account
                    ? Wrapped(account) : Error(404, "Mailbox not registered.");
            case "sync" when body.UserId is > 0:
            {
                var answer = await connector.SyncAsync(body.UserId.Value, ct);
                return answer.Ok ? Results.Ok(new { queued = true, userId = body.UserId }) : Error(502, answer.Message);
            }
            case "add" when body.UserId is > 0:
            {
                if (CheckAdd(body) is { } problem) return Error(400, problem);
                var answer = await connector.AddAsync(body.UserId.Value, body.Email!.Trim().ToLowerInvariant(), Name(body),
                    body.Username!.Trim(), ct);
                return Results.Ok(new { done = true, ok = answer.Ok, message = answer.Message });
            }
            default:
                return Error(400, "Unknown Mail Monitor action.");
        }
    }

    private static async Task<IResult> ExternalAsync(AdminRequest body, string username, MonitorSnapshotStore store, CancellationToken ct)
    {
        switch (body.Action)
        {
            case "overview" or "accounts" or "errors":
            {
                var snapshot = store.Current();
                if (snapshot is null) return Error(503, "The Mail Connector API has not reported yet. It sends figures every 15 seconds.");
                var json = body.Action == "overview" ? snapshot.Overview : body.Action == "accounts" ? snapshot.Accounts : snapshot.Errors;
                return WrappedJson(json, snapshot.PushedAt);
            }
            case "account" when body.UserId is > 0:
            {
                var until = DateTimeOffset.UtcNow + DetailsWait;
                while (true)
                {
                    if (store.Details(body.UserId.Value, DetailsMaxAge, DateTimeOffset.UtcNow) is { } d) return WrappedJson(d.Json, d.At);
                    if (DateTimeOffset.UtcNow >= until)
                        return Error(504, "The Mail Connector API has not sent this mailbox yet. Try again in a moment.");
                    await Task.Delay(250, ct);
                }
            }
            case "sync" when body.UserId is > 0:
                return store.QueueSync(body.UserId.Value, username)
                    ? Results.Ok(new { queued = true, userId = body.UserId })
                    : Error(503, "Too many syncs are waiting. Try again shortly.");
            case "add" when body.UserId is > 0:
            {
                if (CheckAdd(body) is { } problem) return Error(400, problem);
                var requestId = Guid.NewGuid().ToString("N");
                return store.QueueAdd(new(requestId, body.UserId.Value, body.Email!.Trim().ToLowerInvariant(), Name(body),
                        body.Username!.Trim(), username))
                    ? Results.Ok(new { queued = true, requestId })
                    : Error(503, "Too many mailboxes are waiting to be added. Try again shortly.");
            }
            case "addResult" when IsRequestId(body.RequestId):
                return store.AddResultFor(body.RequestId!) is { } result
                    ? Results.Ok(new { pending = false, ok = result.Ok, message = result.Message, userId = result.UserId, email = result.Email })
                    : Results.Ok(new { pending = true });
            default:
                return Error(400, "Unknown Mail Monitor action.");
        }
    }

    // One address, a username, a short name. The connector checks the address with Exchange.
    internal static string? CheckAdd(AdminRequest body)
    {
        var email = body.Email?.Trim() ?? "";
        if (email.Length is 0 or > 254 || !MailAddress.TryCreate(email, out var address)
            || !string.Equals(address.Address, email, StringComparison.OrdinalIgnoreCase))
            return "Type one valid email address, e.g. name@glcpaints.com.";
        var user = body.Username?.Trim() ?? "";
        if (user.Length is 0 or > 50 || user.Any(char.IsControl)) return "The Sila username is required (at most 50 characters).";
        if (body.DisplayName is { Length: > 256 }) return "The display name is at most 256 characters.";
        return null;
    }

    private static string? Name(AdminRequest body) => string.IsNullOrWhiteSpace(body.DisplayName) ? null : body.DisplayName.Trim();

    private static IResult Wrapped(object data) => Results.Json(new { pushedAt = DateTimeOffset.UtcNow, data });

    // The connector's JSON, already parsed and checked on arrival.
    private static IResult WrappedJson(string json, DateTimeOffset pushedAt) =>
        Results.Text($"{{\"pushedAt\":\"{pushedAt:O}\",\"data\":{json}}}", "application/json");

    internal static IResult Error(int status, string message) => Results.Json(new { success = false, message }, statusCode: status);

    private static bool IsRequestId(string? id) => id is { Length: 32 } && id.All(Uri.IsHexDigit);

    private static string Text(JsonElement item, string name, int max)
    {
        var value = item.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        return value.Length > max ? value[..max] : value;
    }

    private static string Shown(IPAddress? ip) => ip is null ? "unknown" : (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip).ToString();
}
