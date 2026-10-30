using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Plus.Api.Push;
using Xunit;

namespace Plus.Api.Tests;

public sealed class FakePushStore(params PushItem[] items) : IPushStore
{
    public List<(string Src, int Id)> Marked { get; } = [];
    public List<string> Removed { get; } = [];
    public List<PushLogEntry> Logged { get; } = [];
    public Task<IReadOnlyList<PushItem>> ClaimAsync(int top, int maxAgeMinutes, int holdSeconds, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<PushItem>>(items);
    public Task MarkSentAsync(IReadOnlyCollection<(string Src, int Id)> sent, CancellationToken cancellationToken)
    { Marked.AddRange(sent); return Task.CompletedTask; }
    public Task RemoveTokensAsync(IReadOnlyCollection<string> tokens, CancellationToken cancellationToken)
    { Removed.AddRange(tokens); return Task.CompletedTask; }
    public Task LogAsync(IReadOnlyCollection<PushLogEntry> entries, CancellationToken cancellationToken)
    { Logged.AddRange(entries); return Task.CompletedTask; }
}

public sealed class FakeTransport(Func<string, PushResult> result) : IPushTransport
{
    public bool Ready => true;
    public List<JsonObject> Sent { get; } = [];
    public Task<PushResult> SendAsync(JsonObject message, CancellationToken cancellationToken)
    {
        lock (Sent) Sent.Add(message);
        return Task.FromResult(result(message["token"]!.GetValue<string>()));
    }
}

public sealed class PushTests
{
    private static PushItem Item(string src, int id, bool muted = false, params string[] tokens) =>
        new(src, id, 4, src == "G" ? 2 : 3, "Ahmed@Sales", "Hello", 0, src == "G" ? 588 : 0, 10, src == "C" ? 2301855 : 0, 0, 0, muted,
            tokens);

    private static PushSender Sender(IPushStore store, IPushTransport transport) =>
        new(store, transport, new StaticOptions(new PushOptions { Enabled = true, Parallel = 2 }), NullLogger<PushSender>.Instance);

    private sealed class StaticOptions(PushOptions value) : IOptionsMonitor<PushOptions>
    {
        public PushOptions CurrentValue => value;
        public PushOptions Get(string? name) => value;
        public IDisposable? OnChange(Action<PushOptions, string?> listener) => null;
    }

    [Fact]
    public void Payload_matches_the_app()
    {
        var m = PushSender.Message(Item("G", 7, false, "tok"), "tok");
        Assert.Equal("tok", m["token"]!.GetValue<string>());
        Assert.Equal("Ahmed@Sales", m["notification"]!["title"]!.GetValue<string>());
        Assert.Equal("Hello", m["notification"]!["body"]!.GetValue<string>());
        Assert.Equal("HIGH", m["android"]!["priority"]!.GetValue<string>());
        Assert.Equal("beep", m["android"]!["notification"]!["sound"]!.GetValue<string>());
        Assert.Equal("10", m["apns"]!["headers"]!["apns-priority"]!.GetValue<string>());
        Assert.Equal(1, m["apns"]!["payload"]!["aps"]!["content-available"]!.GetValue<int>());
        var data = m["data"]!.AsObject();
        Assert.Equal(["id", "SessionID", "GroupID", "ChannelID", "TicketID", "MailID", "TaskID", "ChatType", "click_action"],
            data.Select(p => p.Key).ToArray());
        Assert.All(data, p => Assert.Equal(JsonValueKind.String, p.Value!.GetValueKind()));   // FCM data must be strings
        Assert.Equal("588", data["GroupID"]!.GetValue<string>());
        Assert.Equal("2", data["ChatType"]!.GetValue<string>());
        Assert.Equal("FLUTTER_NOTIFICATION_CLICK", data["click_action"]!.GetValue<string>());
    }

    [Fact]
    public async Task Delivered_muted_and_deviceless_messages_are_marked_failed_ones_are_not()
    {
        var store = new FakePushStore(
            Item("C", 1, false, "good"),            // delivered
            Item("C", 2, true, "good"),             // muted: marked, no push
            Item("O", 3),                           // no device: marked, no push
            Item("G", 4, false, "flaky"));          // every send failed: retried later
        var transport = new FakeTransport(t => t == "flaky" ? PushResult.Failed : PushResult.Sent);
        Assert.Equal(4, await Sender(store, transport).Tick(CancellationToken.None));
        Assert.Equal(2, transport.Sent.Count);
        Assert.Equal([("C", 1), ("C", 2), ("O", 3)], store.Marked.OrderBy(x => x.Id).ToArray());
        Assert.Empty(store.Removed);
        Assert.Equal(["Sent", "Muted", "NoDevice", "Failed"], store.Logged.OrderBy(x => x.Id).Select(x => x.Result).ToArray());
        Assert.Equal(1, store.Logged.Single(x => x.Id == 1).Delivered);
    }

    [Fact]
    public async Task Gone_tokens_are_removed_and_a_message_with_no_device_left_is_done()
    {
        var store = new FakePushStore(Item("C", 1, false, "old", "new"), Item("C", 2, false, "dead"));
        var transport = new FakeTransport(t => t == "new" ? PushResult.Sent : PushResult.TokenGone);
        await Sender(store, transport).Tick(CancellationToken.None);
        Assert.Equal(["dead", "old"], store.Removed.OrderBy(x => x).ToArray());
        Assert.Equal([1, 2], store.Marked.Select(x => x.Id).OrderBy(x => x).ToArray());
        Assert.Equal(["Sent", "TokenGone"], store.Logged.OrderBy(x => x.Id).Select(x => x.Result).ToArray());
        Assert.Equal((2, 1), (store.Logged.Single(x => x.Id == 1).Devices, store.Logged.Single(x => x.Id == 1).Delivered));
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound, "{}", true)]
    [InlineData(HttpStatusCode.BadRequest, "{\"error\":{\"details\":[{\"errorCode\":\"UNREGISTERED\"}]}}", true)]
    [InlineData(HttpStatusCode.BadRequest, "{\"error\":{\"message\":\"The registration token is not a valid FCM registration token\"}}", true)]
    [InlineData(HttpStatusCode.BadRequest, "{\"error\":{\"message\":\"Invalid JSON payload\"}}", false)]
    [InlineData(HttpStatusCode.ServiceUnavailable, "{}", false)]
    [InlineData(HttpStatusCode.TooManyRequests, "{}", false)]
    public void Only_dead_devices_lose_their_token(HttpStatusCode status, string body, bool gone) =>
        Assert.Equal(gone, FirebaseMessaging.IsTokenGone(status, body));

    [Fact]
    public void The_sign_in_assertion_is_a_valid_RS256_token()
    {
        using var rsa = RSA.Create(2048);
        var jwt = FirebaseMessaging.Assertion("svc@x.iam.gserviceaccount.com", rsa.ExportPkcs8PrivateKeyPem(),
            "https://oauth2.googleapis.com/token", DateTimeOffset.FromUnixTimeSeconds(1_800_000_000));
        var parts = jwt.Split('.');
        Assert.Equal(3, parts.Length);
        static byte[] D(string s) => Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/').PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
        var claims = JsonDocument.Parse(D(parts[1])).RootElement;
        Assert.Equal("svc@x.iam.gserviceaccount.com", claims.GetProperty("iss").GetString());
        Assert.Equal("https://www.googleapis.com/auth/firebase.messaging", claims.GetProperty("scope").GetString());
        Assert.Equal(3600, claims.GetProperty("exp").GetInt64() - claims.GetProperty("iat").GetInt64());
        Assert.True(rsa.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), D(parts[2]), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
    }
}
