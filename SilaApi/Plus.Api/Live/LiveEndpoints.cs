using System.Net;
using System.Net.WebSockets;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using Plus.Api.Auth;

namespace Plus.Api.Live;

// /api/v2/live -- the live channel. It tells a client "something changed" and
// who is online; it never carries business data (the client then fetches what
// changed through /api/v2/exec, under the normal permission checks).
//
//   POST /api/v2/live/ticket {database}   (Bearer token, local session only)
//        -> {ticket, expiresAt}           one-time, TicketSeconds
//   GET  /api/v2/live?ticket=...          WebSocket upgrade
//
// Server -> client (JSON text frames):
//   {type:"hello", user, online:[...], serverTime}
//   {type:"presence", user, online:true|false}
//   {type:"pong"}
// Client -> server: {type:"ping"}; anything else is ignored for now.
// Close codes: 4401 session ended (sign in again), 1008 policy (too many
// frames / bad origin), 1009 frame too large, 1001 server going away.
public static class LiveEndpoints
{
    public sealed record TicketRequest(string Database);

    public static void MapLive(this WebApplication app)
    {
        static bool Enabled(HttpContext http) =>
            http.RequestServices.GetRequiredService<IOptionsMonitor<LiveOptions>>().CurrentValue.Enabled;

        app.MapPost("/api/v2/live/ticket", (TicketRequest request, HttpContext http, GatewayPolicy policy,
            LiveHub hub, IOptionsMonitor<LiveOptions> options) =>
        {
            if (!Enabled(http)) return Results.NotFound();
            var (_, _, username) = policy.ResolveCaller(request.Database, http.User, http.Connection.RemoteIpAddress);
            // Only built-in logins have a SQL session the socket can keep re-checking.
            if (!http.User.HasClaim("local_session_validated", "true")
                || !Guid.TryParse(http.User.FindFirstValue("sid"), out var sessionId))
                throw new GatewayException(403, "Live updates need a signed-in session.");
            var lifetime = TimeSpan.FromSeconds(options.CurrentValue.TicketSeconds);
            var ticket = hub.IssueTicket(request.Database, username, sessionId, lifetime);
            return Results.Ok(new { ticket, expiresAt = DateTime.UtcNow.Add(lifetime) });
        }).RequireAuthorization("gateway");

        app.MapGet("/api/v2/live", async (HttpContext http, LiveHub hub, GatewayPolicy policy,
            IOptionsMonitor<LiveOptions> liveOptions, IOptionsMonitor<GatewayOptions> gatewayOptions,
            IServiceScopeFactory scopes, IHostApplicationLifetime lifetime, ILoggerFactory loggers) =>
        {
            if (!Enabled(http)) return Results.NotFound();
            if (!http.WebSockets.IsWebSocketRequest) throw new GatewayException(400, "WebSocket upgrade required.");
            var options = liveOptions.CurrentValue;
            var gateway = gatewayOptions.CurrentValue;
            // Browsers send Origin on WebSocket requests and CORS does not apply to them:
            // a page from another site must not open a socket with a stolen ticket.
            var origin = http.Request.Headers.Origin.ToString();
            if (origin.Length > 0 && !gateway.CorsOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase))
                throw new GatewayException(403, "Origin not allowed.");
            var ticket = hub.RedeemTicket(http.Request.Query["ticket"]);
            if (ticket is null) throw new GatewayException(401, "Invalid or expired ticket.");
            if (!gateway.Databases.TryGetValue(ticket.Database, out var db) || !db.Enabled
                || (policy.Zone(http.Connection.RemoteIpAddress) == "external" && !db.AllowExternal))
                throw new GatewayException(403, "Database access denied.");
            if (hub.Count(ticket.Database, ticket.Username) >= options.MaxConnectionsPerUser)
                throw new GatewayException(429, "Too many open connections.");

            using var socket = await http.WebSockets.AcceptWebSocketAsync(new WebSocketAcceptContext
            {
                KeepAliveInterval = TimeSpan.FromSeconds(options.KeepAliveSeconds),
                KeepAliveTimeout = TimeSpan.FromSeconds(options.KeepAliveSeconds * 2)
            });
            var connection = new LiveConnection(ticket.Database, ticket.Username, ticket.SessionId, socket);
            if (!hub.TryAdd(connection, options.MaxConnectionsPerUser, out var cameOnline))
            {
                await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Too many open connections.", CancellationToken.None);
                return Results.Empty;
            }
            var logger = loggers.CreateLogger("Plus.Api.Live");
            logger.LogInformation("Live open {Connection} {Database} {User}", connection.Id, connection.Database, connection.Username);
            // Server-side end (logout, session gone, limits, shutdown): send the close
            // frame first -- cancelling a pending receive would abort the socket and
            // the client would never see the close code.
            using var stop = CancellationTokenSource.CreateLinkedTokenSource(connection.Closing.Token, lifetime.ApplicationStopping);
            Task closing = Task.CompletedTask;
            using var onStop = stop.Token.Register(() => closing = CloseFromServer(connection, lifetime));
            using var done = CancellationTokenSource.CreateLinkedTokenSource(stop.Token, http.RequestAborted);
            try
            {
                await hub.Send(connection, new
                {
                    type = "hello", user = connection.Username, online = hub.Online(connection.Database),
                    serverTime = DateTime.UtcNow
                });
                if (cameOnline)
                    await hub.Broadcast(connection.Database, new { type = "presence", user = connection.Username, online = true }, connection.Id);
                var revalidate = Revalidate(connection, hub, scopes, http.Connection.RemoteIpAddress,
                    TimeSpan.FromSeconds(options.RevalidateSeconds), logger, done.Token);
                await Receive(connection, hub, options, http.RequestAborted);
                await done.CancelAsync();
                await revalidate;
            }
            finally
            {
                if (hub.Remove(connection))
                    await hub.Broadcast(connection.Database, new { type = "presence", user = connection.Username, online = false });
                await closing;
                // Client-initiated close (or receive ended on a limit): answer it.
                await SendClose(connection, connection.CloseWith ?? (WebSocketCloseStatus.NormalClosure, ""));
                logger.LogInformation("Live close {Connection} {Status}", connection.Id,
                    (int)(connection.CloseWith?.Status ?? WebSocketCloseStatus.NormalClosure));
            }
            return Results.Empty;
        });
    }

    private static async Task CloseFromServer(LiveConnection connection, IHostApplicationLifetime lifetime)
    {
        connection.CloseWith ??= lifetime.ApplicationStopping.IsCancellationRequested
            ? (WebSocketCloseStatus.EndpointUnavailable, "Server restarting.")
            : (WebSocketCloseStatus.NormalClosure, "");
        await SendClose(connection, connection.CloseWith.Value);
        // The client answers the close frame, which ends the receive loop; if it
        // doesn't within 5 s, drop the connection.
        _ = AbortIfNoReply(connection.Socket);
    }

    private static async Task AbortIfNoReply(WebSocket socket)
    {
        await Task.Delay(TimeSpan.FromSeconds(5));
        try { if (socket.State is not (WebSocketState.Closed or WebSocketState.Aborted)) socket.Abort(); }
        catch (ObjectDisposedException) { }
    }

    private static async Task SendClose(LiveConnection connection, (WebSocketCloseStatus Status, string Reason) close)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            await connection.SendLock.WaitAsync(timeout.Token);
            try
            {
                if (connection.Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await connection.Socket.CloseOutputAsync(close.Status, close.Reason, timeout.Token);
            }
            finally { connection.SendLock.Release(); }
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or ObjectDisposedException) { }
    }

    private static async Task Receive(LiveConnection connection, LiveHub hub, LiveOptions options, CancellationToken stop)
    {
        var buffer = new byte[options.MaxMessageBytes];
        var window = DateTime.UtcNow;
        var count = 0;
        try
        {
            while (connection.Socket.State == WebSocketState.Open)
            {
                var length = 0;
                ValueWebSocketReceiveResult result;
                do
                {
                    if (length == buffer.Length)
                    {
                        hub.Close(connection, WebSocketCloseStatus.MessageTooBig, "Message too large.");
                        return;
                    }
                    result = await connection.Socket.ReceiveAsync(buffer.AsMemory(length), stop);
                    length += result.Count;
                } while (!result.EndOfMessage && result.MessageType != WebSocketMessageType.Close);
                if (result.MessageType == WebSocketMessageType.Close) return;

                if (DateTime.UtcNow - window > TimeSpan.FromSeconds(10)) { window = DateTime.UtcNow; count = 0; }
                if (++count > options.MaxMessagesPer10Seconds)
                {
                    hub.Close(connection, WebSocketCloseStatus.PolicyViolation, "Too many messages.");
                    return;
                }
                if (result.MessageType != WebSocketMessageType.Text) continue;
                string? type = null;
                try
                {
                    using var json = JsonDocument.Parse(buffer.AsMemory(0, length));
                    if (json.RootElement.ValueKind == JsonValueKind.Object
                        && json.RootElement.TryGetProperty("type", out var value) && value.ValueKind == JsonValueKind.String)
                        type = value.GetString();
                }
                catch (JsonException) { }
                if (type == "ping") await hub.Send(connection, new { type = "pong" });
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
    }

    // The socket outlives its 5-minute access token: re-check the login session
    // in SQL on a timer, and end the socket when it is gone.
    private static async Task Revalidate(LiveConnection connection, LiveHub hub, IServiceScopeFactory scopes,
        IPAddress? ip, TimeSpan every, ILogger logger, CancellationToken stop)
    {
        using var timer = new PeriodicTimer(every);
        try
        {
            while (await timer.WaitForNextTickAsync(stop))
            {
                AuthIdentity? identity;
                try
                {
                    await using var scope = scopes.CreateAsyncScope();
                    identity = await scope.ServiceProvider.GetRequiredService<AuthService>()
                        .ValidateSession(connection.Database, connection.SessionId, ip, stop);
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    // Can't confirm the session: fail closed, the client reconnects with a new ticket.
                    logger.LogWarning("Live revalidation failed {Connection} {ErrorType}", connection.Id, error.GetType().Name);
                    identity = null;
                }
                if (identity is null || !string.Equals(identity.Username, connection.Username, StringComparison.OrdinalIgnoreCase))
                {
                    hub.Close(connection, LiveHub.SessionEnded, "Session ended.");
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }
}
