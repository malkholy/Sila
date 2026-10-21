using Microsoft.Extensions.Options;

namespace Plus.Api.Attachments;

// Files stored by the old system: fil.FileHistory rows whose FileURL points at
// the old FileManager (e.g. http://10.1.245.245:7001/FileManager/Local/Download?...).
// The Files API fetches them server side -- after the same record check as its
// own files -- so the browser never needs the plain-http office-only link.
public interface ILegacyFileSource
{
    // null = not an allowed old-system link, or the old server did not return the file.
    Task<HttpResponseMessage?> OpenAsync(string? fileUrl, CancellationToken cancellationToken);
}

public sealed class LegacyFileSource(IHttpClientFactory clients, IOptionsMonitor<AttachmentOptions> options)
    : ILegacyFileSource
{
    public const string ClientName = "legacy-files";

    public async Task<HttpResponseMessage?> OpenAsync(string? fileUrl, CancellationToken cancellationToken)
    {
        if (!IsAllowed(fileUrl, options.CurrentValue.LegacyHosts, out var uri)) return null;
        var response = await clients.CreateClient(ClientName)
            .GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.IsSuccessStatusCode) return response;
        response.Dispose();
        return null;
    }

    // Only http/https to a configured host:port (Attachments:LegacyHosts) -- never
    // any other address a FileHistory row might hold.
    public static bool IsAllowed(string? fileUrl, IEnumerable<string> hosts, out Uri uri)
    {
        uri = null!;
        if (!Uri.TryCreate(fileUrl, UriKind.Absolute, out var parsed) || parsed.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(parsed.UserInfo)) return false;
        var authority = $"{parsed.Host}:{parsed.Port}";
        if (!hosts.Any(h => string.Equals(h, authority, StringComparison.OrdinalIgnoreCase))) return false;
        uri = parsed;
        return true;
    }
}
