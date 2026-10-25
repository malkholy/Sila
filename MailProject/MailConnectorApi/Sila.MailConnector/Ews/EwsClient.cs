using System.Globalization;
using System.Net;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Extensions.Options;

namespace Sila.MailConnector.Ews;

// What went wrong, in the Mail Sync Monitor's error types (MailPlan 6.3).
public enum EwsErrorKind { Authentication, Permission, Throttling, Connection, NotFound, InvalidSyncState, Other }

public sealed class EwsException(EwsErrorKind kind, string code, string message, int? backOffMilliseconds = null)
    : Exception(message)
{
    public EwsErrorKind Kind { get; } = kind;
    public string Code { get; } = code;
    public int? BackOffMilliseconds { get; } = backOffMilliseconds;
}

public enum EwsChange { Create, Update, Delete, ReadFlagChange }

public sealed record FolderInfo(string Id, string ChangeKey, string DisplayName, int TotalCount, int UnreadCount);

// One folder from SyncFolderHierarchy. IsMail: a mail folder (not calendar,
// contacts, tasks or a search folder) -- only those are copied.
public sealed record FolderChange(EwsChange Change, string Id, string? ChangeKey, string? ParentId,
    string? DisplayName, int TotalCount, int UnreadCount, bool IsMail);

public sealed record HierarchyPage(string SyncState, bool IncludesLast, IReadOnlyList<FolderChange> Changes);

public sealed record ItemChange(EwsChange Change, string ItemId, string? ChangeKey, bool? IsRead);

public sealed record ItemPage(string SyncState, bool IncludesLast, IReadOnlyList<ItemChange> Changes);

public sealed record MailRecipientInfo(byte Type, string? Name, string? Address);   // 1 To, 2 Cc, 3 Bcc

// The list fields of one message. Dates are UTC.
public sealed record MailItem(string ItemId, string ChangeKey, string? Subject, string? FromName, string? FromAddress,
    DateTime? SentAt, DateTime ReceivedAt, bool IsRead, byte FlagStatus, byte Importance, bool HasAttachments,
    bool IsDraft, string? Preview, string? InternetMessageId, string? ConversationId, IReadOnlyList<MailRecipientInfo> Recipients);

public sealed record ItemFailure(string ItemId, string Code, string Message);

public sealed record MailAttachmentInfo(string AttachmentId, string Name, string? ContentType, long? Size, bool IsInline, string? ContentId);

// A message's body as Exchange sends it (HTML filtered by Exchange, not yet by
// us), its plain-text form, and its attachments' details (no file content).
public sealed record MailBody(string ItemId, string? Html, string? Text, IReadOnlyList<MailAttachmentInfo> Attachments);

// A thin EWS (SOAP) client over HttpClient, signed in as the service account and
// impersonating one mailbox per call. Requests are built with XDocument (every
// value escaped) from fixed shapes; nothing from a caller becomes XML markup.
// Read-only by design: sending lives only in the Send worker (MailPlan 7.1), so
// this client has no send method.
public sealed class EwsClient(HttpClient http, IOptionsMonitor<ExchangeOptions> options)
{
    private static readonly XNamespace Soap = "http://schemas.xmlsoap.org/soap/envelope/";
    private static readonly XNamespace T = "http://schemas.microsoft.com/exchange/services/2006/types";
    private static readonly XNamespace M = "http://schemas.microsoft.com/exchange/services/2006/messages";

    // Well-known folders a caller may name.
    public static readonly HashSet<string> DistinguishedFolders = new(StringComparer.Ordinal)
    {
        "inbox", "sentitems", "drafts", "deleteditems", "junkemail", "outbox", "msgfolderroot", "archivemsgfolderroot",
    };

    // Item element names that are messages (a mail folder may also hold posts, reports ...).
    private static readonly HashSet<string> MessageElements = new(StringComparer.Ordinal)
    {
        "Message", "MeetingRequest", "MeetingResponse", "MeetingCancellation", "MeetingMessage",
    };

    private static readonly string[] ItemFields =
    [
        "item:Subject", "item:DateTimeSent", "item:DateTimeReceived", "item:Importance", "item:HasAttachments",
        "item:IsDraft", "item:Preview", "item:ConversationId", "item:Flag", "message:From", "message:IsRead",
        "message:InternetMessageId", "message:ToRecipients", "message:CcRecipients", "message:BccRecipients",
    ];

    private static readonly string[] FolderFields =
        ["folder:DisplayName", "folder:ParentFolderId", "folder:FolderClass", "folder:TotalCount", "folder:UnreadCount"];

    // Windows sign-in (Kerberos, else NTLM) only -- never Basic, so the password never crosses the wire.
    public static SocketsHttpHandler CreateHandler(ExchangeOptions settings)
    {
        var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false };
        if (settings.Configured && Uri.TryCreate(settings.EwsUrl, UriKind.Absolute, out var uri))
        {
            var credential = new NetworkCredential(settings.Username, settings.Password, settings.Domain);
            var cache = new CredentialCache();
            foreach (var scheme in settings.Schemes) cache.Add(uri, scheme, credential);
            handler.Credentials = cache;
        }
        return handler;
    }

    // One well-known folder of the mailbox: its ID and counts.
    public async Task<FolderInfo> GetFolderAsync(string mailbox, string distinguishedId, CancellationToken ct)
    {
        if (!DistinguishedFolders.Contains(distinguishedId))
            throw new ArgumentOutOfRangeException(nameof(distinguishedId));
        var results = await GetFoldersAsync(mailbox, [Distinguished(distinguishedId, mailbox)], ct);
        return results[0] ?? throw new EwsException(EwsErrorKind.NotFound, "ErrorFolderNotFound", "Exchange returned no folder.");
    }

    // The IDs of the well-known folders the mailbox has (one call); a folder it lacks is left out.
    public async Task<Dictionary<string, string>> GetDistinguishedIdsAsync(string mailbox, IReadOnlyList<string> names, CancellationToken ct)
    {
        if (names.Any(n => !DistinguishedFolders.Contains(n))) throw new ArgumentOutOfRangeException(nameof(names));
        var results = await GetFoldersAsync(mailbox, names.Select(n => Distinguished(n, mailbox)).ToList(), ct);
        var ids = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < names.Count; i++)
            if (results[i] is { } folder) ids[names[i]] = folder.Id;
        return ids;
    }

    // Current counts of folders by Exchange ID; null where a folder is gone.
    public Task<IReadOnlyList<FolderInfo?>> GetFoldersByIdAsync(string mailbox, IReadOnlyList<string> folderIds, CancellationToken ct) =>
        GetFoldersAsync(mailbox, folderIds.Select(id => new XElement(T + "FolderId", new XAttribute("Id", id))).ToList(), ct);

    // One page of the mail folder tree under msgfolderroot since syncState (null: from the start).
    public async Task<HierarchyPage> SyncFolderHierarchyAsync(string mailbox, string? syncState, CancellationToken ct)
    {
        var body = new XElement(M + "SyncFolderHierarchy",
            new XElement(M + "FolderShape", new XElement(T + "BaseShape", "IdOnly"), Fields(FolderFields)),
            new XElement(M + "SyncFolderId", Distinguished("msgfolderroot", mailbox)),
            string.IsNullOrEmpty(syncState) ? null : new XElement(M + "SyncState", syncState));
        var message = Single(await SendAsync(mailbox, body, ct));
        var changes = new List<FolderChange>();
        foreach (var change in message.Element(M + "Changes")?.Elements() ?? [])
        {
            var kind = ChangeKind(change.Name.LocalName);
            if (kind is null) continue;
            if (kind == EwsChange.Delete)
            {
                var deleted = change.Element(T + "FolderId");
                if (deleted is not null) changes.Add(new FolderChange(EwsChange.Delete, (string?)deleted.Attribute("Id") ?? "", null, null, null, 0, 0, false));
                continue;
            }
            var folder = change.Elements().FirstOrDefault();
            var id = folder?.Element(T + "FolderId");
            if (folder is null || id is null) continue;
            var folderClass = (string?)folder.Element(T + "FolderClass");
            changes.Add(new FolderChange(kind.Value, (string?)id.Attribute("Id") ?? "", (string?)id.Attribute("ChangeKey"),
                (string?)folder.Element(T + "ParentFolderId")?.Attribute("Id"),
                (string?)folder.Element(T + "DisplayName"),
                ParseInt(folder.Element(T + "TotalCount")), ParseInt(folder.Element(T + "UnreadCount")),
                folder.Name.LocalName == "Folder" && (folderClass is null || folderClass.StartsWith("IPF.Note", StringComparison.Ordinal))));
        }
        return new HierarchyPage((string?)message.Element(M + "SyncState") ?? "",
            ParseBool(message.Element(M + "IncludesLastFolderInRange")), changes);
    }

    // One page (at most maxChanges) of a folder's item changes since syncState (null: from the start).
    public async Task<ItemPage> SyncFolderItemsAsync(string mailbox, string folderId, string? syncState, int maxChanges, CancellationToken ct)
    {
        var body = new XElement(M + "SyncFolderItems",
            new XElement(M + "ItemShape", new XElement(T + "BaseShape", "IdOnly")),
            new XElement(M + "SyncFolderId", new XElement(T + "FolderId", new XAttribute("Id", folderId))),
            string.IsNullOrEmpty(syncState) ? null : new XElement(M + "SyncState", syncState),
            new XElement(M + "MaxChangesReturned", Math.Clamp(maxChanges, 1, 512)),
            new XElement(M + "SyncScope", "NormalItems"));
        var message = Single(await SendAsync(mailbox, body, ct));
        var changes = new List<ItemChange>();
        foreach (var change in message.Element(M + "Changes")?.Elements() ?? [])
        {
            var kind = ChangeKind(change.Name.LocalName);
            if (kind is null) continue;
            var id = kind is EwsChange.Delete or EwsChange.ReadFlagChange
                ? change.Element(T + "ItemId")
                : change.Elements().FirstOrDefault()?.Element(T + "ItemId");
            if (id is null) continue;
            // A new item that is not a message (post, report ...) is not copied.
            if (kind is EwsChange.Create or EwsChange.Update && !MessageElements.Contains(change.Elements().First().Name.LocalName)) continue;
            changes.Add(new ItemChange(kind.Value, (string?)id.Attribute("Id") ?? "", (string?)id.Attribute("ChangeKey"),
                kind == EwsChange.ReadFlagChange ? ParseBool(change.Element(T + "IsRead")) : null));
        }
        return new ItemPage((string?)message.Element(M + "SyncState") ?? "",
            ParseBool(message.Element(M + "IncludesLastItemInRange")), changes);
    }

    // The list fields of up to a few hundred messages; an item Exchange cannot
    // return (gone, corrupt) is reported in Failures instead of failing the batch.
    public async Task<(List<MailItem> Items, List<ItemFailure> Failures)> GetItemsAsync(string mailbox, IReadOnlyList<string> itemIds, CancellationToken ct)
    {
        var items = new List<MailItem>();
        var failures = new List<ItemFailure>();
        if (itemIds.Count == 0) return (items, failures);
        var body = new XElement(M + "GetItem",
            new XElement(M + "ItemShape", new XElement(T + "BaseShape", "IdOnly"), Fields(ItemFields)),
            new XElement(M + "ItemIds", itemIds.Select(id => new XElement(T + "ItemId", new XAttribute("Id", id)))));
        var messages = Messages(await SendAsync(mailbox, body, ct));
        // Exchange answers in request order, one response message per item.
        for (var i = 0; i < messages.Count && i < itemIds.Count; i++)
        {
            var message = messages[i];
            if ((string?)message.Attribute("ResponseClass") == "Error")
            {
                var code = (string?)message.Element(M + "ResponseCode") ?? "Unknown";
                failures.Add(new ItemFailure(itemIds[i], code, (string?)message.Element(M + "MessageText") ?? code));
                continue;
            }
            var item = message.Element(M + "Items")?.Elements().FirstOrDefault();
            if (item is not null && ParseItem(item) is { } parsed) items.Add(parsed);
        }
        return (items, failures);
    }

    // Bodies and attachment details of a few messages. Exchange's own HTML filter
    // (FilterHtmlContent) runs first; ours runs before anything is stored.
    public async Task<(List<MailBody> Bodies, List<ItemFailure> Failures)> GetBodiesAsync(string mailbox, IReadOnlyList<string> itemIds, CancellationToken ct)
    {
        var bodies = new List<MailBody>();
        var failures = new List<ItemFailure>();
        if (itemIds.Count == 0) return (bodies, failures);
        var body = new XElement(M + "GetItem",
            new XElement(M + "ItemShape",
                new XElement(T + "BaseShape", "IdOnly"),
                new XElement(T + "BodyType", "HTML"),
                new XElement(T + "FilterHtmlContent", "true"),
                Fields(["item:Body", "item:TextBody", "item:Attachments"])),
            new XElement(M + "ItemIds", itemIds.Select(id => new XElement(T + "ItemId", new XAttribute("Id", id)))));
        var messages = Messages(await SendAsync(mailbox, body, ct));
        for (var i = 0; i < messages.Count && i < itemIds.Count; i++)
        {
            var message = messages[i];
            if ((string?)message.Attribute("ResponseClass") == "Error")
            {
                var code = (string?)message.Element(M + "ResponseCode") ?? "Unknown";
                failures.Add(new ItemFailure(itemIds[i], code, (string?)message.Element(M + "MessageText") ?? code));
                continue;
            }
            if (message.Element(M + "Items")?.Elements().FirstOrDefault() is { } item)
                bodies.Add(ParseBody(itemIds[i], item));
        }
        return (bodies, failures);
    }

    internal static MailBody ParseBody(string itemId, XElement item)
    {
        var attachments = new List<MailAttachmentInfo>();
        foreach (var attachment in item.Element(T + "Attachments")?.Elements() ?? [])
        {
            var id = (string?)attachment.Element(T + "AttachmentId")?.Attribute("Id");
            if (id is null) continue;
            attachments.Add(new MailAttachmentInfo(id,
                Cut((string?)attachment.Element(T + "Name"), 255) ?? "attachment",
                Cut((string?)attachment.Element(T + "ContentType")
                    ?? (attachment.Name.LocalName == "ItemAttachment" ? "message/rfc822" : null), 255),
                long.TryParse((string?)attachment.Element(T + "Size"), out var size) ? size : null,
                ParseBool(attachment.Element(T + "IsInline")),
                Cut((string?)attachment.Element(T + "ContentId"), 255)));
        }
        var html = item.Element(T + "Body");
        return new MailBody(itemId,
            (string?)html?.Attribute("BodyType") == "Text" ? null : (string?)html,
            (string?)item.Element(T + "TextBody"),
            attachments);
    }

    internal static MailItem? ParseItem(XElement item)
    {
        var id = item.Element(T + "ItemId");
        var received = ParseDate(item.Element(T + "DateTimeReceived"));
        if (id is null || received is null) return null;
        var from = item.Element(T + "From")?.Element(T + "Mailbox");
        var recipients = new List<MailRecipientInfo>();
        foreach (var (name, type) in new[] { ("ToRecipients", (byte)1), ("CcRecipients", (byte)2), ("BccRecipients", (byte)3) })
            foreach (var mailbox in item.Element(T + name)?.Elements(T + "Mailbox") ?? [])
                recipients.Add(new MailRecipientInfo(type, Cut((string?)mailbox.Element(T + "Name"), 320),
                    Cut((string?)mailbox.Element(T + "EmailAddress"), 320)));
        return new MailItem(
            (string?)id.Attribute("Id") ?? "",
            (string?)id.Attribute("ChangeKey") ?? "",
            Cut((string?)item.Element(T + "Subject"), 1000),
            Cut((string?)from?.Element(T + "Name"), 320),
            Cut((string?)from?.Element(T + "EmailAddress"), 320),
            ParseDate(item.Element(T + "DateTimeSent")),
            received.Value,
            ParseBool(item.Element(T + "IsRead")),
            (string?)item.Element(T + "Flag")?.Element(T + "FlagStatus") switch { "Flagged" => 1, "Complete" => 2, _ => 0 },
            (string?)item.Element(T + "Importance") switch { "Low" => 0, "High" => 2, _ => 1 },
            ParseBool(item.Element(T + "HasAttachments")),
            ParseBool(item.Element(T + "IsDraft")),
            Cut((string?)item.Element(T + "Preview"), 400),
            Cut((string?)item.Element(T + "InternetMessageId"), 500),
            Cut((string?)item.Element(T + "ConversationId")?.Attribute("Id"), 512),
            recipients);
    }

    internal static string BuildEnvelope(string version, string mailbox, XElement body) =>
        new XElement(Soap + "Envelope",
            new XAttribute(XNamespace.Xmlns + "soap", Soap),
            new XAttribute(XNamespace.Xmlns + "t", T),
            new XAttribute(XNamespace.Xmlns + "m", M),
            new XElement(Soap + "Header",
                new XElement(T + "RequestServerVersion", new XAttribute("Version", version)),
                new XElement(T + "ExchangeImpersonation",
                    new XElement(T + "ConnectingSID", new XElement(T + "SmtpAddress", mailbox)))),
            new XElement(Soap + "Body", body)).ToString(SaveOptions.DisableFormatting);

    private async Task<IReadOnlyList<FolderInfo?>> GetFoldersAsync(string mailbox, IReadOnlyList<XElement> folderIds, CancellationToken ct)
    {
        var body = new XElement(M + "GetFolder",
            new XElement(M + "FolderShape", new XElement(T + "BaseShape", "Default")),
            new XElement(M + "FolderIds", folderIds));
        var messages = Messages(await SendAsync(mailbox, body, ct));
        var results = new FolderInfo?[folderIds.Count];
        for (var i = 0; i < messages.Count && i < results.Length; i++)
        {
            var message = messages[i];
            if ((string?)message.Attribute("ResponseClass") == "Error")
            {
                var code = (string?)message.Element(M + "ResponseCode") ?? "Unknown";
                // A missing folder is an answer; anything else (permission, mailbox) fails the call.
                if (code is "ErrorFolderNotFound" or "ErrorItemNotFound") continue;
                throw new EwsException(Classify(code), code, (string?)message.Element(M + "MessageText") ?? code, BackOff(message));
            }
            var folder = message.Descendants().FirstOrDefault(e => e.Name.Namespace == T && e.Element(T + "FolderId") is not null);
            if (folder is null) continue;
            var id = folder.Element(T + "FolderId")!;
            results[i] = new FolderInfo(
                (string?)id.Attribute("Id") ?? "",
                (string?)id.Attribute("ChangeKey") ?? "",
                (string?)folder.Element(T + "DisplayName") ?? "",
                ParseInt(folder.Element(T + "TotalCount")),
                ParseInt(folder.Element(T + "UnreadCount")));
        }
        return results;
    }

    private async Task<XDocument> SendAsync(string mailbox, XElement body, CancellationToken ct)
    {
        var settings = options.CurrentValue;
        if (!settings.Configured) throw new EwsException(EwsErrorKind.Other, "NotConfigured", "Exchange is not configured.");
        using var request = new HttpRequestMessage(HttpMethod.Post, settings.EwsUrl)
        {
            Content = new StringContent(BuildEnvelope(settings.RequestServerVersion, mailbox, body), Encoding.UTF8, "text/xml"),
        };
        // Route the call to the server that holds the mailbox (Microsoft's guidance for impersonation).
        request.Headers.TryAddWithoutValidation("X-AnchorMailbox", mailbox);
        request.Headers.TryAddWithoutValidation("X-PreferServerAffinity", "true");

        // One time limit for the call and reading its answer (the body is read after the headers).
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(settings.TimeoutSeconds));
        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        }
        catch (HttpRequestException)
        {
            throw new EwsException(EwsErrorKind.Connection, "Unreachable", "Exchange could not be reached.");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new EwsException(EwsErrorKind.Connection, "Timeout", "Exchange did not answer in time.");
        }

        using (response)
        {
            string text;
            try
            {
                text = await ReadLimitedAsync(response.Content, settings.MaxResponseBytes, timeout.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new EwsException(EwsErrorKind.Connection, "Timeout", "Exchange did not finish its answer in time.");
            }
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                throw new EwsException(EwsErrorKind.Authentication, "Unauthorized", "Exchange refused the service account's sign-in.");
            if (response.StatusCode == HttpStatusCode.Forbidden)
                throw new EwsException(EwsErrorKind.Permission, "Forbidden", "Exchange refused the request (is EWS allowed for the service account?).");
            if (response.StatusCode == HttpStatusCode.ServiceUnavailable)
                throw new EwsException(EwsErrorKind.Connection, "Unavailable", "Exchange is unavailable.");

            var document = Parse(text);
            if (document?.Root?.Element(Soap + "Body")?.Element(Soap + "Fault") is { } fault)
                throw Fault(fault);
            if (document is null || !response.IsSuccessStatusCode)
                throw new EwsException(EwsErrorKind.Other, $"Http{(int)response.StatusCode}", "Exchange returned an unexpected answer.");
            return document;
        }
    }

    // The answer as text, refused past the limit (one huge message must not take
    // the service's memory, and must not look like a lost connection).
    private static async Task<string> ReadLimitedAsync(HttpContent content, int maxBytes, CancellationToken ct)
    {
        if (content.Headers.ContentLength > maxBytes) throw TooLarge();
        await using var stream = await content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        try
        {
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                if (buffer.Length + read > maxBytes) throw TooLarge();
                buffer.Write(chunk, 0, read);
            }
        }
        catch (IOException)
        {
            throw new EwsException(EwsErrorKind.Connection, "Interrupted", "The answer from Exchange was cut off.");
        }
        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }

    private static EwsException TooLarge() =>
        new(EwsErrorKind.Other, "ResponseTooLarge", "The answer from Exchange is larger than Exchange:MaxResponseBytes.");

    // Every response message, in order.
    private static List<XElement> Messages(XDocument document) =>
        document.Descendants().Where(e => e.Name.Namespace == M && e.Attribute("ResponseClass") is not null).ToList();

    // The single response message of a one-item call; an Error class becomes an EwsException.
    private static XElement Single(XDocument document)
    {
        var message = Messages(document).FirstOrDefault()
            ?? throw new EwsException(EwsErrorKind.Other, "NoResponse", "Exchange returned no response message.");
        if ((string?)message.Attribute("ResponseClass") == "Error")
        {
            var code = (string?)message.Element(M + "ResponseCode") ?? "Unknown";
            throw new EwsException(Classify(code), code, (string?)message.Element(M + "MessageText") ?? code, BackOff(message));
        }
        return message;
    }

    private static EwsException Fault(XElement fault)
    {
        var code = fault.Descendants().FirstOrDefault(e => e.Name.LocalName == "ResponseCode")?.Value ?? "SoapFault";
        var text = fault.Descendants().FirstOrDefault(e => e.Name.LocalName == "Message")?.Value
                   ?? (string?)fault.Element("faultstring") ?? code;
        return new EwsException(Classify(code), code, text, BackOff(fault));
    }

    internal static EwsErrorKind Classify(string code) => code switch
    {
        "ErrorImpersonateUserDenied" or "ErrorImpersonationDenied" or "ErrorImpersonationFailed"
            or "ErrorAccessDenied" or "ErrorProxyRequestNotAllowed" => EwsErrorKind.Permission,
        "ErrorServerBusy" or "ErrorTooManyObjectsOpened" => EwsErrorKind.Throttling,
        "ErrorNonExistentMailbox" or "ErrorFolderNotFound" or "ErrorItemNotFound" => EwsErrorKind.NotFound,
        "ErrorConnectionFailed" or "ErrorMailboxStoreUnavailable" or "ErrorInternalServerTransientError"
            or "ErrorMailboxMoveInProgress" => EwsErrorKind.Connection,
        "ErrorInvalidSyncStateData" or "ErrorSyncFolderNotFound" => EwsErrorKind.InvalidSyncState,
        _ => EwsErrorKind.Other,
    };

    private static EwsChange? ChangeKind(string name) => name switch
    {
        "Create" => EwsChange.Create,
        "Update" => EwsChange.Update,
        "Delete" => EwsChange.Delete,
        "ReadFlagChange" => EwsChange.ReadFlagChange,
        _ => null,
    };

    private static XElement Distinguished(string id, string mailbox) =>
        new(T + "DistinguishedFolderId", new XAttribute("Id", id),
            new XElement(T + "Mailbox", new XElement(T + "EmailAddress", mailbox)));

    private static XElement Fields(IEnumerable<string> uris) =>
        new(T + "AdditionalProperties", uris.Select(u => new XElement(T + "FieldURI", new XAttribute("FieldURI", u))));

    // ErrorServerBusy carries how long Exchange wants us to wait.
    private static int? BackOff(XElement scope) =>
        scope.Descendants().FirstOrDefault(e => e.Name.LocalName == "Value" && (string?)e.Attribute("Name") == "BackOffMilliseconds")
            is { } value && int.TryParse(value.Value, out var ms) ? ms : null;

    private static XDocument? Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try
        {
            // CheckCharacters off: Exchange writes control characters found in mail
            // (e.g. &#x1; in a subject) that strict XML 1.0 forbids.
            using var reader = XmlReader.Create(new StringReader(text),
                new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, CheckCharacters = false });
            return XDocument.Load(reader);
        }
        catch (XmlException)
        {
            return null;
        }
    }

    private static int ParseInt(XElement? element) => int.TryParse(element?.Value, out var n) ? n : 0;

    private static bool ParseBool(XElement? element) => string.Equals(element?.Value, "true", StringComparison.OrdinalIgnoreCase);

    private static DateTime? ParseDate(XElement? element) =>
        DateTime.TryParse(element?.Value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d)
            ? DateTime.SpecifyKind(d, DateTimeKind.Utc) : null;

    private static string? Cut(string? value, int max) => value is null || value.Length <= max ? value : value[..max];
}
