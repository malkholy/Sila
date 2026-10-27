using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Sila.MailApi.Admin;

public sealed record ConnectorAnswer(bool Ok, string Message);

// An attachment's bytes from the connector (Content + Owner, disposed by the
// caller when sent), or why not (Status, Message).
public sealed record ConnectorFile(int Status, string Message, Stream? Content = null, IDisposable? Owner = null)
{
    public bool Ok => Content is not null;
}

// Internal role: "sync now", "add mailbox" and attachment files go straight to
// the Mail Connector API on this server (Connector:Url). Behind an interface for tests.
public interface IConnectorClient
{
    Task<ConnectorAnswer> SyncAsync(int userId, CancellationToken ct);
    Task<ConnectorAnswer> AddAsync(int userId, string email, string? displayName, string username, CancellationToken ct);
    Task<ConnectorFile> OpenAttachmentAsync(int userId, long attachmentId, CancellationToken ct);
}

public sealed class HttpConnectorClient(IHttpClientFactory clients, IOptionsMonitor<ConnectorOptions> options) : IConnectorClient
{
    public const string ClientName = "connector";
    // Attachment downloads: a first open waits for Exchange, so a longer limit.
    public const string FilesClientName = "connector-files";

    public Task<ConnectorAnswer> SyncAsync(int userId, CancellationToken ct) =>
        SendAsync($"connector/v1/mailboxes/{userId}/sync?folder=all", null, "The sync could not be queued.", ct);

    public Task<ConnectorAnswer> AddAsync(int userId, string email, string? displayName, string username, CancellationToken ct) =>
        SendAsync("connector/v1/mailboxes", new { userId, smtpAddress = email, displayName, username }, "The mailbox could not be added.", ct);

    public async Task<ConnectorFile> OpenAttachmentAsync(int userId, long attachmentId, CancellationToken ct)
    {
        if (!Uri.TryCreate(options.CurrentValue.Url, UriKind.Absolute, out var baseUri))
            return new(503, "The Mail Connector API is not configured on this server (Connector:Url).");
        var uri = new Uri(new Uri(baseUri.AbsoluteUri.TrimEnd('/') + "/"), $"connector/v1/mailboxes/{userId}/attachments/{attachmentId}");
        HttpResponseMessage response;
        try
        {
            response = await clients.CreateClient(FilesClientName).GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return new(502, "The Mail Connector API cannot be reached on this server.");
        }
        if (response.IsSuccessStatusCode) return new(200, "OK", await response.Content.ReadAsStreamAsync(ct), response);
        using (response)
        {
            var message = Message(await response.Content.ReadAsStringAsync(ct));
            var status = (int)response.StatusCode is 404 or 403 or 413 or 503 ? (int)response.StatusCode : 502;
            return new(status, message ?? $"The attachment could not be fetched (the Mail Connector API answered {(int)response.StatusCode}).");
        }
    }

    private async Task<ConnectorAnswer> SendAsync(string path, object? body, string fallback, CancellationToken ct)
    {
        var settings = options.CurrentValue;
        if (!Uri.TryCreate(settings.Url, UriKind.Absolute, out var baseUri))
            return new(false, "The Mail Connector API is not configured on this server (Connector:Url).");
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(baseUri.AbsoluteUri.TrimEnd('/') + "/"), path))
        {
            Content = body is null ? null : JsonContent.Create(body),
        };
        try
        {
            using var response = await clients.CreateClient(ClientName).SendAsync(request, ct);
            var text = await response.Content.ReadAsStringAsync(ct);
            var message = Message(text);
            return response.IsSuccessStatusCode
                ? new(true, message ?? "Done.")
                : new(false, message ?? $"{fallback} (the Mail Connector API answered {(int)response.StatusCode}).");
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return new(false, "The Mail Connector API cannot be reached on this server.");
        }
    }

    private static string? Message(string text)
    {
        try
        {
            using var json = JsonDocument.Parse(text);
            return json.RootElement.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
