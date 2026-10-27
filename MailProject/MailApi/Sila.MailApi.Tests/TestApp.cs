using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Sila.MailApi.Admin;
using Sila.MailApi.Users;

namespace Sila.MailApi.Tests;

// Test only: the caller's address comes from a request header, first in the pipeline.
public sealed class TestClientIp : IStartupFilter
{
    public const string Header = "X-Test-Client-IP";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (context, call) =>
        {
            if (IPAddress.TryParse(context.Request.Headers[Header], out var ip)) context.Connection.RemoteIpAddress = ip;
            await call(context);
        });
        next(app);
    };
}

public sealed class FakeUserMail : IUserMailStore
{
    public Dictionary<string, Mailbox> Boxes { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["mhd"] = new Mailbox(4, "m.elkholy@example.test", "mhd", true, "OK", null, null),
        ["off"] = new Mailbox(9, "off@example.test", null, false, "Disabled", null, null),
    };
    public List<string> Calls { get; } = [];

    public Task<Mailbox?> FindMailboxAsync(string username, CancellationToken ct) =>
        Task.FromResult(Boxes.TryGetValue(username, out var b) ? b : null);

    public Task<List<FolderItem>> FoldersAsync(int userId, CancellationToken ct)
    {
        Calls.Add($"folders:{userId}");
        return Task.FromResult(new List<FolderItem> { new(7, null, "Inbox", "Inbox", 10, 2) });
    }

    public Task<MessagePage?> MessagesAsync(int userId, long folderId, string? before, int take, CancellationToken ct)
    {
        Calls.Add($"messages:{userId}:{folderId}:{take}");
        return Task.FromResult(folderId == 7 ? new MessagePage([], null) : null);
    }

    public Task<MessageDetail?> MessageAsync(int userId, long messageId, CancellationToken ct)
    {
        Calls.Add($"message:{userId}:{messageId}");
        return Task.FromResult<MessageDetail?>(null);
    }

    public Task<List<MessageItem>> SearchAsync(int userId, string text, int take, CancellationToken ct)
    {
        Calls.Add($"search:{userId}:{text}");
        return Task.FromResult(new List<MessageItem>());
    }

    // Mailbox #4 owns attachments 50 (a PDF), 51 (an HTML page) and 52 (an attached message).
    public Task<AttachmentItem?> AttachmentAsync(int userId, long attachmentId, CancellationToken ct)
    {
        Calls.Add($"attachment:{userId}:{attachmentId}");
        AttachmentItem? item = (userId, attachmentId) switch
        {
            (4, 50) => new(50, "Invoice 12.pdf", "application/pdf", 9, false, null),
            (4, 51) => new(51, "page.html", "text/html", 9, false, null),
            (4, 52) => new(52, "Re: offer", "message/rfc822", 9, false, null),
            _ => null,
        };
        return Task.FromResult(item);
    }
}

public sealed class FakeMonitor : IInternalMonitor
{
    // Like the real queries: rows are dictionaries, so their keys keep their SQL names (Mailboxes, UserID ...).
    public Task<object> OverviewAsync(CancellationToken ct) =>
        Task.FromResult<object>(new { accounts = new Dictionary<string, object?> { ["Mailboxes"] = 1 } });
    public Task<object> AccountsAsync(CancellationToken ct) => Task.FromResult<object>(new[] { new { UserID = 4 } });
    public Task<object> ErrorsAsync(CancellationToken ct) => Task.FromResult<object>(Array.Empty<object>());
    public Task<object?> AccountAsync(int userId, CancellationToken ct) =>
        Task.FromResult<object?>(userId == 4 ? new { account = new { UserID = 4 } } : null);
}

public sealed class FakeConnector : IConnectorClient
{
    public List<string> Calls { get; } = [];
    public ConnectorAnswer Answer { get; set; } = new(true, "Added. The first sync has started.");

    public Task<ConnectorAnswer> SyncAsync(int userId, CancellationToken ct)
    {
        Calls.Add($"sync:{userId}");
        return Task.FromResult(Answer);
    }

    public Task<ConnectorAnswer> AddAsync(int userId, string email, string? displayName, string username, CancellationToken ct)
    {
        Calls.Add($"add:{userId}:{email}:{username}");
        return Task.FromResult(Answer);
    }

    public ConnectorFile? File { get; set; }

    public Task<ConnectorFile> OpenAttachmentAsync(int userId, long attachmentId, CancellationToken ct)
    {
        Calls.Add($"file:{userId}:{attachmentId}");
        return Task.FromResult(File ?? new ConnectorFile(200, "OK", new MemoryStream("file-body"u8.ToArray())));
    }
}

// The Mail API in one role, with its own signing key standing in for 7400's.
public sealed class TestApp : IDisposable
{
    public const string Issuer = "https://sila.example.test:7400";
    public const string PushKey = "abcdefabcdefabcdefabcdefabcdefab";
    public const string SyncKey = "0123456789abcdef0123456789abcdef";
    public const string Office = "10.1.20.30";
    public const string Company = "203.0.113.7";

    private readonly RSA key = RSA.Create(2048);
    public FakeUserMail Mail { get; } = new();
    public FakeMonitor Monitor { get; } = new();
    public FakeConnector Connector { get; } = new();
    public WebApplicationFactory<Program> Factory { get; }

    public TestApp(string role = "Internal", string? anyNetworkUser = null)
    {
        AdminEndpoints.DetailsWait = TimeSpan.FromSeconds(1);
        Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["MailApi:Role"] = role,
                ["Authentication:Issuer"] = Issuer,
                ["Authentication:PublicKeyPem"] = key.ExportSubjectPublicKeyInfoPem(),
                ["MailAdmin:Users:0"] = "mhd",
                ["MailAdmin:AllowedNetworks:0"] = "10.1.0.0/16",
                ["MailAdmin:AnyNetworkUsers:0"] = anyNetworkUser,
                ["Connector:Url"] = "https://connector.example.test:9000",
                ["Connector:PushKey"] = PushKey,
                ["Connector:PushNetworks:0"] = "203.0.113.0/24",
                ["Sync:Key"] = SyncKey,
                ["ConnectionStrings:Mail"] = "Server=127.0.0.1,1;Database=None;Connect Timeout=1",
            }));
            b.ConfigureTestServices(services =>
            {
                services.AddTransient<IStartupFilter, TestClientIp>();
                services.RemoveAll<IUserMailStore>();
                services.AddSingleton<IUserMailStore>(Mail);
                services.RemoveAll<IInternalMonitor>();
                services.AddSingleton<IInternalMonitor>(Monitor);
                services.RemoveAll<IConnectorClient>();
                services.AddSingleton<IConnectorClient>(Connector);
            });
        });
    }

    public string Token(string user = "mhd", string db = "SILA101", bool forced = false, RSA? signWith = null, string issuer = Issuer,
        bool expired = false)
    {
        var claims = new List<Claim> { new("sub", Guid.NewGuid().ToString()), new("erp_user", user), new("db", db) };
        if (forced) claims.Add(new("force_password_change", "true"));
        var now = DateTime.UtcNow;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = "plus-api-v2",
            Subject = new ClaimsIdentity(claims),
            NotBefore = now.AddMinutes(-10),
            IssuedAt = now.AddMinutes(-10),
            Expires = expired ? now.AddMinutes(-5) : now.AddMinutes(5),
            TokenType = "at+jwt",
            SigningCredentials = new SigningCredentials(new RsaSecurityKey(signWith ?? key), SecurityAlgorithms.RsaSha256),
        });
    }

    public async Task<(HttpStatusCode Status, string Body)> Get(string path, string? token, string ip = Office)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add(TestClientIp.Header, ip);
        var response = await Factory.CreateClient().SendAsync(request);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    public async Task<HttpResponseMessage> GetResponse(string path, string? token, string ip = Office)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add(TestClientIp.Header, ip);
        return await Factory.CreateClient().SendAsync(request);
    }

    public async Task<(HttpStatusCode Status, string Body)> Admin(object body, string? token, string ip = Office)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/mail/v1/admin") { Content = JsonContent.Create(body) };
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add(TestClientIp.Header, ip);
        var response = await Factory.CreateClient().SendAsync(request);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    public async Task<(HttpStatusCode Status, string Body)> Push(string json, string? key = PushKey, string ip = Company)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/mail/v1/monitor/push")
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        if (key is not null) request.Headers.Add("X-Connector-Key", key);
        request.Headers.Add(TestClientIp.Header, ip);
        var response = await Factory.CreateClient().SendAsync(request);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    public void Dispose()
    {
        Factory.Dispose();
        key.Dispose();
    }
}
