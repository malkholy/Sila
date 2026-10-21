using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;

namespace Plus.Api.Live;

// Who may open a socket: issued by POST /api/v2/live/ticket for a validated
// local session, used once by GET /api/v2/live?ticket=...
public sealed record LiveTicket(string Database, string Username, Guid SessionId, DateTime ExpiresAt);

public sealed class LiveConnection(string database, string username, Guid sessionId, WebSocket socket)
{
    public Guid Id { get; } = Guid.NewGuid();
    public string Database { get; } = database;
    public string Username { get; } = username;
    public Guid SessionId { get; } = sessionId;
    public WebSocket Socket { get; } = socket;
    // WebSocket allows one send at a time.
    public SemaphoreSlim SendLock { get; } = new(1, 1);
    // Cancelled to end the connection from the server side (logout, session gone, shutdown).
    // Never disposed: it holds no timer, and a late Close() must not throw.
    public CancellationTokenSource Closing { get; } = new();
    public (WebSocketCloseStatus Status, string Reason)? CloseWith { get; set; }
}

// The open sockets of this process. Single IIS worker only: a second process
// would need a shared backplane before it could reach the other's sockets.
public sealed class LiveHub(ILogger<LiveHub> logger)
{
    public const WebSocketCloseStatus SessionEnded = (WebSocketCloseStatus)4401;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<string, LiveTicket> tickets = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Guid, LiveConnection> connections = new();
    private readonly object gate = new();

    public string IssueTicket(string database, string username, Guid sessionId, TimeSpan lifetime)
    {
        var now = DateTime.UtcNow;
        foreach (var (key, old) in tickets)
            if (old.ExpiresAt <= now) tickets.TryRemove(key, out _);
        var ticket = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
        tickets[Hash(ticket)] = new(database, username, sessionId, now.Add(lifetime));
        return ticket;
    }

    // Single use: a ticket is gone after the first attempt, valid or not.
    public LiveTicket? RedeemTicket(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket) || ticket.Length != 43
            || !tickets.TryRemove(Hash(ticket), out var found) || found.ExpiresAt <= DateTime.UtcNow) return null;
        return found;
    }

    private static string Hash(string ticket) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(ticket)));

    private static bool Same(LiveConnection c, string database, string username) =>
        c.Database == database && string.Equals(c.Username, username, StringComparison.OrdinalIgnoreCase);

    public int Count(string database, string username) => connections.Values.Count(c => Same(c, database, username));

    // Adds the connection unless the user is at the limit; reports whether this
    // is the user's first socket (they just came online).
    public bool TryAdd(LiveConnection connection, int maxPerUser, out bool cameOnline)
    {
        lock (gate)
        {
            var existing = Count(connection.Database, connection.Username);
            cameOnline = existing == 0;
            if (existing >= maxPerUser) return false;
            connections[connection.Id] = connection;
            return true;
        }
    }

    // Removes the connection; reports whether that was the user's last socket.
    public bool Remove(LiveConnection connection)
    {
        lock (gate)
        {
            if (!connections.TryRemove(connection.Id, out _)) return false;
            return Count(connection.Database, connection.Username) == 0;
        }
    }

    public string[] Online(string database) => connections.Values.Where(c => c.Database == database)
        .Select(c => c.Username).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray();

    public Task Broadcast(string database, object message, Guid? except = null) =>
        SendAll(connections.Values.Where(c => c.Database == database && c.Id != except), message);

    public Task SendToUsers(string database, IEnumerable<string> usernames, object message)
    {
        var to = new HashSet<string>(usernames, StringComparer.OrdinalIgnoreCase);
        return SendAll(connections.Values.Where(c => c.Database == database && to.Contains(c.Username)), message);
    }

    private Task SendAll(IEnumerable<LiveConnection> targets, object message)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, Json);
        return Task.WhenAll(targets.ToArray().Select(c => Send(c, bytes)));
    }

    public Task Send(LiveConnection connection, object message) =>
        Send(connection, JsonSerializer.SerializeToUtf8Bytes(message, Json));

    private async Task Send(LiveConnection connection, byte[] bytes)
    {
        if (connection.Socket.State != WebSocketState.Open || connection.Closing.IsCancellationRequested) return;
        // A client that can't take a frame in 10 s is dropped, not waited on.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            await connection.SendLock.WaitAsync(timeout.Token);
            try
            {
                if (connection.Socket.State == WebSocketState.Open)
                    await connection.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, timeout.Token);
            }
            finally { connection.SendLock.Release(); }
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            logger.LogInformation("Live send dropped {Connection} {ErrorType}", connection.Id, error.GetType().Name);
            Close(connection, WebSocketCloseStatus.PolicyViolation, "Send failed.");
        }
    }

    public void Close(LiveConnection connection, WebSocketCloseStatus status, string reason)
    {
        connection.CloseWith ??= (status, reason);
        connection.Closing.Cancel();
    }

    // Logout ends that session's sockets at once.
    public void CloseSession(Guid sessionId)
    {
        foreach (var c in connections.Values.Where(c => c.SessionId == sessionId))
            Close(c, SessionEnded, "Signed out.");
    }

    // A password change ends every session of the user.
    public void CloseUser(string database, string username)
    {
        foreach (var c in connections.Values.Where(c => Same(c, database, username)))
            Close(c, SessionEnded, "Session ended.");
    }
}
