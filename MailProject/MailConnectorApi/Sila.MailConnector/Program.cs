using System.Diagnostics;
using System.Net;
using System.Net.Mail;
using Microsoft.Extensions.Options;
using System.Text.Json.Serialization;
using Sila.MailConnector;
using Sila.MailConnector.Data;
using Sila.MailConnector.Ews;
using Sila.MailConnector.Monitor;
using Sila.MailConnector.Publish;
using Sila.MailConnector.Sync;

// Mail Connector API (MailPlan "API 1"): the only Sila service that talks to
// Exchange. Internal network only; called by the other Sila servers, never by
// users. So far: configuration, the network restriction, health, an Exchange
// check, mailbox registration, and syncing one folder into InternalMail.
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
builder.Services.AddSingleton<SyncQueue>();
builder.Services.AddHostedService<SyncWorker>();
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

// POST /connector/v1/mailboxes  JSON: userId, smtpAddress, displayName
// Registers a Sila user's mailbox, after checking Exchange can open it.
app.MapPost("/connector/v1/mailboxes", async (MailboxRequest body, IOptionsMonitor<ExchangeOptions> exchange,
    EwsClient ews, MailStore store, CancellationToken ct) =>
{
    if (body.UserId is not > 0) return Error(400, "InvalidUser", "userId (the Sila UserID) is required.");
    if (!IsAllowedMailbox(body.SmtpAddress, exchange.CurrentValue))
        return Error(400, "InvalidMailbox", "smtpAddress must be one address in an allowed domain (Exchange:AllowedDomains).");
    var name = body.DisplayName?.Trim();
    if (name is { Length: > 256 }) return Error(400, "InvalidName", "displayName is at most 256 characters.");
    try
    {
        await ews.GetFolderAsync(body.SmtpAddress!, "inbox", ct);
    }
    catch (EwsException error)
    {
        return Error(error.Kind == EwsErrorKind.NotFound ? 404 : 502, error.Code, error.Message, error.Kind);
    }
    var added = await store.SaveUserAsync(body.UserId.Value, body.SmtpAddress!.ToLowerInvariant(),
        string.IsNullOrEmpty(name) ? null : name, ct);
    return Results.Ok(new { success = true, added, userId = body.UserId });
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
    if (await store.GetUserAsync(userId, ct) is null) return Error(404, "NotRegistered", "Mailbox not registered.");
    return queue.TryEnqueue(new SyncRequest(userId, folderName, "Admin"))
        ? Results.Accepted(value: new { success = true, queued = true, userId, folder = folderName })
        : Error(503, "QueueFull", "Too many syncs are waiting. Try again shortly.");
});

// GET /connector/v1/mailboxes/{userId} -- account, folders (Exchange vs DB counts), recent syncs.
app.MapGet("/connector/v1/mailboxes/{userId:int}", async (int userId, MailStore store, CancellationToken ct) =>
    await store.GetStatusAsync(userId, ct) is { } status
        ? Results.Ok(status)
        : Error(404, "NotRegistered", "Mailbox not registered."));

app.Run();

static bool IsAllowedMailbox(string? mailbox, ExchangeOptions settings) =>
    !string.IsNullOrWhiteSpace(mailbox) && mailbox.Length <= 254
    && MailAddress.TryCreate(mailbox, out var address)
    && string.Equals(address.Address, mailbox, StringComparison.OrdinalIgnoreCase)
    && settings.AllowedDomains.Contains(address.Host, StringComparer.OrdinalIgnoreCase);

static IResult Error(int status, string code, string message, EwsErrorKind? kind = null, int? backOffMilliseconds = null) =>
    Results.Json(new { success = false, code, kind = kind?.ToString(), message, backOffMilliseconds }, statusCode: status);

public partial class Program;

public sealed record MailboxRequest(int? UserId, string? SmtpAddress, string? DisplayName);
