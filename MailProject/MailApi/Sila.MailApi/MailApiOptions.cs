using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace Sila.MailApi;

// Which copy this is (MailPlan APIs 2 and 3: one program, two deployments, one
// name -- silamail.glcpaints.com -- with split DNS choosing the copy):
// Internal = inside the company, reads InternalMail; External = outside,
// reads the Mail database and receives the publisher's batches.
public enum MailRole { Internal, External }

public sealed class MailApiOptions
{
    public MailRole Role { get; set; } = MailRole.Internal;
    // The Sila login database a token must name (its "db" claim).
    public string Database { get; set; } = "SILA101";
    // Web origins allowed to call this API from a browser.
    public string[] CorsOrigins { get; set; } = [];
}

// Who may use the Mail Monitor (admin): a Sila username in Users, calling from
// AllowedNetworks -- or listed in AnyNetworkUsers too (any network, for the
// rollout). Empty AllowedNetworks and AnyNetworkUsers = nobody.
public sealed class MailAdminOptions
{
    public string[] Users { get; set; } = [];
    public string[] AllowedNetworks { get; set; } = [];
    public string[] AnyNetworkUsers { get; set; } = [];

    public bool IsAdmin(string username) => Users.Contains(username, StringComparer.OrdinalIgnoreCase);

    public bool FromAllowedPlace(string username, IPAddress? ip) =>
        AnyNetworkUsers.Contains(username, StringComparer.OrdinalIgnoreCase) || InNetworks(ip, AllowedNetworks);

    public static bool InNetworks(IPAddress? ip, IEnumerable<string> networks)
    {
        if (ip is null) return false;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return networks.Any(n => IPNetwork.TryParse(n, out var network) && network.Contains(ip));
    }
}

// The Mail Connector API.
// Internal role: Url -- where to ask it for "sync now" / "add mailbox" (on this
//   server; it must list this server's address in its Access:AllowedNetworks).
// External role: PushKey / PushNetworks -- it pushes the Mail Monitor snapshot
//   here with this key (its Monitor:PushKey), optionally only from these addresses.
public sealed class ConnectorOptions
{
    public string Url { get; set; } = "";
    public string PushKey { get; set; } = "";
    public string[] PushNetworks { get; set; } = [];

    public bool PushConfigured => PushKey.Length >= 32;

    public bool IsPushKey(string? presented) =>
        PushConfigured && presented is not null
        && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(PushKey));
}
