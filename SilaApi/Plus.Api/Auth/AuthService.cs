using System.Net;
using System.Security.Claims;
using Microsoft.Extensions.Options;

namespace Plus.Api.Auth;

public sealed class AuthService(LocalTokens tokens, IAuthStore store, GatewayPolicy policy,
    IOptionsMonitor<GatewayOptions> options)
{
    private string CheckDatabase(string? database, IPAddress? ip)
    {
        if (!tokens.Enabled) throw new GatewayException(503, "Local login is not configured.");
        if (string.IsNullOrWhiteSpace(database) || !options.CurrentValue.Databases.TryGetValue(database, out var db)
            || !db.Enabled || !db.LocalLoginEnabled || (policy.Zone(ip) == "external" && !db.AllowExternal))
            throw new GatewayException(403, "Database access denied.");
        return (ip?.IsIPv4MappedToIPv6 == true ? ip.MapToIPv4() : ip)?.ToString() ?? "";
    }

    public async Task<TokenResponse> Login(LoginRequest request, IPAddress? ip, CancellationToken cancellationToken)
    {
        var clientIp = CheckDatabase(request.Database, ip);
        if (string.IsNullOrWhiteSpace(request.Username) || request.Username.Length > 100
            || string.IsNullOrEmpty(request.Password) || request.Password.Length > 100)
            throw new GatewayException(400, "Username and password are required (maximum 100 characters).");
        var refresh = LocalTokens.NewRefreshToken();
        var identity = await store.ExecuteAsync(new("Login", request.Database, clientIp,
            request.Username, request.Password, Guid.NewGuid(), NewRefreshHash: LocalTokens.HashRefresh(refresh)), cancellationToken);
        if (identity is null) throw new GatewayException(401, "Invalid username or password, or account unavailable.");
        return tokens.Issue(request.Database, identity, refresh);
    }

    public async Task<TokenResponse> Refresh(RefreshRequest request, IPAddress? ip, CancellationToken cancellationToken)
    {
        var clientIp = CheckDatabase(request.Database, ip);
        if (string.IsNullOrEmpty(request.RefreshToken)) throw new GatewayException(401, "Invalid session.");
        var refresh = LocalTokens.NewRefreshToken();
        var identity = await store.ExecuteAsync(new("Refresh", request.Database, clientIp,
            RefreshHash: LocalTokens.HashRefresh(request.RefreshToken), NewRefreshHash: LocalTokens.HashRefresh(refresh)), cancellationToken);
        if (identity is null) throw new GatewayException(401, "Invalid session. Sign in again.");
        return tokens.Issue(request.Database, identity, refresh);
    }

    public async Task<bool> Validate(ClaimsPrincipal principal, IPAddress? ip, CancellationToken cancellationToken)
    {
        if (!tokens.Enabled || principal.FindFirstValue("auth_mode") != "local"
            || !Guid.TryParse(principal.FindFirstValue("sid"), out var sessionId)) return false;
        var database = principal.FindFirstValue("db");
        var clientIp = CheckDatabase(database, ip);
        var identity = await store.ExecuteAsync(new("Validate", database!, clientIp, SessionId: sessionId), cancellationToken);
        return identity is not null && identity.Subject.ToString() == principal.FindFirstValue("sub")
            && identity.Username == principal.FindFirstValue("erp_user")
            && (identity.ForcePasswordChange ? "true" : "false") == principal.FindFirstValue("force_password_change");
    }

    // Re-check a session that is not presenting a token (an open live socket).
    public async Task<AuthIdentity?> ValidateSession(string database, Guid sessionId, IPAddress? ip,
        CancellationToken cancellationToken)
    {
        var clientIp = CheckDatabase(database, ip);
        return await store.ExecuteAsync(new("Validate", database, clientIp, SessionId: sessionId), cancellationToken);
    }

    public async Task Logout(ClaimsPrincipal principal, IPAddress? ip, CancellationToken cancellationToken)
    {
        var database = principal.FindFirstValue("db");
        var clientIp = CheckDatabase(database, ip);
        if (!Guid.TryParse(principal.FindFirstValue("sid"), out var sessionId)) throw new GatewayException(401, "Invalid session.");
        await store.ExecuteAsync(new("Logout", database!, clientIp, SessionId: sessionId), cancellationToken);
    }

    public async Task ChangePassword(ChangePasswordRequest request, ClaimsPrincipal principal, IPAddress? ip, CancellationToken cancellationToken)
    {
        var database = principal.FindFirstValue("db");
        var clientIp = CheckDatabase(database, ip);
        if (string.IsNullOrEmpty(request.CurrentPassword) || request.CurrentPassword.Length > 100
            || string.IsNullOrEmpty(request.NewPassword) || request.NewPassword.Length is < 12 or > 100
            || request.NewPassword == request.CurrentPassword)
            throw new GatewayException(400, "Use a different password of 12 to 100 characters and provide the current password.");
        if (!Guid.TryParse(principal.FindFirstValue("sid"), out var sessionId)) throw new GatewayException(401, "Invalid session.");
        var result = await store.ExecuteAsync(new("ChangePassword", database!, clientIp,
            Password: request.CurrentPassword, SessionId: sessionId, NewPassword: request.NewPassword), cancellationToken);
        if (result is null) throw new GatewayException(401, "Password change failed. Sign in again.");
    }
}
