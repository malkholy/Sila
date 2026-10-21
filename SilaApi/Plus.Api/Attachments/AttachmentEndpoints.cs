using System.Net;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Plus.Api.Attachments;

// /api/v2/attachments -- list / upload / download / delete files attached to a
// business record (EntityType + EntityKey). Files are the ERP's own
// fil.FileHistory rows: the record holds one FileID (file group) and every file
// is a FileHistory row with that FileID, so new uploads also show in the old
// system. Pls.APIPlusAttachmentOperation resolves the record and its page from
// PLS.V1AttachmentTarget and makes every permission decision; this class
// handles the bytes: allowlisted type, content check, virus scan, safe paths.
// Identity comes only from the gateway token (GatewayPolicy.ResolveCaller).
// Files stored by the old system are fetched from their own FileURL
// (ILegacyFileSource, Attachments:LegacyHosts) after the same record check.
//
// /api/v2/files/{database}/{fileName} -- the FileURL written to FileHistory, for
// the old system's screens: no login, office networks only -- the ranges an admin
// keeps in Settings > Office Networks (PLS.V1OfficeNetwork), cached for a minute.
public static partial class AttachmentEndpoints
{
    [GeneratedRegex("^[A-Za-z0-9_-]{1,50}$")]
    private static partial Regex SafeSegment();

    // <FileID>-<yyyyMMddHHmmss>-<n>.<ext>, as the SP names new files.
    [GeneratedRegex(@"^\d{1,12}-\d{14}-\d{1,6}\.[a-z0-9]{1,8}$")]
    private static partial Regex StoredName();

    // Marks a FileHistory row stored by this API; any other row is an old-system
    // file, fetched from its own FileURL.
    private const string FilesPath = "/api/v2/files/";

    // The only @User the SP accepts for GetByFileName / GetOfficeNetworks.
    private const string LanLinkUser = "__lan_link__";

    public static void MapAttachments(this WebApplication app, long maxRequestBytes)
    {
        var group = app.MapGroup("/api/v2/attachments").RequireAuthorization("gateway");

        // GET /api/v2/attachments?database=&entityType=&entityKey=
        group.MapGet("", async (string? database, string? entityType, string? entityKey,
            HttpContext http, GatewayPolicy policy, IAttachmentStore store, IOptionsMonitor<AttachmentOptions> options,
            CancellationToken ct) =>
        {
            var settings = Settings(options);   // a server without attachment storage serves none of the endpoints
            var (db, dbKey, user) = Caller(http, policy, database);
            RequireRecord(entityType, entityKey);
            var result = await store.ExecuteAsync(db, "List", user,
                new { EntityType = entityType, EntityKey = entityKey }, ct);
            Check(result);
            return Results.Ok(result.Rows.Select(row => ListItem(row, settings, dbKey)));
        });

        // POST /api/v2/attachments  multipart: database, entityType, entityKey, description, file
        group.MapPost("", async (HttpContext http, GatewayPolicy policy, IAttachmentStore store,
            IVirusScanner scanner, IOptionsMonitor<AttachmentOptions> options, ILoggerFactory logs, CancellationToken ct) =>
        {
            var settings = Settings(options);
            if (!http.Request.HasFormContentType) throw new GatewayException(400, "multipart/form-data expected.");
            var form = await http.Request.ReadFormAsync(ct);
            var (db, dbKey, user) = Caller(http, policy, form["database"].ToString());
            var entityType = form["entityType"].ToString();
            var entityKey = form["entityKey"].ToString();
            RequireRecord(entityType, entityKey);
            var description = RequireDescription(form["description"].ToString());

            var file = form.Files.GetFile("file") ?? throw new GatewayException(400, "A file is required.");
            if (file.Length <= 0) throw new GatewayException(400, "The file is empty.");
            if (file.Length > settings.MaxFileSizeBytes)
                throw new GatewayException(413, $"The file is larger than {settings.MaxFileSizeBytes / (1024 * 1024)} MB.");
            var fileName = SafeFileName(file.FileName);
            var rule = FileTypePolicy.ForExtension(Path.GetExtension(fileName))
                ?? throw new GatewayException(400, $"File type not allowed. Allowed: {FileTypePolicy.AllowedList}.");

            // Refuse before touching the disk if the caller cannot use this record's page.
            Check(await store.ExecuteAsync(db, "CheckAccess", user, new { EntityType = entityType, EntityKey = entityKey }, ct));

            Directory.CreateDirectory(settings.QuarantineRoot);
            var quarantined = Path.Combine(settings.QuarantineRoot, Guid.NewGuid().ToString("N"));
            var log = logs.CreateLogger("Attachments");
            try
            {
                // Defender's real-time protection may block the file while it is being
                // written or read back (Windows: "contains a virus"), or remove it from
                // quarantine right away -- both mean the upload is infected.
                try
                {
                    await using (var target = new FileStream(quarantined, FileMode.CreateNew, FileAccess.Write))
                        await file.CopyToAsync(target, ct);
                    if (!File.Exists(quarantined)) throw new VirusBlockedException();
                }
                catch (IOException error) when (IsVirusBlocked(error))
                {
                    throw new VirusBlockedException();
                }

                string? mismatch;
                try { mismatch = FileTypePolicy.Validate(quarantined, rule); }
                catch (Exception error) when (error is IOException io && IsVirusBlocked(io)
                                              || error is FileNotFoundException || error is UnauthorizedAccessException)
                {
                    throw new VirusBlockedException();
                }
                if (mismatch is not null)
                {
                    log.LogWarning("Upload rejected ({Reason}) user {User} ext {Ext}", mismatch, user, rule.Extension);
                    throw new GatewayException(400, $"File content does not match {rule.Extension}: {mismatch}.");
                }

                var scan = await scanner.ScanAsync(quarantined, ct);
                if (scan == ScanResult.Unavailable && !File.Exists(quarantined))
                    throw new VirusBlockedException();   // removed by real-time protection mid-scan
                if (scan == ScanResult.Threat)
                {
                    log.LogWarning("Upload rejected by virus scan, user {User} ext {Ext}", user, rule.Extension);
                    throw new GatewayException(400, "File rejected by virus scan.");
                }
                if (scan == ScanResult.Unavailable)
                {
                    if (settings.RequireVirusScan)
                        throw new GatewayException(503, "Virus scan is unavailable, so the upload was refused. Try again later.");
                    log.LogWarning("Upload accepted WITHOUT virus scan (scanner unavailable), user {User}", user);
                }

                // The SP gives the record a FileID if it has none, and adds a pending
                // FileHistory row (IsExist = 0) with the stored name.
                var inserted = await store.ExecuteAsync(db, "Insert", user, new
                {
                    EntityType = entityType, EntityKey = entityKey,
                    FileOrginalName = fileName, Extension = rule.Extension.ToLowerInvariant(),
                    FileDescription = description,
                }, ct);
                Check(inserted);
                var row = inserted.Rows.FirstOrDefault() ?? throw new GatewayException(500, "The upload could not be recorded.");
                var id = Convert.ToInt32(row.GetValueOrDefault("ID"));
                var storedName = row.GetValueOrDefault("FileName") as string ?? "";
                var created = row.GetValueOrDefault("CreatedDate") is DateTime d ? d : DateTime.Now;
                if (!StoredName().IsMatch(storedName))
                {
                    await store.ExecuteAsync(db, "CancelInsert", user, new { ID = id }, CancellationToken.None);
                    throw new GatewayException(500, "The upload could not be recorded.");
                }

                var relative = RelativePath(dbKey, created, storedName);
                var final = InsideRoot(settings.StorageRoot, relative);
                var moved = false;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(final)!);
                    File.Move(quarantined, final, overwrite: false);   // never replaces an existing file
                    moved = true;
                    var link = PublicLink(http, settings, dbKey, storedName);
                    Check(await store.ExecuteAsync(db, "SetExist", user,
                        new { ID = id, FileURL = link, FileDisplay = link + "?inline=true" }, ct));
                }
                catch
                {
                    // Remove only the file THIS upload placed there -- never a file that
                    // already existed at that path (e.g. when the move itself failed).
                    if (moved && File.Exists(final)) try { File.Delete(final); } catch { /* best effort */ }
                    await store.ExecuteAsync(db, "CancelInsert", user, new { ID = id }, CancellationToken.None);
                    throw;
                }
                return Results.Ok(new { attachmentID = id, fileID = row.GetValueOrDefault("FileID") });
            }
            catch (VirusBlockedException)
            {
                log.LogWarning("Upload blocked by real-time antivirus, user {User} ext {Ext}", user, rule.Extension);
                throw new GatewayException(400, "File rejected by virus scan.");
            }
            finally
            {
                if (File.Exists(quarantined)) try { File.Delete(quarantined); } catch { /* best effort */ }
            }
        }).WithMetadata(new RequestSizeLimitAttribute(maxRequestBytes));

        // GET /api/v2/attachments/{id}/download?database=&entityType=&entityKey=&inline=true
        group.MapGet("/{id:int}/download", async (int id, string? database, string? entityType, string? entityKey,
            bool? inline, HttpContext http, GatewayPolicy policy, IAttachmentStore store,
            ILegacyFileSource legacy, IOptionsMonitor<AttachmentOptions> options, CancellationToken ct) =>
        {
            var settings = Settings(options);
            var (db, dbKey, user) = Caller(http, policy, database);
            RequireRecord(entityType, entityKey);
            var result = await store.ExecuteAsync(db, "Get", user, new { ID = id, EntityType = entityType, EntityKey = entityKey }, ct);
            Check(result);
            var row = result.Rows.FirstOrDefault() ?? throw new GatewayException(404, "Attachment not found.");
            var displayName = SafeFileName(row.GetValueOrDefault("FileOrginalName") as string ?? $"attachment-{id}");
            if (IsOurs(row)) return Serve(http, settings, dbKey, row, displayName, inline == true);

            // Old-system file: stream it from its FileManager link.
            var upstream = await legacy.OpenAsync(row.GetValueOrDefault("FileURL") as string, ct)
                ?? throw new GatewayException(404, "The file could not be loaded from the old file server.");
            http.Response.RegisterForDispose(upstream);
            var stream = await upstream.Content.ReadAsStreamAsync(ct);
            // Type from the name against our allowlist, never the old server's header.
            var ext = Path.GetExtension(row.GetValueOrDefault("FileName") as string ?? displayName);
            return Send(http, stream, FileTypePolicy.ForExtension(ext), displayName, inline == true);
        });

        // POST /api/v2/attachments/{id}/description  JSON: database, entityType, entityKey, description
        // Edit what the document is (e.g. "Copy of PI"); same record + page check as Delete.
        group.MapPost("/{id:int}/description", async (int id, DescriptionRequest body,
            HttpContext http, GatewayPolicy policy, IAttachmentStore store, IOptionsMonitor<AttachmentOptions> options,
            CancellationToken ct) =>
        {
            Settings(options);
            var (db, _, user) = Caller(http, policy, body.Database);
            RequireRecord(body.EntityType, body.EntityKey);
            var description = RequireDescription(body.Description);
            Check(await store.ExecuteAsync(db, "UpdateDescription", user, new
            {
                ID = id, EntityType = body.EntityType, EntityKey = body.EntityKey, FileDescription = description,
            }, ct));
            return Results.Ok(new { updated = true });
        });

        // DELETE /api/v2/attachments/{id}?database=&entityType=&entityKey=
        // Soft delete (IsDeleted = 1, DeletedBy) like the old system; the file stays on disk.
        group.MapDelete("/{id:int}", async (int id, string? database, string? entityType, string? entityKey,
            HttpContext http, GatewayPolicy policy, IAttachmentStore store, IOptionsMonitor<AttachmentOptions> options,
            CancellationToken ct) =>
        {
            Settings(options);
            var (db, _, user) = Caller(http, policy, database);
            RequireRecord(entityType, entityKey);
            Check(await store.ExecuteAsync(db, "Delete", user, new { ID = id, EntityType = entityType, EntityKey = entityKey }, ct));
            return Results.Ok(new { deleted = true });
        });

        // GET /api/v2/files/{database}/{fileName}?inline=true -- the FileURL stored in
        // FileHistory. No token (the old system's screens have none), so it is served
        // only to the office networks; everyone else gets 404.
        app.MapGet("/api/v2/files/{database}/{fileName}", async (string database, string fileName, bool? inline,
            HttpContext http, IAttachmentStore store, IMemoryCache cache, IOptionsMonitor<AttachmentOptions> options,
            IOptionsMonitor<GatewayOptions> gateway, CancellationToken ct) =>
        {
            var settings = Settings(options);
            if (!SafeSegment().IsMatch(database) || !StoredName().IsMatch(fileName)
                || !gateway.CurrentValue.Databases.TryGetValue(database, out var db) || !db.Enabled
                || !await IsOfficeAsync(store, cache, db, database, http.Connection.RemoteIpAddress, ct))
                throw new GatewayException(404, "Not found.");
            var result = await store.ExecuteAsync(db, "GetByFileName", LanLinkUser, new { FileName = fileName }, ct);
            var row = result.State == 0 ? result.Rows.FirstOrDefault() : null;
            if (row is null) throw new GatewayException(404, "Not found.");
            var displayName = SafeFileName(row.GetValueOrDefault("FileOrginalName") as string ?? fileName);
            return Serve(http, settings, database, row, displayName, inline == true);
        });
    }

    // Is the caller inside one of the database's active office networks? The list
    // is read from SQL at most once a minute per database; an unreadable list or an
    // invalid entry never lets anyone in.
    private static async Task<bool> IsOfficeAsync(IAttachmentStore store, IMemoryCache cache, DatabaseOptions db,
        string dbKey, IPAddress? ip, CancellationToken ct)
    {
        if (ip is null) return false;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        var networks = await cache.GetOrCreateAsync($"office-networks:{dbKey}", async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(1);
            var result = await store.ExecuteAsync(db, "GetOfficeNetworks", LanLinkUser, new { }, ct);
            return result.State != 0 ? [] : result.Rows
                .Select(r => r.GetValueOrDefault("Cidr") as string)
                .Select(c => IPNetwork.TryParse(c, out var n) ? n : (IPNetwork?)null)
                .Where(n => n is not null).Select(n => n!.Value).ToList();
        }) ?? [];
        return networks.Any(n => n.Contains(ip));
    }

    private sealed class VirusBlockedException : Exception;

    public sealed record DescriptionRequest(string? Database, string? EntityType, string? EntityKey, string? Description);

    // Required, one line, no control characters, at most 200 characters.
    private static string RequireDescription(string? value)
    {
        var clean = new string((value ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (clean.Length == 0) throw new GatewayException(400, "A description is required (e.g. Copy of PI).");
        return clean.Length > 200 ? clean[..200] : clean;
    }

    // Win32 ERROR_VIRUS_INFECTED (225) / ERROR_VIRUS_DELETED (226), as raised when
    // real-time antivirus blocks a file operation.
    private static bool IsVirusBlocked(IOException error) =>
        (error.HResult & 0xFFFF) is 225 or 226;

    private static (DatabaseOptions Db, string Key, string User) Caller(HttpContext http, GatewayPolicy policy, string? database)
    {
        // A local-login token names its database; an external token must send one.
        var key = string.IsNullOrWhiteSpace(database) ? http.User.FindFirstValue("db") : database;
        var (db, _, user) = policy.ResolveCaller(key, http.User, http.Connection.RemoteIpAddress);
        // The key is also a storage folder name: only a configured, safe name gets here.
        if (!SafeSegment().IsMatch(key!)) throw new GatewayException(400, "Invalid database key.");
        return (db, key!, user);
    }

    private static AttachmentOptions Settings(IOptionsMonitor<AttachmentOptions> options)
    {
        var settings = options.CurrentValue;
        if (!settings.Configured) throw new GatewayException(503, "Attachments are not configured.");
        return settings;
    }

    private static void RequireRecord(string? entityType, string? entityKey)
    {
        if (entityType is null || !SafeSegment().IsMatch(entityType) || entityKey is null || !SafeSegment().IsMatch(entityKey))
            throw new GatewayException(400, "entityType and entityKey (letters, digits, _ or -) are required.");
    }

    private static void Check(AttachmentResult result)
    {
        if (result.State == 0) return;
        var status = result.State is 400 or 403 or 404 or 409 ? result.State : 500;
        throw new GatewayException(status, string.IsNullOrWhiteSpace(result.Message)
            ? "The operation was not completed." : result.Message);
    }

    private static bool IsOurs(Dictionary<string, object?> row) =>
        (row.GetValueOrDefault("FileURL") as string ?? "").Contains(FilesPath, StringComparison.OrdinalIgnoreCase)
        && StoredName().IsMatch(row.GetValueOrDefault("FileName") as string ?? "");

    // <database key>/<yyyyMMdd of CreatedDate>/<stored name>: the database folder
    // keeps two databases sharing one storage root apart; the stored name is
    // unique (it starts with the FileID) and built only from digits + the
    // allowlisted extension.
    private static string RelativePath(string dbKey, DateTime created, string storedName) =>
        Path.Combine(dbKey, created.ToString("yyyyMMdd"), storedName);

    private static string PublicLink(HttpContext http, AttachmentOptions settings, string dbKey, string storedName)
    {
        var baseUrl = string.IsNullOrWhiteSpace(settings.PublicBaseUrl)
            ? $"{http.Request.Scheme}://{http.Request.Host}" : settings.PublicBaseUrl.TrimEnd('/');
        return $"{baseUrl}{FilesPath}{Uri.EscapeDataString(dbKey)}/{storedName}";
    }

    private static object ListItem(Dictionary<string, object?> row, AttachmentOptions settings, string dbKey)
    {
        var storedName = row.GetValueOrDefault("FileName") as string ?? "";
        var ours = IsOurs(row);
        long? size = null;
        if (ours && row.GetValueOrDefault("CreatedDate") is DateTime created)
        {
            var full = Path.Combine(settings.StorageRoot, RelativePath(dbKey, created, storedName));
            try { if (File.Exists(full)) size = new FileInfo(full).Length; } catch { /* size is optional */ }
        }
        return new
        {
            attachmentID = row.GetValueOrDefault("ID"),
            fileID = row.GetValueOrDefault("FileID"),
            fileName = row.GetValueOrDefault("FileOrginalName") as string ?? storedName,
            description = row.GetValueOrDefault("FileDescription") as string ?? "",
            fileType = FileTypePolicy.ForExtension(Path.GetExtension(storedName))?.ContentType,
            legacy = !ours,   // stored by the old system; opened through this API all the same
            fileSize = size,
            createdBy = row.GetValueOrDefault("CreatedBy"),
            createdDate = row.GetValueOrDefault("CreatedDate"),
        };
    }

    private static IResult Serve(HttpContext http, AttachmentOptions settings, string dbKey,
        Dictionary<string, object?> row, string displayName, bool inline)
    {
        var storedName = row.GetValueOrDefault("FileName") as string ?? "";
        if (!StoredName().IsMatch(storedName) || row.GetValueOrDefault("CreatedDate") is not DateTime created)
            throw new GatewayException(404, "The file is missing on the server.");
        var full = InsideRoot(settings.StorageRoot, RelativePath(dbKey, created, storedName));
        if (!File.Exists(full)) throw new GatewayException(404, "The file is missing on the server.");

        return Send(http, File.OpenRead(full), FileTypePolicy.ForExtension(Path.GetExtension(full)), displayName, inline);
    }

    // Type decided by the file's extension against the allowlist; an unknown type
    // is served as a plain download, never rendered.
    private static IResult Send(HttpContext http, Stream content, FileTypeRule? rule, string displayName, bool inline)
    {
        var contentType = rule?.ContentType ?? "application/octet-stream";
        if (inline && rule?.Inline == true)
        {
            http.Response.Headers.ContentSecurityPolicy = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
            http.Response.Headers.ContentDisposition = $"inline; filename*=UTF-8''{Uri.EscapeDataString(displayName)}";
            return Results.Stream(content, contentType);
        }
        return Results.Stream(content, contentType, displayName);
    }

    // Resolve a stored relative path and refuse anything that escapes the root.
    private static string InsideRoot(string root, string relative)
    {
        var baseDir = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                      + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(baseDir, relative));
        if (string.IsNullOrWhiteSpace(relative) || !full.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase))
            throw new GatewayException(404, "The file is missing on the server.");
        return full;
    }

    // Display name only (never used on disk): no folders, no control characters.
    private static string SafeFileName(string? name)
    {
        var clean = new string(Path.GetFileName(name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (clean.Length > 200) clean = clean[^200..];
        return clean.Length == 0 ? "file" : clean;
    }
}
