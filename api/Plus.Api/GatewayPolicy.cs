using System.Net;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Plus.Api;

public sealed partial class GatewayPolicy(IOptionsMonitor<GatewayOptions> options, IOperationPermissionStore permissions)
{
    public static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "User", "Username", "IP", "ClientIP", "AccessZone", "DbKey", "Database", "Operation",
        "LineData", "SqlStatement", "State", "Message"
    };

    // These legacy entry points must never be made public through configuration.
    private static readonly HashSet<string> BlockedOperations = new(StringComparer.OrdinalIgnoreCase)
    {
        "ExecuteScript", "Login", "SaveSystemUser", "DeleteSystemUser"
    };

    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_]{0,127}\.[A-Za-z_][A-Za-z0-9_]{0,127}$")]
    private static partial Regex ProcedureName();

    public string Zone(IPAddress? ip)
    {
        if (ip is null) return "external";
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return options.CurrentValue.InternalNetworks.Any(x => IPNetwork.Parse(x).Contains(ip))
            ? "internal" : "external";
    }

    public IdentityGrant? Grant(DatabaseOptions db, ClaimsPrincipal user) =>
        db.Users.SingleOrDefault(x => x.Enabled && x.Subject == user.FindFirstValue("sub")
            && x.Issuer == user.FindFirstValue("iss") && !string.IsNullOrWhiteSpace(x.Username));

    public async Task<ExecutionContext> AuthorizeAsync(ExecRequest request, ClaimsPrincipal user, IPAddress? ip,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(request.Database) || string.IsNullOrWhiteSpace(request.Proc)
            || string.IsNullOrWhiteSpace(request.Operation) || request.Operation.Length > 100
            || request.Operation != request.Operation.Trim() || !ProcedureName().IsMatch(request.Proc))
            throw new GatewayException(400, "A database key, schema-qualified procedure and operation are required.");
        if (user.Identity?.IsAuthenticated != true || string.IsNullOrWhiteSpace(user.FindFirstValue("sub")))
            throw new GatewayException(401, "Authentication required.");
        if (user.HasClaim("force_password_change", "true"))
            throw new GatewayException(403, "Password change required.");
        if (request.Proc.Equals("PLS.APIPlusAuthSessionOperation", StringComparison.OrdinalIgnoreCase)
            || (user.HasClaim("local_session_validated", "true") && user.FindFirstValue("db") != request.Database)) Deny();
        var zone = Zone(ip);
        if (!options.CurrentValue.Databases.TryGetValue(request.Database, out var db) || !db.Enabled
            || (zone == "external" && !db.AllowExternal)) Deny();
        // Local identity claims are trusted only after SQL session validation in JWT middleware.
        var local = user.HasClaim("local_session_validated", "true")
            && db!.LocalLoginEnabled && user.FindFirstValue("db") == request.Database;
        var grant = local ? new IdentityGrant { Username = user.FindFirstValue("erp_user") ?? "" } : Grant(db!, user);
        if (grant is null || BlockedOperations.Contains(request.Operation)) Deny();
        OperationOptions? allowed = null;
        if (db!.UseSqlOperationPermissions)
            allowed = await permissions.FindAsync(db, request.Proc, request.Operation, cancellationToken);
        else if (db.Procedures.TryGetValue(request.Proc, out var procedure))
            procedure.Operations.TryGetValue(request.Operation, out allowed);
        // SQL mode never falls back to configuration, including on missing/disabled rows.
        if (allowed is null || !allowed.Enabled || (zone == "external" && !allowed.AllowExternal))
            throw new GatewayException(403, "Database or operation access denied.");
        if (request.LineData.ValueKind is not (System.Text.Json.JsonValueKind.Undefined
            or System.Text.Json.JsonValueKind.Null or System.Text.Json.JsonValueKind.Object
            or System.Text.Json.JsonValueKind.Array))
            throw new GatewayException(400, "lineData must be an object, array or null.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in request.ExtraParams?.Keys.AsEnumerable() ?? [])
        {
            if (!names.Add(name) || Reserved.Contains(name)
                || !allowed.AllowedParameters.Contains(name, StringComparer.OrdinalIgnoreCase))
                throw new GatewayException(400, "An extra parameter is duplicate, reserved or not allowed.");
        }
        return new(db, request.Database, request.Proc, allowed, grant!.Username,
            ip?.ToString() ?? "", zone);
    }

    private static void Deny() => throw new GatewayException(403, "Database or operation access denied.");
}
