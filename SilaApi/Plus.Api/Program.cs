using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.ResponseCompression;
using System.IO.Compression;
using Microsoft.Data.SqlClient;
using Microsoft.IdentityModel.Tokens;
using Microsoft.Extensions.Options;
using Plus.Api;
using Plus.Api.Auth;
using Plus.Api.Attachments;
using Plus.Api.Live;
using Plus.Api.Photos;
using System.Security.Claims;

var builder = WebApplication.CreateBuilder(args);
// SQL credentials may be configured locally beside the API source.
// Deployment environment variables and command-line settings retain precedence.
builder.Configuration.AddJsonFile("appsettings.Sql.local.json", optional: true, reloadOnChange: false)
    .AddEnvironmentVariables()
    .AddCommandLine(args);
if (args.Contains("--export-public-key", StringComparer.Ordinal))
{
    var written = LocalTokens.ExportPublicKey(builder.Configuration, builder.Environment);
    Console.WriteLine($"Public key written to {written}. Copy it to the Files API's App_Data folder.");
    return;
}
if (args.Contains("--initialize-auth", StringComparer.Ordinal))
{
    LocalTokens.Initialize(builder.Configuration, builder.Environment);
    Console.WriteLine("Signing key created. Restrict App_Data permissions to administrators and the API application pool before starting IIS.");
    return;
}
builder.Services.AddSingleton<LocalTokens>();
builder.Services.AddScoped<IAuthStore, SqlAuthStore>();
builder.Services.AddScoped<AuthService>();
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 1024 * 1024);
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow);
builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
builder.Services.AddOptions<GatewayOptions>().BindConfiguration("Gateway")
    .Validate(x => x.CommandTimeoutSeconds is >= 1 and <= 120 && x.MaxResultRows is >= 1 and <= 100000
        && x.MaxResultBytes is >= 1024 and <= 32 * 1024 * 1024, "Invalid execution limits.")
    .Validate(x => x.InternalNetworks.All(n => System.Net.IPNetwork.TryParse(n, out _))
        && x.KnownProxies.All(p => IPAddress.TryParse(p, out _)), "Invalid network configuration.")
    .Validate(x => x.Databases.Values.All(db => db.Users.All(u => !u.Enabled
        || (!string.IsNullOrWhiteSpace(u.Subject) && !string.IsNullOrWhiteSpace(u.Issuer)
            && !string.IsNullOrWhiteSpace(u.Username)))
        && db.Users.GroupBy(u => (u.Issuer, u.Subject)).All(g => g.Count() == 1)), "Invalid identity mappings.")
    .ValidateOnStart();
builder.Services.AddOptions<ForwardedHeadersOptions>().Configure<IOptions<GatewayOptions>>((options, configured) =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.ForwardLimit = 1;
    options.KnownProxies.Clear();
    options.KnownIPNetworks.Clear();
    foreach (var proxy in configured.Value.KnownProxies) options.KnownProxies.Add(IPAddress.Parse(proxy));
});
builder.Services.AddCors();
builder.Services.AddOptions<CorsOptions>().Configure<IOptions<GatewayOptions>>((options, configured) => options.AddDefaultPolicy(policy =>
{
    if (configured.Value.CorsOrigins.Length > 0)
        policy.WithOrigins(configured.Value.CorsOrigins).WithMethods("POST", "GET", "DELETE")
            .WithHeaders("Authorization", "Content-Type");
}));

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();
builder.Services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
.Configure<IConfiguration, IHostEnvironment, LocalTokens>((options, configuration, environment, localTokens) =>
{
    var issuer = configuration["Authentication:Issuer"];
    var audience = configuration["Authentication:Audience"];
    var authority = configuration["Authentication:Authority"];
    var pem = configuration["Authentication:PublicKeyPem"];
    if (!environment.IsDevelopment() && (string.IsNullOrWhiteSpace(issuer)
        || string.IsNullOrWhiteSpace(audience) || (!localTokens.Enabled && string.IsNullOrWhiteSpace(authority) && string.IsNullOrWhiteSpace(pem))))
        throw new InvalidOperationException("Configure a JWT issuer, audience and authority or public key.");
    if (!string.IsNullOrWhiteSpace(authority) && !string.IsNullOrWhiteSpace(pem))
        throw new InvalidOperationException("Configure one JWT verification source.");
    SecurityKey? publicKey = localTokens.VerificationKey;
    if (!string.IsNullOrWhiteSpace(pem))
    {
        using var rsa = RSA.Create();
        rsa.ImportFromPem(pem);
        publicKey = new RsaSecurityKey(rsa.ExportParameters(false));
    }
    options.MapInboundClaims = false;
    options.IncludeErrorDetails = false;
    options.RequireHttpsMetadata = true;
    if (!string.IsNullOrWhiteSpace(authority)) options.Authority = authority;
    options.TokenValidationParameters = new()
    {
        ValidateIssuer = true, ValidIssuer = issuer,
        ValidateAudience = true, ValidAudience = audience,
        ValidateLifetime = true, RequireExpirationTime = true, ClockSkew = TimeSpan.FromSeconds(30),
        RequireSignedTokens = true, ValidateIssuerSigningKey = true, IssuerSigningKey = publicKey,
        ValidAlgorithms = [SecurityAlgorithms.RsaSha256], ValidTypes = ["at+jwt"]
    };
    options.Events = new()
    {
        OnTokenValidated = async context =>
        {
            // Never trust a marker arriving in a token, including externally issued tokens.
            var identity = (ClaimsIdentity)context.Principal!.Identity!;
            foreach (var claim in identity.FindAll("local_session_validated").ToArray()) identity.RemoveClaim(claim);
            if (!localTokens.Enabled) return;
            var auth = context.HttpContext.RequestServices.GetRequiredService<AuthService>();
            if (!await auth.Validate(context.Principal, context.HttpContext.Connection.RemoteIpAddress,
                context.HttpContext.RequestAborted))
            {
                context.Fail("Session is invalid.");
                return;
            }
            identity.AddClaim(new("local_session_validated", "true"));
        },
        OnChallenge = async context =>
        {
            context.HandleResponse();
            context.Response.StatusCode = 401;
            context.Response.Headers.WWWAuthenticate = "Bearer";
            await context.Response.WriteAsJsonAsync(ApiEnvelope.Error("Authentication required.", context.HttpContext.TraceIdentifier));
        },
        OnForbidden = async context =>
        {
            context.Response.StatusCode = 403;
            await context.Response.WriteAsJsonAsync(ApiEnvelope.Error("Access denied.", context.HttpContext.TraceIdentifier));
        }
    };
});
builder.Services.AddAuthorization(options => options.AddPolicy("gateway", policy => policy
    .RequireAuthenticatedUser().RequireClaim("sub")
    .RequireAssertion(context => !context.User.HasClaim("force_password_change", "true"))));
builder.Services.AddRateLimiter(options =>
{
    options.AddPolicy("login", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new() { PermitLimit = 10, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    options.RejectionStatusCode = 429;
    // Global limit per signed-in user (the token's "sub"), so an office behind one
    // shared public IP no longer shares a single budget; anonymous requests keep
    // the per-IP limit. Needs UseAuthentication() before UseRateLimiter() (below).
    // RateLimit:PerUserPerMinute / RateLimit:PerIpPerMinute in appsettings.
    var perUser = builder.Configuration.GetValue<int?>("RateLimit:PerUserPerMinute") ?? 600;
    var perIp = builder.Configuration.GetValue<int?>("RateLimit:PerIpPerMinute") ?? 120;
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var subject = context.User.Identity?.IsAuthenticated == true ? context.User.FindFirst("sub")?.Value : null;
        return string.IsNullOrEmpty(subject)
            ? RateLimitPartition.GetFixedWindowLimiter("ip:" + (context.Connection.RemoteIpAddress?.ToString() ?? "unknown"),
                _ => new() { PermitLimit = perIp, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 })
            : RateLimitPartition.GetFixedWindowLimiter("user:" + subject,
                _ => new() { PermitLimit = perUser, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 });
    });
    options.OnRejected = async (context, cancellationToken) =>
        await context.HttpContext.Response.WriteAsJsonAsync(ApiEnvelope.Error("Too many requests.",
            context.HttpContext.TraceIdentifier), cancellationToken);
});
// JSON responses compressed (Brotli, else gzip): grid results are large and
// very repetitive (field names on every row, Arabic text escaped as \uXXXX),
// typically ~8-10x smaller on the wire. MaxResultBytes still applies to the
// uncompressed size. The auth endpoints are left uncompressed (below) -- tokens
// in compressed responses are the BREACH-style case to avoid.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
    options.MimeTypes = ["application/json", "application/problem+json", "text/plain"];
});
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<IOperationPermissionStore, SqlOperationPermissionStore>();
builder.Services.AddSingleton<GatewayPolicy>();
builder.Services.AddScoped<IProcedureExecutor, SqlProcedureExecutor>();
// Attachments (/api/v2/attachments): uploads are the only large requests, so
// they alone get a bigger body limit (file size + 1 MB for the form fields).
builder.Services.AddOptions<Plus.Api.Attachments.AttachmentOptions>().BindConfiguration("Attachments");
builder.Services.AddSingleton<IVirusScanner, DefenderScanner>();
builder.Services.AddScoped<IAttachmentStore, SqlAttachmentStore>();
// Old-system files are fetched from their FileManager (Attachments:LegacyHosts only),
// never following a redirect to another address.
builder.Services.AddHttpClient(LegacyFileSource.ClientName, c => c.Timeout = TimeSpan.FromSeconds(60))
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddSingleton<ILegacyFileSource, LegacyFileSource>();
// Profile photos (/api/v2/photo): fetched from the old photo server (Photos:Hosts only),
// no redirects, short timeout.
builder.Services.AddOptions<PhotoOptions>().BindConfiguration("Photos");
builder.Services.AddHttpClient(HttpPhotoSource.ClientName, c => c.Timeout = TimeSpan.FromSeconds(15))
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddSingleton<IPhotoSource, HttpPhotoSource>();
var attachmentRequestLimit = (builder.Configuration.GetValue<long?>("Attachments:MaxFileSizeBytes")
    ?? 50L * 1024 * 1024) + 1024 * 1024;
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(o =>
    o.MultipartBodyLengthLimit = attachmentRequestLimit);
// Live channel (/api/v2/live): WebSocket "something changed" + presence.
builder.Services.AddOptions<LiveOptions>().BindConfiguration("Live")
    .Validate(x => x.MaxConnectionsPerUser is >= 1 and <= 100 && x.TicketSeconds is >= 5 and <= 300
        && x.RevalidateSeconds is >= 1 and <= 3600 && x.KeepAliveSeconds is >= 5 and <= 300
        && x.MaxMessageBytes is >= 256 and <= 65536 && x.MaxMessagesPer10Seconds is >= 1 and <= 1000
        && x.ChangePollSeconds is >= 0 and <= 300 && x.ChangeOverlap is >= 0 and <= 100000,
        "Invalid live channel limits.")
    .ValidateOnStart();
builder.Services.AddSingleton<LiveHub>();
builder.Services.AddSingleton<ILiveChangeSource, SqlLiveChangeSource>();
builder.Services.AddSingleton<LiveChangePump>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveChangePump>());
var app = builder.Build();
var gateway = app.Services.GetRequiredService<IOptions<GatewayOptions>>().Value;
// Resolve authentication options at startup so invalid production settings fail immediately.
_ = app.Services.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<JwtBearerOptions>>()
    .Get(JwtBearerDefaults.AuthenticationScheme);
// With no configured proxies, never invoke forwarding middleware (empty trust lists trust everyone).
if (gateway.KnownProxies.Length > 0) app.UseForwardedHeaders();
// outermost after forwarding, so error envelopes are compressed too; never /api/v2/auth/*
// (tokens) or /api/v2/live (WebSocket upgrade)
app.UseWhen(context => !context.Request.Path.StartsWithSegments("/api/v2/auth")
        && !context.Request.Path.StartsWithSegments("/api/v2/live"),
    branch => branch.UseResponseCompression());
app.Use(async (context, next) =>
{
    var started = Stopwatch.GetTimestamp();
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    try
    {
        if (!app.Environment.IsDevelopment() && !context.Request.IsHttps)
            throw new GatewayException(400, "HTTPS is required.");
        await next(context);
    }
    catch (Exception error) when (!context.Response.HasStarted)
    {
        var (status, message) = error switch
        {
            GatewayException known => (known.Status, known.Message),
            BadHttpRequestException bad => (bad.StatusCode, "Invalid request body."),
            SqlException sql when sql.Number == -2 => (504, "Operation timed out. Verify its outcome before retrying."),
            OperationCanceledException => (499, "Request cancelled. Verify the outcome before retrying."),
            _ => (500, "The request could not be completed. Verify the outcome before retrying.")
        };
        // Exception text can contain SQL, credentials or record values; log only a type/code.
        app.Logger.LogWarning("Request failure {TraceId} {ErrorType} {SqlNumber}", context.TraceIdentifier,
            error.GetType().Name, error is SqlException sqlError ? sqlError.Number : null);
        context.Response.StatusCode = status;
        if (!context.RequestAborted.IsCancellationRequested)
            await context.Response.WriteAsJsonAsync(ApiEnvelope.Error(message, context.TraceIdentifier));
    }
    finally
    {
        app.Logger.LogInformation("API request {TraceId} {Status} {ElapsedMs}ms {ClientIp} {Subject} {Database} {Procedure} {Operation}",
            context.TraceIdentifier, context.Response.StatusCode, Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            context.Connection.RemoteIpAddress, context.User.FindFirst("sub")?.Value,
            context.Items["database"], context.Items["procedure"], context.Items["operation"]);
    }
});
app.UseCors();
app.UseWebSockets();
app.UseAuthentication();   // before the rate limiter: it partitions by the signed-in user
app.UseRateLimiter();
app.UseAuthorization();
app.MapGet("/health/live", () => Results.Ok(new { status = "alive" }));
// Server roles, read per request: the Files API runs with Authentication:VerifyOnly
// (no token issuing -> no login/refresh/logout/password endpoints) and
// Gateway:ExecEnabled = false (attachments only). The main API has both defaults.
static RouteHandlerBuilder OnlyWhen(RouteHandlerBuilder route, Func<IConfiguration, bool> enabled) =>
    route.AddEndpointFilter(async (context, next) =>
        enabled(context.HttpContext.RequestServices.GetRequiredService<IConfiguration>())
            ? await next(context) : Results.NotFound());
static bool IssuesTokens(IConfiguration c) => !c.GetValue<bool>("Authentication:VerifyOnly");
static bool ExecEnabled(IConfiguration c) => c.GetValue<bool?>("Gateway:ExecEnabled") ?? true;
OnlyWhen(app.MapPost("/api/v2/auth/login", async (LoginRequest request, HttpContext http, AuthService auth, CancellationToken ct) =>
    Results.Ok(await auth.Login(request, http.Connection.RemoteIpAddress, ct))).RequireRateLimiting("login"), IssuesTokens);
OnlyWhen(app.MapPost("/api/v2/auth/refresh", async (RefreshRequest request, HttpContext http, AuthService auth, CancellationToken ct) =>
    Results.Ok(await auth.Refresh(request, http.Connection.RemoteIpAddress, ct))).RequireRateLimiting("login"), IssuesTokens);
OnlyWhen(app.MapPost("/api/v2/auth/logout", async (HttpContext http, AuthService auth, LiveHub live, CancellationToken ct) =>
{
    await auth.Logout(http.User, http.Connection.RemoteIpAddress, ct);
    if (Guid.TryParse(http.User.FindFirstValue("sid"), out var sessionId)) live.CloseSession(sessionId);
    return Results.NoContent();
}).RequireAuthorization(), IssuesTokens);
OnlyWhen(app.MapPost("/api/v2/auth/change-password", async (ChangePasswordRequest request, HttpContext http, AuthService auth,
    LiveHub live, CancellationToken ct) =>
{
    await auth.ChangePassword(request, http.User, http.Connection.RemoteIpAddress, ct);
    // Every session of the user ends with a password change.
    live.CloseUser(http.User.FindFirstValue("db") ?? "", http.User.FindFirstValue("erp_user") ?? "");
    return Results.Ok(new { message = "Password changed. Sign in again." });
}).RequireAuthorization().RequireRateLimiting("login"), IssuesTokens);
OnlyWhen(app.MapPost("/api/v2/exec", async (ExecRequest request, HttpContext http, GatewayPolicy policy,
    IProcedureExecutor executor, LiveChangePump changes, CancellationToken cancellationToken) =>
{
    var context = await policy.AuthorizeAsync(request, http.User, http.Connection.RemoteIpAddress, cancellationToken);
    http.Items["database"] = context.DatabaseKey;
    http.Items["procedure"] = context.Procedure;
    http.Items["operation"] = request.Operation;
    var result = await executor.ExecuteAsync(request, context, cancellationToken);
    // a send / edit / state change moved SilaHistory: tell the live channel now
    if (result.Ok) changes.Poke();
    return Results.Json(result with { TraceId = http.TraceIdentifier }, statusCode: result.Ok ? 200 : 422);
}).RequireAuthorization("gateway"), ExecEnabled);
app.MapAttachments(attachmentRequestLimit);
app.MapPhotos();
app.MapLive();
app.Run();

public partial class Program;
