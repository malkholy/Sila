using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Sila.Mail.Contract;
using Sila.MailExternal;
using Sila.MailExternal.Data;

// Mail External API (MailPlan "API 3"), hosted outside the company beside the
// external Mail database. So far: the sync endpoints only -- the Mail Connector
// API (inside) pushes publish batches here; nothing here ever calls into the
// company, and it holds no Exchange credentials. The user endpoints (the same
// as the internal Mail API) come later.
var builder = WebApplication.CreateBuilder(args);
// The server's secrets live beside the API only. Environment variables and
// command-line settings retain precedence.
builder.Configuration.AddJsonFile("appsettings.External.local.json", optional: true, reloadOnChange: false)
    .AddEnvironmentVariables()
    .AddCommandLine(args);
builder.Services.AddOptions<SyncOptions>().BindConfiguration("Sync")
    .Validate(x => x.Key.Length is 0 or >= 32, "Sync:Key must be empty (off) or at least 32 characters.")
    .Validate(x => x.AllowedNetworks.All(n => IPNetwork.TryParse(n, out _)), "Invalid Sync:AllowedNetworks.")
    .ValidateOnStart();
builder.Services.AddSingleton<ApplyStore>();
builder.Services.AddRequestDecompression();   // batches arrive gzip-compressed
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
app.UseRequestDecompression();

// GET /health -- up, the database reachable, the schema current, where the copy stands.
app.MapGet("/health", async (ApplyStore store, CancellationToken ct) =>
{
    var state = store.Configured ? await store.StateAsync(ct) : (false, false, 0L, (DateTime?)null);
    return Results.Ok(new
    {
        success = true,
        service = "Sila Mail External API",
        databaseOk = state.Item1,
        schemaOk = state.Item2,
        lastAppliedSeq = state.Item3,
        lastAppliedAt = state.Item4,
        time = DateTimeOffset.Now,
    });
});

// The sync endpoints: the Mail Connector API only (X-Sync-Key, Sync:AllowedNetworks).
var sync = app.MapGroup("/sync/v1").AddEndpointFilter(async (context, next) =>
{
    var http = context.HttpContext;
    var settings = http.RequestServices.GetRequiredService<IOptionsMonitor<SyncOptions>>().CurrentValue;
    // Off, or not from the company: answer as if nothing were here.
    if (!settings.Configured || !settings.IsAllowed(http.Connection.RemoteIpAddress)) return Results.NotFound();
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

// How a batch is read and checked before anything is written.
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
