namespace Plus.Api;

public sealed class GatewayOptions
{
    public int CommandTimeoutSeconds { get; set; } = 30;
    public int MaxResultRows { get; set; } = 10000;
    public int MaxResultBytes { get; set; } = 8 * 1024 * 1024;
    public string[] InternalNetworks { get; set; } = [];
    public string[] KnownProxies { get; set; } = [];
    public string[] CorsOrigins { get; set; } = [];
    public Dictionary<string, DatabaseOptions> Databases { get; set; } = [];
}

public sealed class DatabaseOptions
{
    public string DisplayName { get; set; } = "";
    public string ConnectionStringName { get; set; } = "";
    public bool Enabled { get; set; }
    public bool AllowExternal { get; set; }
    public List<IdentityGrant> Users { get; set; } = [];
    public bool LocalLoginEnabled { get; set; }
    public bool UseSqlOperationPermissions { get; set; }
    public Dictionary<string, ProcedureOptions> Procedures { get; set; } = [];
}

public sealed class IdentityGrant
{
    public string Issuer { get; set; } = "";
    public string Subject { get; set; } = "";
    public string Username { get; set; } = "";
    public bool Enabled { get; set; }
}

public sealed class ProcedureOptions
{
    public Dictionary<string, OperationOptions> Operations { get; set; } = [];
}

public sealed class OperationOptions
{
    public bool Enabled { get; set; }
    public bool AllowExternal { get; set; }
    public string[] AllowedParameters { get; set; } = [];
    // Only declare a status result set after inspecting that operation's SQL contract.
    public int? StatusResultSet { get; set; }
}
