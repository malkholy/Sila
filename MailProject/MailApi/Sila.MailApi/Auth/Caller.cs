using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

namespace Sila.MailApi;

// The Sila login token (issued by SilaApi :7400): checked here by its signature
// (7400's public key -- Authentication:PublicKeyPath or PublicKeyPem), issuer,
// audience, type and expiry. The session itself is not re-checked with 7400
// (the inside copy cannot reach it): a signed-out session keeps working until
// its short-lived access token expires.
public static class Caller
{
    // The Sila username of a valid caller, or null.
    public static string? Username(ClaimsPrincipal user, MailApiOptions options)
    {
        if (user.Identity?.IsAuthenticated != true) return null;
        if (!string.Equals(user.FindFirstValue("db"), options.Database, StringComparison.OrdinalIgnoreCase)) return null;
        if (user.HasClaim("force_password_change", "true")) return null;
        var username = user.FindFirstValue("erp_user");
        return string.IsNullOrWhiteSpace(username) || username.Length > 50 ? null : username;
    }

    public static void AddSilaToken(this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment)
    {
        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
        {
            options.MapInboundClaims = false;
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidIssuer = configuration["Authentication:Issuer"],
                ValidAudience = configuration["Authentication:Audience"] ?? "plus-api-v2",
                IssuerSigningKey = SigningKey(configuration, environment),
                ValidateIssuerSigningKey = true,
                ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
                ValidTypes = ["at+jwt"],
                RequireExpirationTime = true,
                ClockSkew = TimeSpan.FromMinutes(1),
                NameClaimType = "erp_user",
            };
        });
        // Every user endpoint: a valid Sila caller (the database, no pending password change, a username).
        services.AddAuthorization(o => o.DefaultPolicy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder()
            .RequireAuthenticatedUser()
            .RequireAssertion(c => Username(c.User, new MailApiOptions { Database = configuration["MailApi:Database"] ?? "SILA101" }) is not null)
            .Build());
    }

    // 7400's public key. Without one no token is accepted (a random key nobody has).
    private static SecurityKey SigningKey(IConfiguration configuration, IHostEnvironment environment)
    {
        var pem = configuration["Authentication:PublicKeyPem"];
        var path = configuration["Authentication:PublicKeyPath"];
        if (string.IsNullOrWhiteSpace(pem) && !string.IsNullOrWhiteSpace(path))
        {
            var full = Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
            if (File.Exists(full)) pem = File.ReadAllText(full);
        }
        var rsa = RSA.Create();
        if (!string.IsNullOrWhiteSpace(pem)) rsa.ImportFromPem(pem);
        return new RsaSecurityKey(rsa);
    }
}
