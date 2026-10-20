using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.IdentityModel.Tokens;

namespace Plus.Api.Auth;

public sealed class LocalTokens
{
    public bool Enabled { get; }
    public string Issuer { get; }
    public string Audience { get; }
    public SecurityKey? VerificationKey { get; }
    private readonly SigningCredentials? signing;

    public LocalTokens(IConfiguration config, IHostEnvironment environment)
    {
        Enabled = config.GetValue<bool>("Authentication:LocalLoginEnabled");
        Issuer = config["Authentication:Issuer"] ?? "";
        Audience = config["Authentication:Audience"] ?? "plus-api-v2";
        if (!Enabled) return;
        if (!Uri.TryCreate(Issuer, UriKind.Absolute, out var issuer) || issuer.Scheme != "https"
            || string.IsNullOrWhiteSpace(Audience))
            throw new InvalidOperationException("Local login requires an HTTPS Authentication:Issuer and an audience.");
        if (!string.IsNullOrWhiteSpace(config["Authentication:Authority"])
            || !string.IsNullOrWhiteSpace(config["Authentication:PublicKeyPem"]))
            throw new InvalidOperationException("Local login cannot be combined with external JWT verification.");
        var path = KeyPath(config, environment);
        if (!File.Exists(path))
            throw new InvalidOperationException("Initialize the local signing key first: dotnet Plus.Api.dll --initialize-auth");
        using var rsa = RSA.Create();
        rsa.ImportFromPem(File.ReadAllText(path));
        if (rsa.KeySize < 2048) throw new InvalidOperationException("Signing key must be at least 2048 bits.");
        signing = new(new RsaSecurityKey(rsa.ExportParameters(true)), SecurityAlgorithms.RsaSha256);
        VerificationKey = new RsaSecurityKey(rsa.ExportParameters(false));
    }

    public static string KeyPath(IConfiguration config, IHostEnvironment environment) =>
        Path.GetFullPath(config["Authentication:SigningKeyPath"] ?? "App_Data/auth-signing-key.pem", environment.ContentRootPath);

    public static void Initialize(IConfiguration config, IHostEnvironment environment)
    {
        var path = KeyPath(config, environment);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(path)) throw new InvalidOperationException("Signing key already exists; it has not been replaced.");
        using var rsa = RSA.Create(3072);
        var fileOptions = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows()) fileOptions.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using var writer = new StreamWriter(new FileStream(path, fileOptions));
        writer.Write(rsa.ExportPkcs8PrivateKeyPem());
    }

    public TokenResponse Issue(string database, AuthIdentity identity, string refreshToken)
    {
        if (!Enabled || signing is null) throw new GatewayException(503, "Local login is not configured.");
        var now = DateTime.UtcNow;
        var expiry = now.AddMinutes(5);
        if (expiry > identity.ExpiresAt) expiry = identity.ExpiresAt;
        Claim[] claims = [new("sub", identity.Subject.ToString()), new("sid", identity.SessionId.ToString()),
            new("db", database), new("erp_user", identity.Username), new("auth_mode", "local"),
            new("force_password_change", identity.ForcePasswordChange ? "true" : "false"),
            new("jti", Guid.NewGuid().ToString())];
        var jwt = new JwtSecurityToken(new JwtHeader(signing) { ["typ"] = "at+jwt" },
            new JwtPayload(Issuer, Audience, claims, now, expiry, now));
        return new(new JwtSecurityTokenHandler().WriteToken(jwt), refreshToken, "Bearer", expiry,
            identity.ExpiresAt, database, identity.Username, identity.DisplayName, identity.ForcePasswordChange);
    }

    public static string NewRefreshToken() => Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
    public static byte[] HashRefresh(string token)
    {
        if (token.Length != 43) throw new GatewayException(401, "Invalid session.");
        byte[] bytes;
        try { bytes = Base64UrlEncoder.DecodeBytes(token); }
        catch (FormatException) { throw new GatewayException(401, "Invalid session."); }
        if (bytes.Length != 32 || Base64UrlEncoder.Encode(bytes) != token)
            throw new GatewayException(401, "Invalid session.");
        return SHA256.HashData(bytes);
    }
}

public sealed record LoginRequest(string Database, string Username, string Password);
public sealed record RefreshRequest(string Database, string RefreshToken);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record TokenResponse(string AccessToken, string RefreshToken, string TokenType,
    DateTime ExpiresAt, DateTime SessionExpiresAt, string Database, string Username, string DisplayName, bool MustChangePassword);
public sealed record AuthIdentity(Guid Subject, Guid SessionId, string Username, string DisplayName,
    bool ForcePasswordChange, DateTime ExpiresAt);
public sealed record AuthCommand(string Operation, string Database, string ClientIp, string? Username = null,
    string? Password = null, Guid? SessionId = null, byte[]? RefreshHash = null,
    byte[]? NewRefreshHash = null, string? NewPassword = null);
public interface IAuthStore
{
    Task<AuthIdentity?> ExecuteAsync(AuthCommand command, CancellationToken cancellationToken);
}
