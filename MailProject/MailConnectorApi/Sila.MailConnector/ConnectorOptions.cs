using System.Net;

namespace Sila.MailConnector;

// Exchange: how API 1 reaches EWS. One service account with the
// ApplicationImpersonation role (scoped to Sila users) signs in for every
// mailbox; user passwords are never stored. The password comes from
// appsettings.Exchange.local.json or an environment variable on the server.
public sealed class ExchangeOptions
{
    // The internal EWS address, e.g. https://mail.glcpaints.local/EWS/Exchange.asmx
    public string EwsUrl { get; set; } = "";
    public string Domain { get; set; } = "";
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    // Windows sign-in methods, in order. A domain-joined server uses Negotiate
    // (Kerberos); a machine off the domain (e.g. a Mac for testing) needs NTLM only.
    // Empty = Negotiate, then NTLM. (Array defaults stay empty: configuration adds
    // its items to a default array instead of replacing it.)
    public string[] AuthSchemes { get; set; } = [];
    public string[] Schemes => AuthSchemes.Length == 0 ? WindowsSchemes : AuthSchemes.Distinct().ToArray();
    // Exchange2013_SP1 is the newest schema on-prem 2016 / 2019 / SE all accept.
    public string RequestServerVersion { get; set; } = "Exchange2013_SP1";
    // Mailboxes outside these domains are refused before Exchange is called.
    public string[] AllowedDomains { get; set; } = [];
    public int TimeoutSeconds { get; set; } = 60;
    public int MaxResponseBytes { get; set; } = 16 * 1024 * 1024;

    public static readonly string[] Versions = ["Exchange2013", "Exchange2013_SP1", "Exchange2016"];
    public static readonly string[] WindowsSchemes = ["Negotiate", "NTLM"];

    public bool Configured => !string.IsNullOrWhiteSpace(EwsUrl)
        && !string.IsNullOrWhiteSpace(Username) && !string.IsNullOrWhiteSpace(Password);
}

// Access: API 1 is never published to users. Only the Sila servers' addresses
// may call it; everyone else gets 404. (Client certificates come with API 2 / 3.)
public sealed class AccessOptions
{
    // Set in appsettings.json (localhost); empty here, so a server's list replaces it.
    public string[] AllowedNetworks { get; set; } = [];

    public static bool IsAllowed(IPAddress? ip, AccessOptions options)
    {
        if (ip is null) return false;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return options.AllowedNetworks.Any(n => IPNetwork.TryParse(n, out var network) && network.Contains(ip));
    }
}

// Monitor: the Mail Monitor's figures are pushed out to SilaApi (hosted outside
// the company), which keeps the latest and serves the System Settings screen.
// Nothing calls in. Empty PushUrl = off.
public sealed class MonitorOptions
{
    // e.g. https://sila.glcpaints.com:7400/api/v2/mail/monitor/push
    public string PushUrl { get; set; } = "";
    // The same key as SilaApi's MailAdmin:ConnectorKey (at least 32 characters).
    public string PushKey { get; set; } = "";
    public int IntervalSeconds { get; set; } = 15;

    public bool Configured => !string.IsNullOrWhiteSpace(PushUrl) && PushKey.Length >= 32;
}

// Publish: the copy of InternalMail to the external Mail database (MailPlan
// 2.2), through the Mail External API outside the company. Empty Url = off:
// no mail leaves the company until this is set (needs management / IT
// security approval -- MailPlan 4).
public sealed class PublishOptions
{
    // e.g. https://sila.glcpaints.com:7700/sync/v1
    public string Url { get; set; } = "";
    // The same key as the Mail External API's Sync:Key (at least 32 characters).
    public string Key { get; set; } = "";
    // Changes per batch, and the most a batch may weigh before compression.
    public int BatchChanges { get; set; } = 500;
    public int MaxBatchBytes { get; set; } = 8 * 1024 * 1024;
    // When nothing waits, how often to look again.
    public int IdleSeconds { get; set; } = 3;

    public bool Configured => !string.IsNullOrWhiteSpace(Url) && Key.Length >= 32;
}
