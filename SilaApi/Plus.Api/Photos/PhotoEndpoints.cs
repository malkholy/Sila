using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Plus.Api.Photos;

// GET /api/v2/photo?url=<PhotoURL> -- people's profile photos for the web app.
// The stored links (AttachmentHistory.FileURL, e.g.
// https://my.glcpaints.com:7007/General/ShowImage/...-Profile/108056-0.jpg)
// point at the old photo server, which browsers outside the office can't
// reach. Signed-in callers get the photo through this API instead: only a
// link to a configured host:port (Photos:Hosts) under a configured path
// (Photos:PathPrefixes) is fetched, server side, never following redirects,
// and only a JPEG / PNG / WebP image (checked by its bytes) is returned.
// Photos are cached in memory (Photos:CacheMinutes; misses for 5 minutes) and
// the browser may keep them privately for a day. No Photos:Hosts = off (404).
public sealed class PhotoOptions
{
    // host:port of the photo server, e.g. "my.glcpaints.com:7007".
    public string[] Hosts { get; set; } = [];
    // Allowed path starts on those hosts (case-insensitive).
    public string[] PathPrefixes { get; set; } = ["/General/ShowImage/"];
    // Optional: fetch from this base (e.g. "http://10.1.245.245:7007") instead of
    // the link's own scheme://host:port, when the public name doesn't resolve or
    // route from the API server. The link's path is kept.
    public string UpstreamBase { get; set; } = "";
    public int MaxBytes { get; set; } = 5 * 1024 * 1024;
    public int CacheMinutes { get; set; } = 60;
}

// The photo server, behind an interface for tests.
public interface IPhotoSource
{
    // The body (at most maxBytes), or null when the server has no such photo.
    Task<byte[]?> FetchAsync(Uri uri, int maxBytes, CancellationToken cancellationToken);
}

public sealed class HttpPhotoSource(IHttpClientFactory clients) : IPhotoSource
{
    public const string ClientName = "photos";

    public async Task<byte[]?> FetchAsync(Uri uri, int maxBytes, CancellationToken cancellationToken)
    {
        using var response = await clients.CreateClient(ClientName)
            .GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode) return null;
        if (response.Content.Headers.ContentLength > maxBytes) return null;
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > maxBytes) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }
}

public static class PhotoEndpoints
{
    private static readonly TimeSpan MissTtl = TimeSpan.FromMinutes(5);

    public static void MapPhotos(this WebApplication app)
    {
        app.MapGet("/api/v2/photo", async (string? url, HttpContext http, IPhotoSource source, IMemoryCache cache,
            IOptionsMonitor<PhotoOptions> options, CancellationToken ct) =>
        {
            var settings = options.CurrentValue;
            if (!TryResolve(url, settings, out var upstream)) throw new GatewayException(404, "Not found.");
            var key = "photo:" + upstream.AbsoluteUri;
            if (!cache.TryGetValue(key, out Photo? photo))
            {
                byte[]? bytes = null;
                try { bytes = await source.FetchAsync(upstream, settings.MaxBytes, ct); }
                catch (HttpRequestException) { /* the photo server is down: a miss */ }
                catch (TaskCanceledException) when (!ct.IsCancellationRequested) { /* timed out: a miss */ }
                photo = bytes is null || ContentType(bytes) is not { } type ? null : new Photo(bytes, type);
                cache.Set(key, photo, photo is null ? MissTtl : TimeSpan.FromMinutes(Math.Max(1, settings.CacheMinutes)));
            }
            if (photo is null) throw new GatewayException(404, "Photo not found.");
            http.Response.Headers.CacheControl = "private, max-age=86400";
            http.Response.Headers.ContentSecurityPolicy = "sandbox; default-src 'none'";
            return Results.Bytes(photo.Bytes, photo.ContentType);
        }).RequireAuthorization("gateway");
    }

    private sealed record Photo(byte[] Bytes, string ContentType);

    // An allowed photo link -> the address to fetch it from. Only http/https, no
    // user info, query or fragment, a configured host:port, a configured path
    // start, and no ".." or escaped characters in the path.
    public static bool TryResolve(string? url, PhotoOptions settings, out Uri upstream)
    {
        upstream = null!;
        if (string.IsNullOrWhiteSpace(url) || url.Length > 1000
            || !Uri.TryCreate(url, UriKind.Absolute, out var link) || link.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(link.UserInfo) || !string.IsNullOrEmpty(link.Query) || !string.IsNullOrEmpty(link.Fragment))
            return false;
        var authority = $"{link.Host}:{link.Port}";
        if (!settings.Hosts.Any(h => string.Equals(h, authority, StringComparison.OrdinalIgnoreCase))) return false;
        var path = link.AbsolutePath;
        if (path.Contains("..", StringComparison.Ordinal) || path.Contains('%') || url.Contains("..", StringComparison.Ordinal)
            || !settings.PathPrefixes.Any(p => !string.IsNullOrEmpty(p) && path.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
            return false;
        if (string.IsNullOrWhiteSpace(settings.UpstreamBase)) { upstream = link; return true; }
        if (!Uri.TryCreate(settings.UpstreamBase.TrimEnd('/') + path, UriKind.Absolute, out var mapped)
            || mapped.Scheme is not ("http" or "https")) return false;
        upstream = mapped;
        return true;
    }

    // The image type from its first bytes (never the photo server's header).
    public static string? ContentType(byte[] b)
    {
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47
            && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A) return "image/png";
        if (b.Length >= 12 && b[0] == (byte)'R' && b[1] == (byte)'I' && b[2] == (byte)'F' && b[3] == (byte)'F'
            && b[8] == (byte)'W' && b[9] == (byte)'E' && b[10] == (byte)'B' && b[11] == (byte)'P') return "image/webp";
        return null;
    }
}
