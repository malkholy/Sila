using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Sila.Mail.Contract;
using Sila.MailConnector.Data;
using FolderRow = Sila.Mail.Contract.FolderRow;

namespace Sila.MailConnector.Publish;

// The Publisher worker (MailPlan 2.2, 7.2, 7.3): InternalMail -> the external Mail
// database, through the Mail External API's /sync/v1/apply (outside the
// company; this service calls out, nothing calls in). It reads MailChange in
// Seq order from MailPublishState.LastPublishedSeq, builds a batch of the rows'
// CURRENT state (or deletes), sends it gzip-compressed with Publish:Key, and
// moves LastPublishedSeq only after the external side confirms. A 409 means the
// external copy is elsewhere (e.g. restored from a backup): the pointer follows
// it and the changes are sent again -- applying twice changes nothing there.
// Off while Publish:Url is empty: until then no mail leaves the company.
public sealed class Publisher(IHttpClientFactory clients, IOptionsMonitor<PublishOptions> options, MailStore store,
    ILogger<Publisher> log) : BackgroundService
{
    public const string ClientName = "publish";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var settings = options.CurrentValue;
            if (!settings.Configured)
            {
                await Delay(TimeSpan.FromMinutes(1), stoppingToken);
                continue;
            }
            TimeSpan wait;
            try
            {
                var more = await PublishOnceAsync(settings, stoppingToken);
                failures = 0;
                wait = more ? TimeSpan.Zero : TimeSpan.FromSeconds(settings.IdleSeconds);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                failures++;
                wait = TimeSpan.FromSeconds(Math.Min(60, 2 * Math.Pow(2, Math.Min(failures, 5))));
                log.LogWarning("Publish failed ({ErrorType}: {Message}); next try in {Seconds} s",
                    error.GetType().Name, error.Message, (int)wait.TotalSeconds);
                try { await store.SetPublishErrorAsync($"{error.GetType().Name}: {error.Message}", CancellationToken.None); }
                catch { /* the database may be what failed */ }
            }
            if (wait > TimeSpan.Zero) await Delay(wait, stoppingToken);
        }
    }

    // One batch. True when more changes may be waiting.
    private async Task<bool> PublishOnceAsync(PublishOptions settings, CancellationToken ct)
    {
        var last = await store.GetLastPublishedAsync(ct);
        var changes = await store.ReadChangesAsync(last, settings.BatchChanges, ct);
        if (changes.Count == 0) return false;

        // Too big for one request (bodies vary a lot): halve until it fits.
        var take = changes.Count;
        while (true)
        {
            var part = changes.Take(take).ToList();
            var plan = BatchPlan.From(part);
            var rows = await store.LoadPublishRowsAsync(plan.UserIds, plan.FolderIds, plan.MessageIds, plan.BodyIds, plan.AttachmentIds, ct);
            var batch = plan.Build(last, rows);
            var json = JsonSerializer.SerializeToUtf8Bytes(batch, Json);
            if (json.Length > settings.MaxBatchBytes && take > 1) { take = Math.Max(1, take / 2); continue; }

            var started = Stopwatch.GetTimestamp();
            var (status, result) = await SendAsync(settings, json, ct);
            var ms = (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            if (status == HttpStatusCode.Conflict && result is not null)
            {
                log.LogWarning("The external copy is at {Remote}, not after {Local}: continuing from there", result.LastAppliedSeq, last);
                await store.SetPublishedAsync(result.LastAppliedSeq, ms, ct);
                return true;
            }
            if (status != HttpStatusCode.OK || result is null)
                throw new HttpRequestException($"The Mail External API answered {(int)status}.");
            await store.SetPublishedAsync(result.LastAppliedSeq, ms, ct);
            log.LogInformation("Published changes {From}-{To}: {Applied} applied, {Skipped} skipped, {Kb} KB in {Ms} ms",
                last + 1, batch.ToSeq, result.Applied, result.Skipped, json.Length / 1024, ms);
            return take < changes.Count || changes.Count == settings.BatchChanges;
        }
    }

    private async Task<(HttpStatusCode Status, PublishResult? Result)> SendAsync(PublishOptions settings, byte[] json, CancellationToken ct)
    {
        using var compressed = new MemoryStream();
        await using (var gzip = new GZipStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
            await gzip.WriteAsync(json, ct);
        using var request = new HttpRequestMessage(HttpMethod.Post, settings.Url.TrimEnd('/') + "/apply")
        {
            Content = new ByteArrayContent(compressed.ToArray()),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Content.Headers.ContentEncoding.Add("gzip");
        request.Headers.TryAddWithoutValidation("X-Sync-Key", settings.Key);
        using var response = await clients.CreateClient(ClientName).SendAsync(request, ct);
        PublishResult? result = null;
        if (response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Conflict)
            result = await response.Content.ReadFromJsonAsync<PublishResult>(Json, ct);
        return (response.StatusCode, result);
    }

    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task Delay(TimeSpan wait, CancellationToken ct)
    {
        try { await Task.Delay(wait, ct); }
        catch (OperationCanceledException) { /* stopping */ }
    }
}

// Which rows a run of changes touches: the LAST operation per row wins (the row
// is sent as it is now), and tables the external copy does not take yet
// (recipients travel with their message; ticket links, actions, permissions
// later) are only counted in ToSeq.
internal sealed class BatchPlan
{
    private readonly Dictionary<(string Table, long Id), (long Seq, char Op)> last = [];
    public long ToSeq { get; private init; }

    public static BatchPlan From(IReadOnlyList<MailStore.ChangeRow> changes)
    {
        var plan = new BatchPlan { ToSeq = changes.Count == 0 ? 0 : changes.Max(c => c.Seq) };
        foreach (var c in changes)
        {
            if (!Tables.Contains(c.Table) || !long.TryParse(c.RowKey, out var id)) continue;
            plan.last[(c.Table, id)] = (c.Seq, c.Operation);
        }
        return plan;
    }

    private static readonly HashSet<string> Tables = ["MailUser", "MailFolder", "MailMessage", "MailMessageBody", "MailAttachment"];

    private IReadOnlyCollection<long> Upserts(string table) =>
        last.Where(x => x.Key.Table == table && x.Value.Op == 'U').Select(x => x.Key.Id).ToList();

    public IReadOnlyCollection<long> UserIds => Upserts("MailUser");
    public IReadOnlyCollection<long> FolderIds => Upserts("MailFolder");
    public IReadOnlyCollection<long> MessageIds => Upserts("MailMessage");
    public IReadOnlyCollection<long> BodyIds => Upserts("MailMessageBody");
    public IReadOnlyCollection<long> AttachmentIds => Upserts("MailAttachment");

    // An upsert whose row is gone by now (or a message marked deleted) is sent as a delete.
    public PublishBatch Build(long afterSeq, MailStore.PublishRows rows)
    {
        var users = new List<UserRow>(); var folders = new List<FolderRow>(); var messages = new List<MessageRow>();
        var bodies = new List<BodyRow>(); var attachments = new List<AttachmentRow>();
        var deletes = new PublishDeletes([], [], [], [], []);
        foreach (var ((table, id), (seq, op)) in last.OrderBy(x => x.Value.Seq))
        {
            switch (table)
            {
                case "MailUser" when op == 'U' && rows.Users.TryGetValue(id, out var u):
                    users.Add(new UserRow(u.UserId, u.Smtp, u.Name, u.Enabled, u.Status, u.LastSync, u.LastNote, u.Items, u.Unread, u.Username, seq));
                    break;
                case "MailUser":
                    deletes.Users.Add(new KeySeq(id, seq));
                    break;
                case "MailFolder" when op == 'U' && rows.Folders.TryGetValue(id, out var f):
                    folders.Add(new FolderRow(f.Id, f.UserId, f.Parent, f.ExId, f.Name, f.Type, f.Total, f.Unread, f.LastSync, seq));
                    break;
                case "MailFolder":
                    deletes.Folders.Add(new KeySeq(id, seq));
                    break;
                case "MailMessage" when op == 'U' && rows.Messages.TryGetValue(id, out var m):
                    var recipients = rows.Recipients.TryGetValue(id, out var list)
                        ? list.Select(r => new RecipientRow(r.Type, r.Position, r.Name, r.Address)).ToList() : [];
                    messages.Add(new MessageRow(m.Id, m.UserId, m.FolderId, m.ItemId, m.ChangeKey, m.InternetId, m.Conversation,
                        m.Subject, m.FromName, m.FromAddress, Utc(m.SentAt), Utc(m.ReceivedAt)!.Value, m.IsRead, m.Flag, m.Importance,
                        m.HasAttachments, m.IsDraft, m.Preview, recipients, seq));
                    break;
                case "MailMessage":
                    deletes.Messages.Add(new KeySeq(id, seq));
                    break;
                case "MailMessageBody" when op == 'U' && rows.Bodies.TryGetValue(id, out var b):
                    bodies.Add(new BodyRow(id, b.HtmlGz, b.Text, seq));
                    break;
                case "MailMessageBody":
                    deletes.Bodies.Add(new KeySeq(id, seq));
                    break;
                case "MailAttachment" when op == 'U' && rows.Attachments.TryGetValue(id, out var a):
                    attachments.Add(new AttachmentRow(a.Id, a.MessageId, a.ExId, a.Name, a.Type, a.Size, a.Inline, a.Cid, seq));
                    break;
                case "MailAttachment":
                    deletes.Attachments.Add(new KeySeq(id, seq));
                    break;
            }
        }
        return new PublishBatch(afterSeq, Math.Max(afterSeq, ToSeq), users, folders, messages, bodies, attachments, deletes);
    }

    // Message dates are stored in UTC (EWS gives UTC); say so on the wire.
    private static DateTime? Utc(DateTime? d) => d is null ? null : DateTime.SpecifyKind(d.Value, DateTimeKind.Utc);
}
