using System.Diagnostics;
using Sila.MailConnector.Data;
using Sila.MailConnector.Ews;

namespace Sila.MailConnector.Sync;

public sealed record SyncOutcome(bool Succeeded, string Message, int Pages, PageResult Totals, long ElapsedMs);

// One mailbox sync (MailPlan 2.1 layer 2): the folder tree, then one folder's
// items page by page from its saved SyncState. Each page commits its rows and
// the new SyncState together, so a crash or restart resumes from the last page.
// The mailbox is leased ('Mailbox:<UserID>') so only one instance syncs it.
public sealed class MailboxSync(EwsClient ews, MailStore store, ILogger<MailboxSync> log)
{
    public const string Owner = "ExchangeSync";
    private const int LeaseSeconds = 120;

    // Exchange's well-known folders -> MailFolder.FolderType.
    private static readonly Dictionary<string, string> WellKnown = new(StringComparer.Ordinal)
    {
        ["inbox"] = "Inbox", ["sentitems"] = "SentItems", ["drafts"] = "Drafts",
        ["deleteditems"] = "DeletedItems", ["junkemail"] = "JunkEmail", ["outbox"] = "Outbox",
    };

    public static readonly IReadOnlyDictionary<string, string> FolderTypes = WellKnown;

    private static string InstanceOwner => $"{Environment.MachineName}:{Environment.ProcessId}:{Owner}";

    public const string AllFolders = "all";

    // folderName: a well-known folder (inbox, sentitems ...) or "all" (every mail folder).
    public async Task<SyncOutcome> RunAsync(int userId, string folderName, string reason, CancellationToken ct)
    {
        var started = Stopwatch.GetTimestamp();
        long Elapsed() => (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        var folderType = "";
        if (folderName != AllFolders && !WellKnown.TryGetValue(folderName, out folderType!))
            return new SyncOutcome(false, $"Unknown folder '{folderName}'.", 0, new(0, 0, 0), 0);
        var user = await store.GetUserAsync(userId, ct);
        if (user is null) return new SyncOutcome(false, "Mailbox not registered.", 0, new(0, 0, 0), 0);
        if (!user.IsEnabled) return new SyncOutcome(false, "Mailbox is disabled.", 0, new(0, 0, 0), 0);

        var lease = $"Mailbox:{userId}";
        if (!await store.TryLeaseAsync(lease, InstanceOwner, LeaseSeconds, ct))
            return new SyncOutcome(false, "This mailbox is already being synced.", 0, new(0, 0, 0), Elapsed());
        long? failedFolder = null;
        try
        {
            await SyncHierarchyAsync(user, reason, ct);
            var folders = folderName == AllFolders
                ? await store.GetSyncFoldersAsync(userId, ct)
                : [await store.GetFolderAsync(userId, folderType, ct)
                   ?? throw new EwsException(EwsErrorKind.NotFound, "FolderMissing", $"The mailbox has no {folderType} folder.")];
            int pages = 0, bodies = 0, added = 0, changed = 0, deleted = 0, failedFolders = 0;
            foreach (var folder in folders)
            {
                failedFolder = folder.FolderID;
                try
                {
                    var (p, t) = await SyncFolderAsync(user, folder, reason, lease, ct);
                    bodies += await SyncBodiesAsync(user, folder, reason, lease, ct);
                    pages += p; added += t.Added; changed += t.Changed; deleted += t.Deleted;
                    await store.ResolveErrorsAsync(userId, folder.FolderID, ct);   // this folder is fine again
                }
                catch (EwsException error) when (folders.Count > 1 && error.Code != "LeaseLost"
                                                 && error.Kind is EwsErrorKind.NotFound or EwsErrorKind.InvalidSyncState or EwsErrorKind.Other)
                {
                    // One folder (gone, rebuild needed, a bad answer) does not stop the rest of the mailbox.
                    failedFolders++;
                    await store.RecordFolderErrorAsync(userId, folder.FolderID, ErrorType(error.Kind), error, CancellationToken.None);
                    log.LogWarning("Folder {Folder} of {Mailbox} skipped: {Kind} {Code}", folder.DisplayName, user.SmtpAddress, error.Kind, error.Code);
                }
            }
            failedFolder = null;
            var (merged, purged) = await SettleMovesAsync(user, reason, ct);
            await store.RecordSuccessAsync(userId, ct);
            await store.ResolveErrorsAsync(userId, null, ct);   // account-level errors (sign-in, connection ...)
            log.LogInformation(
                "Synced {Mailbox} {Scope}: {Folders} folders ({Failed} skipped), {Pages} pages, +{Added} ~{Changed} -{Deleted}, {Bodies} bodies, {Merged} moves, {Purged} purged in {Ms} ms",
                user.SmtpAddress, folderName, folders.Count, failedFolders, pages, added, changed, deleted, bodies, merged, purged, Elapsed());
            return new SyncOutcome(true, failedFolders == 0 ? "Synced." : $"Synced; {failedFolders} folder(s) skipped.",
                pages, new PageResult(added, changed, deleted), Elapsed());
        }
        catch (EwsException error)
        {
            log.LogWarning("Sync failed for {Mailbox}: {Kind} {Code}", user.SmtpAddress, error.Kind, error.Code);
            var errorAfter = await store.GetSettingAsync("ErrorAfterFailures", 3, CancellationToken.None);
            await store.RecordFailureAsync(userId, failedFolder, ErrorType(error.Kind), error, errorAfter, CancellationToken.None);
            return new SyncOutcome(false, error.Message, 0, new(0, 0, 0), Elapsed());
        }
        finally
        {
            await store.ReleaseLeaseAsync(lease, InstanceOwner, CancellationToken.None);
        }
    }

    // The mail folder tree under msgfolderroot. A lost or rejected hierarchy
    // SyncState is simply restarted from empty: folders are matched by their
    // Exchange ID, so nothing is duplicated.
    private async Task SyncHierarchyAsync(MailUserRow user, string reason, CancellationToken ct)
    {
        var logId = await store.StartSyncLogAsync(user.UserID, null, "Hierarchy", reason, ct);
        int pages = 0, added = 0, changed = 0, deleted = 0;
        try
        {
            var root = await Retry(() => ews.GetFolderAsync(user.SmtpAddress, "msgfolderroot", ct), ct);
            var ids = await Retry(() => ews.GetDistinguishedIdsAsync(user.SmtpAddress, WellKnown.Keys.ToList(), ct), ct);
            var types = ids.ToDictionary(p => p.Value, p => WellKnown[p.Key], StringComparer.Ordinal);
            var state = user.HierarchySyncState;
            var restarted = false;
            while (true)
            {
                HierarchyPage page;
                try
                {
                    page = await Retry(() => ews.SyncFolderHierarchyAsync(user.SmtpAddress, state, ct), ct);
                }
                catch (EwsException error) when (error.Kind == EwsErrorKind.InvalidSyncState && !restarted)
                {
                    restarted = true;
                    state = null;
                    continue;
                }
                var result = await store.ApplyHierarchyAsync(user.UserID, root, page.Changes, types, page.SyncState, ct);
                pages++;
                added += result.Added; changed += result.Changed; deleted += result.Deleted;
                state = page.SyncState;
                if (page.IncludesLast) break;
            }
            await store.FinishSyncLogAsync(logId, pages, new(added, changed, deleted), null, ct);
        }
        catch (EwsException error)
        {
            await store.FinishSyncLogAsync(logId, pages, new(added, changed, deleted), error, CancellationToken.None);
            throw;
        }
    }

    private async Task<(int Pages, PageResult Totals)> SyncFolderAsync(MailUserRow user, FolderRow folder, string reason,
        string lease, CancellationToken ct)
    {
        var logId = await store.StartSyncLogAsync(user.UserID, folder.FolderID, "Folder", reason, ct);
        var pageSize = await store.GetSettingAsync("SyncPageSize", 200, ct);
        int pages = 0, added = 0, changed = 0, deleted = 0;
        try
        {
            var state = folder.SyncState;
            while (true)
            {
                ItemPage page;
                try
                {
                    page = await Retry(() => ews.SyncFolderItemsAsync(user.SmtpAddress, folder.ExchangeFolderId, state, pageSize, ct), ct);
                }
                catch (EwsException error) when (error.Kind == EwsErrorKind.InvalidSyncState)
                {
                    // The controlled rebuild (MailPlan 7.5) comes in a later step; until
                    // then the folder is parked as Rebuilding instead of failing in a loop.
                    await store.SetFolderStateAsync(folder.FolderID, "Rebuilding", null, CancellationToken.None);
                    throw;
                }

                var upsertIds = page.Changes.Where(c => c.Change is EwsChange.Create or EwsChange.Update)
                    .Select(c => c.ItemId).Distinct(StringComparer.Ordinal).ToList();
                var (items, failures) = await Retry(() => ews.GetItemsAsync(user.SmtpAddress, upsertIds, ct), ct);
                await store.RecordBadItemsAsync(user.UserID, folder.FolderID, failures, ct);
                var deletes = page.Changes.Where(c => c.Change == EwsChange.Delete).Select(c => c.ItemId).ToList();
                var reads = page.Changes.Where(c => c.Change == EwsChange.ReadFlagChange && c.IsRead is not null)
                    .Select(c => (c.ItemId, c.IsRead!.Value)).ToList();

                var result = await store.ApplyItemPageAsync(user.UserID, folder.FolderID, items, deletes, reads,
                    page.SyncState, page.IncludesLast, ct);
                pages++;
                added += result.Added; changed += result.Changed; deleted += result.Deleted;
                state = page.SyncState;
                if (page.IncludesLast) break;
                // A long first sync keeps the mailbox lease alive.
                if (!await store.TryLeaseAsync(lease, InstanceOwner, LeaseSeconds, ct))
                    throw new EwsException(EwsErrorKind.Other, "LeaseLost", "Another instance took over this mailbox.");
            }
            var counts = (await Retry(() => ews.GetFoldersByIdAsync(user.SmtpAddress, [folder.ExchangeFolderId], ct), ct))[0];
            await store.SetFolderStateAsync(folder.FolderID, "OK", counts, ct);
            await store.FinishSyncLogAsync(logId, pages, new(added, changed, deleted), null, ct);
            return (pages, new PageResult(added, changed, deleted));
        }
        catch (EwsException error)
        {
            await store.FinishSyncLogAsync(logId, pages, new(added, changed, deleted), error, CancellationToken.None);
            throw;
        }
    }

    // End of a run: deleted rows that reappeared in another folder are merged
    // (moves keep their MessageID), then unclaimed ones past the grace time go.
    private async Task<(int Merged, int Purged)> SettleMovesAsync(MailUserRow user, string reason, CancellationToken ct)
    {
        var logId = await store.StartSyncLogAsync(user.UserID, null, "Moves", reason, ct);
        var merged = await store.MergeMovesAsync(user.UserID, ct);
        var grace = await store.GetSettingAsync("MoveGraceMinutes", 30, ct);
        var purged = await store.PurgeDeletedAsync(user.UserID, Math.Max(1, grace), ct);
        await store.FinishSyncLogAsync(logId, 0, new(0, 0, purged), null, ct, matched: merged);
        return (merged, purged);
    }

    // The body pass: every message of the folder without a body row gets its
    // sanitized body and attachment details, newest first, a few per Exchange
    // call and per commit. Covers the first sync, new mail and re-fetched drafts.
    private async Task<int> SyncBodiesAsync(MailUserRow user, FolderRow folder, string reason, string lease, CancellationToken ct)
    {
        var logId = await store.StartSyncLogAsync(user.UserID, folder.FolderID, "Folder", $"{reason}:Bodies", ct);
        var batch = Math.Clamp(await store.GetSettingAsync("BodyBatchSize", 20, ct), 1, 100);
        int pages = 0, saved = 0;
        try
        {
            while (true)
            {
                var pending = await store.GetMessagesWithoutBodyAsync(user.UserID, folder.FolderID, 200, ct);
                if (pending.Count == 0) break;
                foreach (var chunk in pending.Chunk(batch))
                {
                    saved += await FetchBodiesAsync(user, folder, chunk, ct);
                    pages++;
                }
                if (!await store.TryLeaseAsync(lease, InstanceOwner, LeaseSeconds, ct))
                    throw new EwsException(EwsErrorKind.Other, "LeaseLost", "Another instance took over this mailbox.");
            }
            await store.FinishSyncLogAsync(logId, pages, new(saved, 0, 0), null, ct);
            return saved;
        }
        catch (EwsException error)
        {
            await store.FinishSyncLogAsync(logId, pages, new(saved, 0, 0), error, CancellationToken.None);
            throw;
        }
    }

    private async Task<int> FetchBodiesAsync(MailUserRow user, FolderRow folder, (long MessageID, string ItemId)[] chunk, CancellationToken ct)
    {
        var ids = chunk.Select(c => c.ItemId).ToList();
        var bodies = new List<MailBody>();
        var failures = new List<ItemFailure>();
        try
        {
            var (b, f) = await Retry(() => ews.GetBodiesAsync(user.SmtpAddress, ids, ct), ct);
            bodies.AddRange(b);
            failures.AddRange(f);
        }
        catch (EwsException error) when (error.Code == "ResponseTooLarge")
        {
            // Too big together: one at a time, and a single message too big on its own is a BadItem.
            foreach (var id in ids)
            {
                try
                {
                    var (b, f) = await Retry(() => ews.GetBodiesAsync(user.SmtpAddress, [id], ct), ct);
                    bodies.AddRange(b);
                    failures.AddRange(f);
                }
                catch (EwsException single) when (single.Code == "ResponseTooLarge")
                {
                    failures.Add(new ItemFailure(id, single.Code, single.Message));
                }
            }
        }
        // An item Exchange did not answer for at all counts as failed too, so the pass always moves on.
        var answered = bodies.Select(b => b.ItemId).Concat(failures.Select(f => f.ItemId)).ToHashSet(StringComparer.Ordinal);
        failures.AddRange(ids.Where(id => !answered.Contains(id))
            .Select(id => new ItemFailure(id, "NoAnswer", "Exchange returned nothing for this message.")));
        await store.RecordBadItemsAsync(user.UserID, folder.FolderID, failures, ct);

        var byItem = chunk.ToDictionary(c => c.ItemId, c => c.MessageID, StringComparer.Ordinal);
        var rows = bodies.Select(b => (byItem[b.ItemId], BodySanitizer.Compress(BodySanitizer.Html(b.Html)), BodySanitizer.Text(b.Text), b.Attachments))
            .Concat(failures.Select(f => (byItem[f.ItemId], (byte[]?)null, (string?)null, (IReadOnlyList<MailAttachmentInfo>)[])))
            .ToList();
        await store.SaveBodiesAsync(user.UserID, rows, ct);
        return bodies.Count;
    }

    // Throttling: wait as long as Exchange asks (or 2, 4, 8 ... s), up to 5 tries.
    // Connection errors: 3 tries. Everything else fails at once.
    private static async Task<T> Retry<T>(Func<Task<T>> call, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await call();
            }
            catch (EwsException error) when (error.Kind == EwsErrorKind.Throttling && attempt < 5
                                             || error.Kind == EwsErrorKind.Connection && attempt < 3)
            {
                var wait = error.BackOffMilliseconds ?? (int)Math.Min(60_000, 1000 * Math.Pow(2, attempt));
                await Task.Delay(wait, ct);
            }
        }
    }

    private static string ErrorType(EwsErrorKind kind) => kind switch
    {
        EwsErrorKind.Authentication => "Authentication",
        EwsErrorKind.Permission => "Permission",
        EwsErrorKind.Throttling => "Throttling",
        EwsErrorKind.Connection => "Connection",
        EwsErrorKind.InvalidSyncState => "SyncStateRebuilt",
        _ => "Other",
    };
}
