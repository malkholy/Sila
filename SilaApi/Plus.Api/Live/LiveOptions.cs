namespace Plus.Api.Live;

// "Live" configuration section: the /api/v2/live WebSocket channel. Off unless
// Enabled is true.
public sealed class LiveOptions
{
    public bool Enabled { get; set; }
    public int MaxConnectionsPerUser { get; set; } = 10;
    // One-time tickets that open a socket; never put an access token in a URL.
    public int TicketSeconds { get; set; } = 30;
    // How often an open socket's login session is re-checked in SQL.
    public int RevalidateSeconds { get; set; } = 300;
    public int KeepAliveSeconds { get; set; } = 15;
    public int MaxMessageBytes { get; set; } = 4096;
    // Client frames allowed per 10 seconds before the socket is closed.
    public int MaxMessagesPer10Seconds { get; set; } = 20;
}
