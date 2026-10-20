using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Plus.Api.Auth;
using Xunit;

namespace Plus.Api.Tests;

// This double exercises the HTTP/session contract; it is not a SQL integration test.
public sealed class FakeAuthStore : IAuthStore
{
    private readonly object gate = new();
    private readonly Guid subject = Guid.NewGuid();
    private readonly Dictionary<Guid, AuthIdentity> sessions = [];
    private readonly Dictionary<string, (Guid Session, bool Used)> refresh = [];
    public bool Disabled { get; set; }
    public bool Forced { get; set; }
    public int Calls { get; private set; }
    public int Failures { get; private set; }
    public string Password { get; set; } = "Example-test-password-123";
    public Exception? Error { get; set; }
    public Task<AuthIdentity?> ExecuteAsync(AuthCommand request, CancellationToken cancellationToken)
    {
        lock (gate)
        {
            Calls++;
            if (Error is not null) throw Error;
            return Task.FromResult(Execute(request));
        }
    }

    private AuthIdentity? Execute(AuthCommand request)
    {
        if (Disabled || Failures >= 5) return null;
        if (request.Operation == "Login")
        {
            if (request.Username != "ERP_USER" || request.Password != Password) { Failures++; return null; }
            Failures = 0;
            var identity = new AuthIdentity(subject, request.SessionId!.Value, "ERP_USER", "Test User", Forced,
                DateTime.UtcNow.AddDays(7));
            sessions.Add(identity.SessionId, identity);
            refresh.Add(Convert.ToHexString(request.NewRefreshHash!), (identity.SessionId, false));
            return identity;
        }
        if (request.Operation == "Refresh")
        {
            var hash = Convert.ToHexString(request.RefreshHash!);
            if (!refresh.TryGetValue(hash, out var stored)) return null;
            if (stored.Used) { sessions.Remove(stored.Session); return null; }
            if (!sessions.TryGetValue(stored.Session, out var identity)) return null;
            refresh[hash] = (stored.Session, true);
            refresh.Add(Convert.ToHexString(request.NewRefreshHash!), (stored.Session, false));
            return identity;
        }
        if (!sessions.TryGetValue(request.SessionId ?? Guid.Empty, out var session)) return null;
        if (request.Operation == "Logout") { sessions.Remove(session.SessionId); return null; }
        if (request.Operation == "ChangePassword")
        {
            if (request.Password != Password) return null;
            Password = request.NewPassword!;
            Forced = false;
            sessions.Clear();
        }
        return session;
    }
}

public sealed class LocalAuthTests
{
    private static async Task<TokenResponse> Login(HttpClient client, string password = "Example-test-password-123")
    {
        var response = await client.PostAsJsonAsync("/api/v2/auth/login", new { database = "MEGA25", username = "ERP_USER", password });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<TokenResponse>())!;
    }

    private static Task<HttpResponseMessage> Exec(HttpClient client, string token, string database = "MEGA25")
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/exec")
        {
            Content = JsonContent.Create(new { database, proc = "Pls.TestOperation", operation = "View" })
        };
        request.Headers.Authorization = new("Bearer", token);
        return client.SendAsync(request);
    }

    [Fact]
    public async Task Login_issues_a_signed_database_bound_access_token()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var token = await Login(client);
        Assert.True(token.ExpiresAt <= DateTime.UtcNow.AddMinutes(5));
        Assert.Equal(43, token.RefreshToken.Length);
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token.AccessToken);
        Assert.Equal("at+jwt", jwt.Header.Typ);
        Assert.Equal("MEGA25", jwt.Claims.Single(x => x.Type == "db").Value);
        Assert.Equal(HttpStatusCode.OK, (await Exec(client, token.AccessToken)).StatusCode);
        Assert.Equal("ERP_USER", factory.Executor.LastContext!.Username);
        Assert.Equal(HttpStatusCode.Forbidden, (await Exec(client, token.AccessToken, "OTHER")).StatusCode);
    }

    [Fact]
    public async Task Logout_invalidates_access_and_refresh_tokens()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var token = await Login(client);
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/auth/logout");
        request.Headers.Authorization = new("Bearer", token.AccessToken);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(request)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Exec(client, token.AccessToken)).StatusCode);
        var response = await client.PostAsJsonAsync("/api/v2/auth/refresh", new { database = "MEGA25", refreshToken = token.RefreshToken });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Rotation_replaces_refresh_token_and_replay_revokes_session()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var original = await Login(client);
        var body = new { database = "MEGA25", refreshToken = original.RefreshToken };
        var response = await client.PostAsJsonAsync("/api/v2/auth/refresh", body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var rotated = (await response.Content.ReadFromJsonAsync<TokenResponse>())!;
        Assert.NotEqual(original.RefreshToken, rotated.RefreshToken);
        Assert.Equal(HttpStatusCode.OK, (await Exec(client, rotated.AccessToken)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/v2/auth/refresh", body)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Exec(client, rotated.AccessToken)).StatusCode);
    }

    [Fact]
    public async Task Disabled_account_is_denied_on_the_next_request()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var token = await Login(client);
        factory.AuthStore.Disabled = true;
        Assert.Equal(HttpStatusCode.Unauthorized, (await Exec(client, token.AccessToken)).StatusCode);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Fact]
    public async Task Forced_password_change_blocks_execution_and_revokes_old_sessions()
    {
        using var factory = new GatewayFactory(true);
        factory.AuthStore.Forced = true;
        using var client = factory.CreateClient();
        var token = await Login(client);
        Assert.True(token.MustChangePassword);
        Assert.Equal(HttpStatusCode.Forbidden, (await Exec(client, token.AccessToken)).StatusCode);
        var change = new HttpRequestMessage(HttpMethod.Post, "/api/v2/auth/change-password")
        {
            Content = JsonContent.Create(new { currentPassword = "Example-test-password-123", newPassword = "Replacement-test-password-456" })
        };
        change.Headers.Authorization = new("Bearer", token.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(change)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Exec(client, token.AccessToken)).StatusCode);
        var newToken = await Login(client, "Replacement-test-password-456");
        Assert.False(newToken.MustChangePassword);
        Assert.Equal(HttpStatusCode.OK, (await Exec(client, newToken.AccessToken)).StatusCode);
    }

    [Fact]
    public async Task Invalid_password_does_not_issue_tokens()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v2/auth/login", new { database = "MEGA25", username = "ERP_USER", password = "wrong" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.DoesNotContain("accessToken", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Session_store_unavailable_never_allows_execution()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var token = await Login(client);
        factory.AuthStore.Error = new InvalidOperationException("database secret");
        var response = await Exec(client, token.AccessToken);
        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain("database secret", await response.Content.ReadAsStringAsync());
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Theory]
    [InlineData("")]
    [InlineData("invalid")]
    [InlineData("...........................................")]
    public async Task Malformed_refresh_tokens_are_rejected_before_database_access(string token)
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v2/auth/refresh", new { database = "MEGA25", refreshToken = token });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(0, factory.AuthStore.Calls);
    }
}
