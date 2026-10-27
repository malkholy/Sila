using System.Net.Mail;
using Microsoft.Extensions.Options;
using Sila.MailConnector.Data;
using Sila.MailConnector.Ews;

namespace Sila.MailConnector.Sync;

public sealed record RegistrationResult(bool Ok, string Message);

// Adds a Sila user's mailbox: the address a mail admin typed (Sila keeps no
// email in UserMaster) and the user's Sila username (the Sila Mail API finds a
// signed-in user's mailbox by it), checked before anything is saved -- one
// address in an allowed domain, the user has no other mailbox, neither the
// address nor the username is someone else's, and Exchange can open it with the
// service account. Then the first full sync is queued. Adding an existing
// mailbox again (same user and address) fills in a missing username.
// Used by the Mail Monitor ("Add mailbox") and POST /connector/v1/mailboxes.
public sealed class MailboxRegistration(EwsClient ews, MailStore store, SyncQueue queue, IOptionsMonitor<ExchangeOptions> exchange)
{
    // null = the address is acceptable; otherwise why not.
    public static string? CheckAddress(string? email, ExchangeOptions settings)
    {
        if (string.IsNullOrWhiteSpace(email) || email.Length > 254 || !MailAddress.TryCreate(email, out var address)
            || !string.Equals(address.Address, email, StringComparison.OrdinalIgnoreCase))
            return "Type one valid email address, e.g. name@glcpaints.com.";
        if (!settings.AllowedDomains.Contains(address.Host, StringComparer.OrdinalIgnoreCase))
            return $"{address.Host} is not an allowed mail domain ({string.Join(", ", settings.AllowedDomains)}).";
        return null;
    }

    public async Task<RegistrationResult> AddAsync(int userId, string? email, string? displayName, string? username, string reason,
        CancellationToken ct)
    {
        if (userId <= 0) return new(false, "A Sila user is required.");
        username = username?.Trim();
        if (string.IsNullOrEmpty(username) || username.Length > 50 || username.Any(char.IsControl))
            return new(false, "The Sila username is required (at most 50 characters).");
        email = email?.Trim().ToLowerInvariant();
        if (CheckAddress(email, exchange.CurrentValue) is { } problem) return new(false, problem);
        var name = displayName?.Trim();
        if (name is { Length: > 256 }) return new(false, "The display name is at most 256 characters.");

        var current = await store.GetUserAsync(userId, ct);
        if (current is not null && !string.Equals(current.SmtpAddress, email, StringComparison.OrdinalIgnoreCase))
            return new(false, $"Sila user #{userId} already has the mailbox {current.SmtpAddress}.");
        if (await store.GetUserIdByUsernameAsync(username, ct) is { } usernameOwner && usernameOwner != userId)
            return new(false, $"The username {username} already has a mailbox (Sila user #{usernameOwner}).");
        if (current is not null)
        {
            if (string.Equals(current.Username, username, StringComparison.OrdinalIgnoreCase))
                return new(true, "This mailbox was already added.");
            await store.SaveUserAsync(userId, current.SmtpAddress, string.IsNullOrEmpty(name) ? null : name, username, ct);
            return new(true, $"This mailbox was already added; its username is now {username}.");
        }
        if (await store.GetUserIdByAddressAsync(email!, ct) is { } owner)
            return new(false, $"{email} is already the mailbox of Sila user #{owner}.");

        try
        {
            await ews.GetFolderAsync(email!, "inbox", ct);
        }
        catch (EwsException error)
        {
            return new(false, error.Kind switch
            {
                EwsErrorKind.NotFound => $"Exchange has no mailbox {email}.",
                EwsErrorKind.Permission => $"The service account may not open {email} (impersonation scope?).",
                _ => $"Exchange could not be asked: {error.Message}",
            });
        }

        await store.SaveUserAsync(userId, email!, string.IsNullOrEmpty(name) ? null : name, username, ct);
        var queued = queue.TryEnqueue(new SyncRequest(userId, MailboxSync.AllFolders, reason, SyncLane.Initial));
        return new(true, queued ? "Added. The first sync has started." : "Added. The first sync will start with the next sync round.");
    }
}
