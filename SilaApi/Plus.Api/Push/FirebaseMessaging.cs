using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;

namespace Plus.Api.Push;

public enum PushResult { Sent, TokenGone, Failed }

public interface IPushTransport
{
    // false while the service account file is missing: the sender waits
    bool Ready { get; }
    Task<PushResult> SendAsync(JsonObject message, CancellationToken cancellationToken);
}

// Firebase Cloud Messaging HTTP v1 with a service account (Push:ServiceAccountPath,
// the JSON from Firebase console > Project settings > Service accounts; kept in
// App_Data, never in the repo): an OAuth access token from a self-signed JWT
// (RS256, scope firebase.messaging), reused until shortly before it expires.
public sealed class FirebaseMessaging(IHttpClientFactory clients, IOptionsMonitor<PushOptions> options, IHostEnvironment environment,
    ILogger<FirebaseMessaging> logger) : IPushTransport
{
    public const string ClientName = "firebase";
    private const string Scope = "https://www.googleapis.com/auth/firebase.messaging";
    private readonly SemaphoreSlim tokenLock = new(1, 1);
    private string? accessToken;
    private DateTimeOffset accessExpires;
    private ServiceAccount? account;

    private sealed record ServiceAccount(string ProjectId, string ClientEmail, string PrivateKey, string TokenUri);

    private string AccountPath()
    {
        var path = options.CurrentValue.ServiceAccountPath;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    public bool Ready => account is not null || File.Exists(AccountPath());

    private ServiceAccount Account()
    {
        if (account is not null) return account;
        var path = AccountPath();
        using var json = JsonDocument.Parse(File.ReadAllText(path));
        var r = json.RootElement;
        string Get(string name) => r.TryGetProperty(name, out var v) ? v.GetString() ?? "" : "";
        var a = new ServiceAccount(Get("project_id"), Get("client_email"), Get("private_key"),
            Get("token_uri") is { Length: > 0 } uri ? uri : "https://oauth2.googleapis.com/token");
        if (a.ProjectId == "" || a.ClientEmail == "" || a.PrivateKey == "")
            throw new InvalidOperationException("The Firebase service account file is incomplete.");
        return account = a;
    }

    // The signed assertion Google exchanges for an access token. Public for tests.
    public static string Assertion(string clientEmail, string privateKeyPem, string tokenUri, DateTimeOffset now)
    {
        static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var header = B64(JsonSerializer.SerializeToUtf8Bytes(new { alg = "RS256", typ = "JWT" }));
        var claims = B64(JsonSerializer.SerializeToUtf8Bytes(new
        {
            iss = clientEmail, scope = Scope, aud = tokenUri, iat = now.ToUnixTimeSeconds(), exp = now.AddMinutes(60).ToUnixTimeSeconds()
        }));
        using var rsa = RSA.Create();
        rsa.ImportFromPem(privateKeyPem);
        var signature = rsa.SignData(Encoding.ASCII.GetBytes($"{header}.{claims}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{claims}.{B64(signature)}";
    }

    private async Task<string> AccessToken(CancellationToken cancellationToken)
    {
        if (accessToken is not null && DateTimeOffset.UtcNow < accessExpires) return accessToken;
        await tokenLock.WaitAsync(cancellationToken);
        try
        {
            if (accessToken is not null && DateTimeOffset.UtcNow < accessExpires) return accessToken;
            var a = Account();
            using var response = await clients.CreateClient(ClientName).PostAsync(a.TokenUri, new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
                ["assertion"] = Assertion(a.ClientEmail, a.PrivateKey, a.TokenUri, DateTimeOffset.UtcNow),
            }), cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Firebase sign-in failed ({(int)response.StatusCode}).");
            using var json = JsonDocument.Parse(body);
            accessToken = json.RootElement.GetProperty("access_token").GetString();
            var seconds = json.RootElement.TryGetProperty("expires_in", out var e) ? e.GetInt32() : 3600;
            accessExpires = DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, seconds - 300));
            return accessToken!;
        }
        finally { tokenLock.Release(); }
    }

    public async Task<PushResult> SendAsync(JsonObject message, CancellationToken cancellationToken)
    {
        var a = Account();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"https://fcm.googleapis.com/v1/projects/{a.ProjectId}/messages:send")
        {
            Content = new StringContent(new JsonObject { ["message"] = message }.ToJsonString(), Encoding.UTF8, "application/json")
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await AccessToken(cancellationToken));
        using var response = await clients.CreateClient(ClientName).SendAsync(request, cancellationToken);
        if (response.IsSuccessStatusCode) return PushResult.Sent;
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (response.StatusCode == HttpStatusCode.Unauthorized) accessToken = null;   // signed in again next time
        var gone = IsTokenGone(response.StatusCode, body);
        if (!gone) logger.LogWarning("Firebase send failed {Status}", (int)response.StatusCode);
        return gone ? PushResult.TokenGone : PushResult.Failed;
    }

    // UNREGISTERED / NOT_FOUND, or an invalid registration token: the device is
    // gone and its token can be removed. Public for tests.
    public static bool IsTokenGone(HttpStatusCode status, string body)
    {
        if (status == HttpStatusCode.NotFound) return true;
        if (body.Contains("UNREGISTERED", StringComparison.Ordinal)) return true;
        return status == HttpStatusCode.BadRequest && body.Contains("registration token", StringComparison.OrdinalIgnoreCase);
    }
}
