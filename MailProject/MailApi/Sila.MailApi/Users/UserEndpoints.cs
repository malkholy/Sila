using Microsoft.Extensions.Options;
using Sila.MailApi.Admin;

namespace Sila.MailApi.Users;

// The signed-in user's own mailbox, read-only (MailPlan API 2 / 3). The mailbox
// is found by the token's username (MailUser.Username) -- never by anything the
// request names -- and every query is bound to it.
//   GET /mail/v1/me                                 mailbox, sync status, freshness
//   GET /mail/v1/folders                            folders with counts
//   GET /mail/v1/folders/{id}/messages?before=&take= newest first, paged
//   GET /mail/v1/messages/{id}                      one message: body, recipients, attachments
//   GET /mail/v1/search?q=&take=                    subject, sender, recipients
//   GET /mail/v1/attachments/{id}                   the file (inside: from the Mail Connector API)
public static class UserEndpoints
{
    // Types the browser may show as they are; anything else (HTML, SVG, scripts)
    // is sent as a plain download, so it can never run in the app's origin.
    private static readonly HashSet<string> ShownTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "application/pdf",
    };

    public static void MapUserMail(this WebApplication app)
    {
        var mail = app.MapGroup("/mail/v1").RequireAuthorization();

        mail.MapGet("/me", async (HttpContext http, IUserMailStore store, IOptionsMonitor<MailApiOptions> options, CancellationToken ct) =>
        {
            var (box, problem) = await MailboxAsync(http, store, options.CurrentValue, ct);
            return problem ?? Results.Ok(new
            {
                email = box!.Email,
                displayName = box.DisplayName,
                syncStatus = box.SyncStatus,
                lastSyncAt = box.LastSyncAt,
                publishedAt = box.PublishedAt,
                copy = options.CurrentValue.Role.ToString(),
            });
        });

        mail.MapGet("/folders", async (HttpContext http, IUserMailStore store, IOptionsMonitor<MailApiOptions> options, CancellationToken ct) =>
        {
            var (box, problem) = await MailboxAsync(http, store, options.CurrentValue, ct);
            return problem ?? Results.Ok(await store.FoldersAsync(box!.UserId, ct));
        });

        mail.MapGet("/folders/{folderId:long}/messages", async (long folderId, string? before, int? take, HttpContext http,
            IUserMailStore store, IOptionsMonitor<MailApiOptions> options, CancellationToken ct) =>
        {
            var (box, problem) = await MailboxAsync(http, store, options.CurrentValue, ct);
            if (problem is not null) return problem;
            if (!string.IsNullOrEmpty(before) && Cursor.Parse(before) is null) return Error(400, "Invalid page cursor.");
            return await store.MessagesAsync(box!.UserId, folderId, before, take ?? 50, ct) is { } page
                ? Results.Ok(page) : Error(404, "Folder not found.");
        });

        mail.MapGet("/messages/{messageId:long}", async (long messageId, HttpContext http, IUserMailStore store,
            IOptionsMonitor<MailApiOptions> options, CancellationToken ct) =>
        {
            var (box, problem) = await MailboxAsync(http, store, options.CurrentValue, ct);
            if (problem is not null) return problem;
            return await store.MessageAsync(box!.UserId, messageId, ct) is { } message
                ? Results.Ok(message) : Error(404, "Message not found.");
        });

        mail.MapGet("/search", async (string? q, int? take, HttpContext http, IUserMailStore store,
            IOptionsMonitor<MailApiOptions> options, CancellationToken ct) =>
        {
            var (box, problem) = await MailboxAsync(http, store, options.CurrentValue, ct);
            if (problem is not null) return problem;
            var text = q?.Trim() ?? "";
            if (text.Length is < 2 or > 100) return Error(400, "Search for 2 to 100 characters.");
            return Results.Ok(await store.SearchAsync(box!.UserId, text, take ?? 50, ct));
        });

        // Only this mailbox's attachments. The file lives in the company: the
        // internal copy fetches it through the Mail Connector API (from Exchange on
        // first open); the external copy cannot reach it yet.
        mail.MapGet("/attachments/{attachmentId:long}", async (long attachmentId, HttpContext http, IUserMailStore store,
            IConnectorClient connector, IOptionsMonitor<MailApiOptions> options, CancellationToken ct) =>
        {
            var (box, problem) = await MailboxAsync(http, store, options.CurrentValue, ct);
            if (problem is not null) return problem;
            if (await store.AttachmentAsync(box!.UserId, attachmentId, ct) is not { } attachment) return Error(404, "Attachment not found.");
            if (options.CurrentValue.Role != MailRole.Internal)
                return Error(409, "Attachments open from the company network for now.");
            var file = await connector.OpenAttachmentAsync(box.UserId, attachmentId, ct);
            if (!file.Ok) return Error(file.Status, file.Message);
            if (file.Owner is not null) http.Response.RegisterForDispose(file.Owner);
            return Results.Stream(file.Content!, ShownType(attachment.ContentType), DownloadName(attachment));
        });
    }

    // The attachment's own name, safe for a header, with .eml for an attached message.
    internal static string DownloadName(AttachmentItem attachment)
    {
        var name = new string(attachment.Name.Where(c => !char.IsControl(c) && c is not ('/' or '\\' or '"')).ToArray()).Trim();
        if (name.Length == 0) name = "attachment";
        if (string.Equals(attachment.ContentType, "message/rfc822", StringComparison.OrdinalIgnoreCase)
            && !name.EndsWith(".eml", StringComparison.OrdinalIgnoreCase)) name += ".eml";
        return name.Length > 200 ? name[..200] : name;
    }

    internal static string ShownType(string? contentType)
    {
        var type = contentType?.Split(';')[0].Trim();
        return type is not null && ShownTypes.Contains(type) ? type.ToLowerInvariant() : "application/octet-stream";
    }

    private static async Task<(Mailbox? Box, IResult? Problem)> MailboxAsync(HttpContext http, IUserMailStore store,
        MailApiOptions options, CancellationToken ct)
    {
        var username = Caller.Username(http.User, options);
        if (username is null) return (null, Error(401, "Sign in again."));
        var box = await store.FindMailboxAsync(username, ct);
        if (box is null) return (null, Error(404, "No mailbox is set up for you yet. Ask the mail admin to add it."));
        if (!box.IsEnabled) return (null, Error(403, "Your mailbox is switched off in Sila."));
        return (box, null);
    }

    private static IResult Error(int status, string message) => Results.Json(new { success = false, message }, statusCode: status);
}
