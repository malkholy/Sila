using System.Diagnostics;
using System.Net;
using System.Net.Mail;
using Microsoft.Extensions.Options;
using System.Text.Json.Serialization;
using Sila.MailConnector;
using Sila.MailConnector.Data;
using Sila.MailConnector.Ews;
using Sila.MailConnector.Files;
using Sila.MailConnector.Monitor;
using Sila.MailConnector.Publish;
using Sila.MailConnector.Sync;

// Mail Connector API (MailPlan "API 1"): the only Sila service that talks to
// Exchange. Internal network only; called by the other Sila servers, never by
// users. So far: configuration, the network restriction, health, an Exchange
// check, mailbox registration, syncing into InternalMail, and attachment files.
var builder = WebApplication.CreateBuilder(args);
// The service account password lives beside the API on the server only.
// Deployment environment variables and command-line settings retain precedence.
builder.Configuration.AddJsonFile("appsettings.Exchange.local.json", optional: true, reloadOnChange: false)
    .AddEnvironmentVariables()
    .AddCommandLine(args);
builder.Services.AddOptions<ExchangeOptions>().BindConfiguration("Exchange")
    .Validate(x => string.IsNullOrWhiteSpace(x.EwsUrl)
        || Uri.TryCreate(x.EwsUrl, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps, "Exchange:EwsUrl must be an https address.")
    .Validate(x => ExchangeOptions.Versions.Contains(x.RequestServerVersion), "Invalid Exchange:RequestServerVersion.")
    .Validate(x => x.AuthSchemes.All(ExchangeOptions.WindowsSchemes.Contains),
        "Exchange:AuthSchemes may only list Negotiate and NTLM.")
    .Validate(x => x.TimeoutSeconds is >= 5 and <= 300 && x.MaxResponseBytes is >= 64 * 1024 and <= 256 * 1024 * 1024,
        "Invalid Exchange limits.")
    .ValidateOnStart();
builder.Services.AddOptions<AccessOptions>().BindConfiguration("Access")
    .Validate(x => x.AllowedNetworks.All(n => IPNetwork.TryParse(n, out _)), "Invalid Access:AllowedNetworks.")
    .ValidateOnStart();
// Time and size limits are applied per call inside EwsClient (it reads answers as streams).
builder.Services.AddHttpClient<EwsClient>(http => http.Timeout = Timeout.InfiniteTimeSpan)
    .ConfigurePrimaryHttpMessageHandler(sp =>
        EwsClient.CreateHandler(sp.GetRequiredService<IOptionsMonitor<ExchangeOptions>>().CurrentValue));
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow);
builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
builder.Services.AddSingleton<MailStore>();
builder.Services.AddTransient<MailboxSync>();
builder.Services.AddTransient<MailboxRegistration>();
// Attachment files, fetched from Exchange on first open and kept on this server.
builder.Services.AddOptions<AttachmentOptions>().BindConfiguration("Attachments")
    .Validate(x => x.MaxBytes is >= 1024 * 1024 and <= 150L * 1024 * 1024 && x.TimeoutSeconds is >= 30 and <= 1800
        && x.Parallel is >= 1 and <= 16, "Invalid Attachments limits (MaxBytes 1..150 MB, TimeoutSeconds 30..1800, Parallel 1..16).")
    .ValidateOnStart();
builder.Services.AddTransient<AttachmentCache>();
builder.Services.AddSingleton<SyncQueue>();
// What each worker last did; saved to MailServiceHeartbeat every 15 s (the Mail Monitor's Connector tab).
builder.Services.AddSingleton<ConnectorHealth>();
builder.Services.AddHostedService<HeartbeatWriter>();
builder.Services.AddHostedService<SyncWorker>();
// The safety sync timer: every mailbox at least every MailSettings SafetySyncMinutes.
builder.Services.AddOptions<AutoSyncOptions>().BindConfiguration("AutoSync")
    .Validate(x => x.CheckSeconds is >= 10 and <= 600, "AutoSync:CheckSeconds must be 10..600.")
    .Validate(x => x.InitialParallel is >= 1 and <= 8 && x.ChangesParallel is >= 1 and <= 16,
        "AutoSync:InitialParallel must be 1..8 and AutoSync:ChangesParallel 1..16.")
    .ValidateOnStart();
builder.Services.AddHostedService<SyncScheduler>();
// Mail Monitor: figures pushed out to SilaApi (7400, outside the company) -- no inbound port.
builder.Services.AddOptions<MonitorOptions>().BindConfiguration("Monitor")
    .Validate(x => string.IsNullOrWhiteSpace(x.PushUrl)
        || Uri.TryCreate(x.PushUrl, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps && x.PushKey.Length >= 32,
        "Monitor:PushUrl must be an https address, with a Monitor:PushKey of at least 32 characters.")
    .Validate(x => x.IntervalSeconds is >= 5 and <= 300, "Monitor:IntervalSeconds must be 5..300.")
    .ValidateOnStart();
builder.Services.AddHttpClient(MonitorPusher.ClientName, c => c.Timeout = TimeSpan.FromSeconds(30))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddHostedService<MonitorPusher>();
// Publisher: InternalMail -> the external Mail database (off while Publish:Url is empty).
builder.Services.AddOptions<PublishOptions>().BindConfiguration("Publish")
    .Validate(x => string.IsNullOrWhiteSpace(x.Url)
        || Uri.TryCreate(x.Url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps && x.Key.Length >= 32,
        "Publish:Url must be an https address, with a Publish:Key of at least 32 characters.")
    .Validate(x => x.BatchChanges is >= 1 and <= 5000 && x.MaxBatchBytes is >= 65536 and <= 48 * 1024 * 1024
        && x.IdleSeconds is >= 1 and <= 300, "Invalid Publish limits.")
    .ValidateOnStart();
builder.Services.AddHttpClient(Publisher.ClientName, c => c.Timeout = TimeSpan.FromMinutes(2))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddHostedService<Publisher>();

var app = builder.Build();
var access = app.Services.GetRequiredService<IOptionsMonitor<AccessOptions>>();
app.Use(async (context, next) =>
{
    // Not on the list: answer as if nothing were here.
    if (!AccessOptions.IsAllowed(context.Connection.RemoteIpAddress, access.CurrentValue))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    if (!app.Environment.IsDevelopment() && !context.Request.IsHttps)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsJsonAsync(new { success = false, message = "HTTPS is required." });
        return;
    }
    await next(context);
});

// GET /health -- the service is up and reaches InternalMail (does not call Exchange).
app.MapGet("/health", async (IOptionsMonitor<ExchangeOptions> exchange, MailStore store, CancellationToken ct) => Results.Ok(new
{
    success = true,
    service = "Sila Mail Connector API",
    exchangeConfigured = exchange.CurrentValue.Configured,
    databaseOk = store.Configured && await store.PingAsync(ct),
    time = DateTimeOffset.Now,
}));

// GET /connector/v1/exchange/check?mailbox=user@domain&folder=inbox
// Signs in as the service account, impersonates the mailbox and reads one folder:
// proves EWS, the sign-in, the impersonation role and its scope in one call.
app.MapGet("/connector/v1/exchange/check", async (string? mailbox, string? folder,
    IOptionsMonitor<ExchangeOptions> exchange, EwsClient ews, ILoggerFactory logs, CancellationToken ct) =>
{
    var settings = exchange.CurrentValue;
    if (!settings.Configured)
        return Error(503, "NotConfigured", "Exchange is not configured (Exchange:EwsUrl, Username, Password).");
    if (!IsAllowedMailbox(mailbox, settings))
        return Error(400, "InvalidMailbox", "mailbox must be one address in an allowed domain (Exchange:AllowedDomains).");
    var folderId = string.IsNullOrWhiteSpace(folder) ? "inbox" : folder;
    if (!EwsClient.DistinguishedFolders.Contains(folderId))
        return Error(400, "InvalidFolder", $"folder must be one of: {string.Join(", ", EwsClient.DistinguishedFolders)}.");

    var started = Stopwatch.GetTimestamp();
    try
    {
        var info = await ews.GetFolderAsync(mailbox!, folderId, ct);
        return Results.Ok(new
        {
            success = true,
            mailbox,
            folder = info.DisplayName,
            totalCount = info.TotalCount,
            unreadCount = info.UnreadCount,
            elapsedMs = (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
        });
    }
    catch (EwsException error)
    {
        logs.CreateLogger("Exchange").LogWarning("Exchange check failed for {Mailbox}: {Kind} {Code}", mailbox, error.Kind, error.Code);
        var status = error.Kind switch
        {
            EwsErrorKind.NotFound => 404,
            EwsErrorKind.Throttling => 503,
            _ => 502,
        };
        return Error(status, error.Code, error.Message, error.Kind, error.BackOffMilliseconds);
    }
});

// POST /connector/v1/mailboxes  JSON: userId, smtpAddress, displayName, username
// Registers a Sila user's mailbox (the same checks as "Add mailbox" in the Mail
// Monitor: MailboxRegistration) and queues its first sync.
app.MapPost("/connector/v1/mailboxes", async (MailboxRequest body, MailboxRegistration registration, CancellationToken ct) =>
{
    var result = await registration.AddAsync(body.UserId ?? 0, body.SmtpAddress, body.DisplayName, body.Username, "Admin", ct);
    return result.Ok
        ? Results.Ok(new { success = true, userId = body.UserId, message = result.Message })
        : Error(400, "NotAdded", result.Message);
});

// POST /connector/v1/mailboxes/{userId}/sync?folder=all
// Queues a sync of the folder tree and every mail folder (or one well-known
// folder, e.g. folder=inbox); runs in the background.
app.MapPost("/connector/v1/mailboxes/{userId:int}/sync", async (int userId, string? folder, MailStore store,
    SyncQueue queue, CancellationToken ct) =>
{
    var folderName = string.IsNullOrWhiteSpace(folder) ? MailboxSync.AllFolders : folder;
    if (folderName != MailboxSync.AllFolders && !MailboxSync.FolderTypes.ContainsKey(folderName))
        return Error(400, "InvalidFolder",
            $"folder must be {MailboxSync.AllFolders} or one of: {string.Join(", ", MailboxSync.FolderTypes.Keys)}.");
    if (await store.GetUserAsync(userId, ct) is not { } user) return Error(404, "NotRegistered", "Mailbox not registered.");
    return queue.TryEnqueue(new SyncRequest(userId, folderName, "Admin", SyncRequest.LaneFor(user.LastSyncAt)))
        ? Results.Accepted(value: new { success = true, queued = true, userId, folder = folderName })
        : Error(503, "QueueFull", "Too many syncs are waiting. Try again shortly.");
});

// GET /connector/v1/mailboxes/{userId} -- account, folders (Exchange vs DB counts), recent syncs.
app.MapGet("/connector/v1/mailboxes/{userId:int}", async (int userId, MailStore store, CancellationToken ct) =>
    await store.GetStatusAsync(userId, ct) is { } status
        ? Results.Ok(status)
        : Error(404, "NotRegistered", "Mailbox not registered."));

// GET /connector/v1/mailboxes/{userId}/attachments/{attachmentId}
// The file (application/octet-stream): from this server's store, or fetched from
// Exchange first. The caller (the Mail API) checks who may open it and names it.
app.MapGet("/connector/v1/mailboxes/{userId:int}/attachments/{attachmentId:long}", async (int userId, long attachmentId,
    AttachmentCache cache, CancellationToken ct) =>
{
    var result = await cache.OpenAsync(userId, attachmentId, ct);
    return result.Ok ? Results.File(result.Path!, "application/octet-stream") : Error(result.Status, result.Code, result.Message);
});

app.Run();

static bool IsAllowedMailbox(string? mailbox, ExchangeOptions settings) =>
    !string.IsNullOrWhiteSpace(mailbox) && mailbox.Length <= 254
    && MailAddress.TryCreate(mailbox, out var address)
    && string.Equals(address.Address, mailbox, StringComparison.OrdinalIgnoreCase)
    && settings.AllowedDomains.Contains(address.Host, StringComparer.OrdinalIgnoreCase);

static IResult Error(int status, string code, string message, EwsErrorKind? kind = null, int? backOffMilliseconds = null) =>
    Results.Json(new { success = false, code, kind = kind?.ToString(), message, backOffMilliseconds }, statusCode: status);

public partial class Program;

public sealed record MailboxRequest(int? UserId, string? SmtpAddress, string? DisplayName, string? Username = null);
