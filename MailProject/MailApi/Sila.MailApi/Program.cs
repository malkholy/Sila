using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Sila.Mail.Contract;
using Sila.MailApi;
using Sila.MailApi.Admin;
using Sila.MailApi.Data;
using Sila.MailApi.Users;

// Sila Mail API (MailPlan APIs 2 and 3): one program, two copies, one name --
// silamail.glcpaints.com:9001, split DNS choosing the copy.
//   MailApi:Role = Internal (10.1.245.2, reads InternalMail) or External
//   (sila.glcpaints.com, reads the Mail database).
// Both: users read their own mailbox (Users/UserEndpoints.cs) and mail admins
// see the Mail Monitor (Admin/AdminEndpoints.cs), signed in with the Sila login
// token. External only: the Mail Connector API pushes the Mail Monitor snapshot
// and the publisher's batches here (nothing here calls into the company).
var builder = WebApplication.CreateBuilder(args);
// The server's secrets live beside the API only. Environment variables and
// command-line settings retain precedence.
builder.Configuration.AddJsonFile("appsettings.Mail.local.json", optional: true, reloadOnChange: false)
    .AddEnvironmentVariables()
    .AddCommandLine(args);
builder.Services.AddOptions<MailApiOptions>().BindConfiguration("MailApi").ValidateOnStart();
builder.Services.AddOptions<MailAdminOptions>().BindConfiguration("MailAdmin")
    .Validate(x => x.AllowedNetworks.All(n => IPNetwork.TryParse(n, out _)), "Invalid MailAdmin:AllowedNetworks.")
    .ValidateOnStart();
builder.Services.AddOptions<ConnectorOptions>().BindConfiguration("Connector")
    .Validate(x => x.PushKey.Length is 0 or >= 32, "Connector:PushKey must be empty (off) or at least 32 characters.")
    .Validate(x => x.PushNetworks.All(n => IPNetwork.TryParse(n, out _)), "Invalid Connector:PushNetworks.")
    .Validate(x => string.IsNullOrWhiteSpace(x.Url) || Uri.TryCreate(x.Url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps,
        "Connector:Url must be an https address.")
    .ValidateOnStart();
builder.Services.AddOptions<SyncOptions>().BindConfiguration("Sync")
    .Validate(x => x.Key.Length is 0 or >= 32, "Sync:Key must be empty (off) or at least 32 characters.")
    .Validate(x => x.AllowedNetworks.All(n => IPNetwork.TryParse(n, out _)), "Invalid Sync:AllowedNetworks.")
    .ValidateOnStart();

builder.Services.AddSilaToken(builder.Configuration, builder.Environment);
builder.Services.AddCors(o => o.AddDefaultPolicy(policy =>
{
    var origins = builder.Configuration.GetSection("MailApi:CorsOrigins").Get<string[]>() ?? [];
    if (origins.Length > 0)
        policy.WithOrigins(origins).WithMethods("GET", "POST").WithHeaders("Authorization", "Content-Type");
}));
// Per signed-in user, else per address (the external copy faces the internet).
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var user = context.User.Identity?.IsAuthenticated == true ? context.User.FindFirst("sub")?.Value : null;
        return string.IsNullOrEmpty(user)
            ? RateLimitPartition.GetFixedWindowLimiter("ip:" + context.Connection.RemoteIpAddress,
                _ => new() { PermitLimit = 300, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 })
            : RateLimitPartition.GetFixedWindowLimiter("user:" + user,
                _ => new() { PermitLimit = 600, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 });
    });
});
builder.Services.AddSingleton<IUserMailStore, SqlUserMailStore>();
builder.Services.AddSingleton<IInternalMonitor, SqlInternalMonitor>();
builder.Services.AddSingleton<MonitorSnapshotStore>();
builder.Services.AddSingleton<IConnectorClient, HttpConnectorClient>();
builder.Services.AddHttpClient(HttpConnectorClient.ClientName, c => c.Timeout = TimeSpan.FromSeconds(90))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddHttpClient(HttpConnectorClient.FilesClientName, c => c.Timeout = TimeSpan.FromMinutes(6))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddSingleton<ApplyStore>();
builder.Services.AddRequestDecompression();   // publish batches arrive gzip-compressed
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow);
builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);

var app = builder.Build();
app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    if (!app.Environment.IsDevelopment() && !context.Request.IsHttps)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsJsonAsync(new { success = false, message = "HTTPS is required." });
        return;
    }
    try
    {
        await next(context);
    }
    catch (BadHttpRequestException error) when (!context.Response.HasStarted)
    {
        context.Response.StatusCode = error.StatusCode;
        await context.Response.WriteAsJsonAsync(new { success = false, message = "Invalid request." });
    }
});
app.UseCors();
app.UseAuthentication();
app.UseRateLimiter();
app.UseAuthorization();
app.UseRequestDecompression();

// GET /health -- up, which copy, the database reachable (External: the schema and the copy's position).
app.MapGet("/health", async (IOptionsMonitor<MailApiOptions> options, ApplyStore store, CancellationToken ct) =>
{
    var external = options.CurrentValue.Role == MailRole.External;
    var state = store.Configured ? await store.ProbeAsync(external, ct) : (false, false, 0L, (DateTime?)null);
    return Results.Ok(new
    {
        success = true,
        service = "Sila Mail API",
        role = options.CurrentValue.Role.ToString(),
        databaseOk = state.Item1,
        schemaOk = state.Item2,
        lastAppliedSeq = external ? state.Item3 : (long?)null,
        lastAppliedAt = external ? state.Item4 : null,
        time = DateTimeOffset.Now,
    });
});

app.MapUserMail();
app.MapAdmin();

// External only: the publisher's batches (X-Sync-Key, Sync:AllowedNetworks).
var sync = app.MapGroup("/sync/v1").AddEndpointFilter(async (context, next) =>
{
    var http = context.HttpContext;
    var settings = http.RequestServices.GetRequiredService<IOptionsMonitor<SyncOptions>>().CurrentValue;
    var role = http.RequestServices.GetRequiredService<IOptionsMonitor<MailApiOptions>>().CurrentValue.Role;
    // Not the external copy, off, or not from the company: answer as if nothing were here.
    if (role != MailRole.External || !settings.Configured) return Results.NotFound();
    if (!settings.IsAllowed(http.Connection.RemoteIpAddress))
    {
        // Logged so the connector's real address can be added to Sync:AllowedNetworks.
        http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Sync")
            .LogWarning("Publish batch refused from {Address}: not in Sync:AllowedNetworks", http.Connection.RemoteIpAddress);
        return Results.NotFound();
    }
    if (!settings.IsKey(http.Request.Headers["X-Sync-Key"]))
        return Results.Json(new { success = false, message = "Sync key missing or wrong." }, statusCode: 401);
    return await next(context);
});

// GET /sync/v1/state -- the last change applied here.
sync.MapGet("/state", async (ApplyStore store, CancellationToken ct) =>
{
    var state = await store.StateAsync(ct);
    return state.Ok ? Results.Ok(new PublishResult(state.LastAppliedSeq, 0, 0)) : Results.StatusCode(503);
});

// POST /sync/v1/apply  (gzip JSON PublishBatch) -- one batch, one transaction.
// 200 PublishResult, or 409 PublishResult when AfterSeq is beyond what was applied here.
sync.MapPost("/apply", async (HttpContext http, ApplyStore store, ILoggerFactory logs, CancellationToken ct) =>
{
    PublishBatch? batch;
    try
    {
        batch = await JsonSerializer.DeserializeAsync<PublishBatch>(http.Request.Body, BatchJson.Options, ct);
    }
    catch (JsonException)
    {
        return Results.Json(new { success = false, message = "The batch is not valid JSON." }, statusCode: 400);
    }
    if (BatchJson.Problem(batch) is { } problem)
        return Results.Json(new { success = false, message = problem }, statusCode: 400);

    var outcome = await store.ApplyAsync(batch!, ct);
    var result = new PublishResult(outcome.LastAppliedSeq, outcome.Applied, outcome.Skipped);
    if (outcome.Gap)
    {
        logs.CreateLogger("Sync").LogWarning("Batch after {AfterSeq} refused: applied here only up to {Last}", batch!.AfterSeq, outcome.LastAppliedSeq);
        return Results.Json(result, statusCode: 409);
    }
    return Results.Ok(result);
}).WithMetadata(new RequestSizeLimitAttribute(BatchJson.MaxBytes));

app.Run();

public partial class Program;

// How a publish batch is read and checked before anything is written.
public static class BatchJson
{
    public const int MaxBytes = 64 * 1024 * 1024;   // after decompression

    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public static string? Problem(PublishBatch? batch)
    {
        if (batch is null) return "A batch is required.";
        if (batch.Users is null || batch.Folders is null || batch.Messages is null || batch.Bodies is null
            || batch.Attachments is null || batch.Deletes is null || batch.Deletes.Users is null || batch.Deletes.Folders is null
            || batch.Deletes.Messages is null || batch.Deletes.Bodies is null || batch.Deletes.Attachments is null)
            return "Every list of the batch is required (it may be empty).";
        if (batch.AfterSeq < 0 || batch.ToSeq < batch.AfterSeq) return "AfterSeq / ToSeq are out of order.";
        var seqs = batch.Users.Select(x => x.Seq).Concat(batch.Folders.Select(x => x.Seq)).Concat(batch.Messages.Select(x => x.Seq))
            .Concat(batch.Bodies.Select(x => x.Seq)).Concat(batch.Attachments.Select(x => x.Seq))
            .Concat(batch.Deletes.Users.Select(x => x.Seq)).Concat(batch.Deletes.Folders.Select(x => x.Seq))
            .Concat(batch.Deletes.Messages.Select(x => x.Seq)).Concat(batch.Deletes.Bodies.Select(x => x.Seq))
            .Concat(batch.Deletes.Attachments.Select(x => x.Seq));
        if (seqs.Any(s => s <= 0 || s > batch.ToSeq)) return "A row's Seq is outside the batch.";
        if (batch.Messages.Any(m => m.Recipients is null || m.ExchangeItemId is null || m.ChangeKey is null))
            return "A message is incomplete.";
        if (batch.Users.Any(u => string.IsNullOrWhiteSpace(u.SmtpAddress) || u.SyncStatus is null)
            || batch.Folders.Any(f => f.ExchangeFolderId is null || f.DisplayName is null || f.FolderType is null)
            || batch.Attachments.Any(a => a.ExchangeAttachmentId is null || a.Name is null))
            return "A row is incomplete.";
        return null;
    }
}
