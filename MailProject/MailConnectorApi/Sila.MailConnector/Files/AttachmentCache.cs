using Microsoft.Extensions.Options;
using Sila.MailConnector.Data;
using Sila.MailConnector.Ews;

namespace Sila.MailConnector.Files;

// Attachment files (MailPlan 6.2): fetched from Exchange the first time someone
// opens one, then kept under Attachments:Root as <user>/<id / 1000>/<id>.bin and
// served from there. The file is written to a temporary name and renamed when
// complete, so a half-written file is never served. Two people opening the same
// new attachment at once may both fetch it; the second rename simply wins.
public sealed class AttachmentCache(MailStore store, EwsClient ews, IOptionsMonitor<AttachmentOptions> options,
    ILogger<AttachmentCache> log)
{
    // Exchange downloads at the same time, across all requests (Attachments:Parallel, read at start).
    private static SemaphoreSlim? gate;
    private static readonly object GateLock = new();

    public sealed record Result(int Status, string Code, string Message, string? Path = null)
    {
        public bool Ok => Path is not null;
    }

    public async Task<Result> OpenAsync(int userId, long attachmentId, CancellationToken ct)
    {
        var settings = options.CurrentValue;
        if (!settings.Configured) return new(503, "NotConfigured", "Attachments are not set up on this server (Attachments:Root).");
        var root = Path.GetFullPath(settings.Root);
        if (await store.GetAttachmentAsync(userId, attachmentId, ct) is not { } row) return new(404, "NotFound", "Attachment not found.");
        if (!row.IsEnabled) return new(403, "Disabled", "This mailbox is switched off in Sila.");
        if (row.Size > settings.MaxBytes)
            return new(413, "TooLarge", $"The attachment is larger than {settings.MaxBytes / (1024 * 1024)} MB. Open it in Outlook.");

        // Already here?
        if (row.StoredPath is { } kept && Inside(root, kept) is { } keptPath && File.Exists(keptPath))
            return new(200, "OK", "Stored.", keptPath);

        var relative = RelativePath(userId, attachmentId);
        var final = Path.Combine(root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(final)!);
        var temp = $"{final}.{Guid.NewGuid():N}.tmp";
        var waiting = Gate(settings.Parallel);
        await waiting.WaitAsync(ct);
        try
        {
            AttachmentDownload download;
            await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous))
                download = await ews.DownloadAttachmentAsync(row.SmtpAddress, row.ExchangeAttachmentId, file, settings.MaxBytes,
                    TimeSpan.FromSeconds(settings.TimeoutSeconds), ct);
            File.Move(temp, final, overwrite: true);
            await store.SetAttachmentStoredAsync(attachmentId, relative.Replace('\\', '/'), ct);
            log.LogInformation("Attachment {AttachmentID} of user {UserID} fetched ({Bytes} bytes)", attachmentId, userId, download.Bytes);
            return new(200, "OK", "Fetched.", final);
        }
        catch (EwsException error)
        {
            log.LogWarning("Attachment {AttachmentID} of user {UserID} not fetched: {Kind} {Code}", attachmentId, userId, error.Kind, error.Code);
            return error.Code == "AttachmentTooLarge"
                ? new(413, error.Code, $"{error.Message} Open it in Outlook.")
                : new(error.Kind switch { EwsErrorKind.NotFound => 404, EwsErrorKind.Throttling => 503, _ => 502 }, error.Code,
                    error.Kind == EwsErrorKind.NotFound ? "This attachment is no longer in the mailbox." : $"Exchange: {error.Message}");
        }
        finally
        {
            waiting.Release();
            TryDelete(temp);
        }
    }

    // <user>/<id / 1000>/<id>.bin: at most 1000 files per folder.
    internal static string RelativePath(int userId, long attachmentId) =>
        Path.Combine(userId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            (attachmentId / 1000).ToString(System.Globalization.CultureInfo.InvariantCulture),
            $"{attachmentId.ToString(System.Globalization.CultureInfo.InvariantCulture)}.bin");

    // A stored path only ever points inside Root.
    internal static string? Inside(string root, string relative)
    {
        var full = Path.GetFullPath(Path.Combine(root, relative));
        var prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    private static SemaphoreSlim Gate(int parallel)
    {
        lock (GateLock) return gate ??= new SemaphoreSlim(Math.Clamp(parallel, 1, 16));
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { /* left for the next clean-up */ }
        catch (UnauthorizedAccessException) { /* same */ }
    }
}
