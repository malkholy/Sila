using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace Sila.MailApi;

// Sync: who may send publish batches -- only the Mail Connector API inside the
// company. Key: shared with its Publish:Key (at least 32 characters); empty =
// the sync endpoints are off. AllowedNetworks: the company's public address(es);
// empty = any address with the key.
public sealed class SyncOptions
{
    public string Key { get; set; } = "";
    public string[] AllowedNetworks { get; set; } = [];

    public bool Configured => Key.Length >= 32;

    public bool IsAllowed(IPAddress? ip)
    {
        if (AllowedNetworks.Length == 0) return true;
        if (ip is null) return false;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return AllowedNetworks.Any(n => IPNetwork.TryParse(n, out var network) && network.Contains(ip));
    }

    public bool IsKey(string? presented) =>
        Configured && presented is not null
        && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(Key));
}
