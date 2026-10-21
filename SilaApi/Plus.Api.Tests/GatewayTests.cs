using System.Data;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;
using Xunit;
using ExecutionContext = Plus.Api.ExecutionContext;
using Plus.Api.Auth;
using Plus.Api.Attachments;

namespace Plus.Api.Tests;

// verifyWith: build a verify-only Files API that trusts tokens issued by that
// (main, local-login) factory -- its public key only, sharing its session store.
public sealed class GatewayFactory(bool localLogin = false, bool sqlPermissions = false, GatewayFactory? verifyWith = null)
    : WebApplicationFactory<Program>
{
    public const string Issuer = "https://identity.example.test";
    public const string Subject = "global-user-47";
    public RSA Key { get; } = RSA.Create(2048);
    public FakeExecutor Executor { get; } = new();
    public FakeAuthStore AuthStore { get; } = verifyWith?.AuthStore ?? new();
    private readonly bool local = localLogin || verifyWith is not null;
    public FakePermissions Permissions { get; } = new();
    public FakeAttachmentStore AttachmentStore { get; } = new();
    public FakeLegacyFiles LegacyFiles { get; } = new(AttachmentTests.Pdf);
    public FakeScanner Scanner { get; } = new();
    public string StorageDir { get; } = Path.Combine(Path.GetTempPath(), $"plus-att-{Guid.NewGuid():N}");
    public string QuarantineDir { get; } = Path.Combine(Path.GetTempPath(), $"plus-quar-{Guid.NewGuid():N}");
    private readonly string keyPath = Path.Combine(Path.GetTempPath(), $"plus-api-test-{Guid.NewGuid()}.pem");
    public string? AuthenticationError { get; private set; }
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        if (verifyWith is not null) File.WriteAllText(keyPath + ".pub", verifyWith.Key.ExportSubjectPublicKeyInfoPem());
        else if (localLogin) File.WriteAllText(keyPath, Key.ExportPkcs8PrivateKeyPem());
        builder.UseEnvironment("Development");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Authentication:Issuer"] = Issuer,
            ["Authentication:Audience"] = "plus-api-v2",
            ["Authentication:LocalLoginEnabled"] = local.ToString(),
            ["Authentication:VerifyOnly"] = (verifyWith is not null).ToString(),
            ["Authentication:PublicKeyPath"] = keyPath + ".pub",
            ["Gateway:ExecEnabled"] = (verifyWith is null).ToString(),
            ["Authentication:SigningKeyPath"] = keyPath,
            ["Authentication:PublicKeyPem"] = local ? "" : Key.ExportSubjectPublicKeyInfoPem(),
            ["Gateway:InternalNetworks:0"] = "10.0.0.0/8",
            ["Gateway:InternalNetworks:1"] = "fd00::/8",
            ["Gateway:Databases:MEGA25:UseSqlOperationPermissions"] = sqlPermissions.ToString(),
            ["Gateway:Databases:MEGA25:Enabled"] = "true",
            ["Gateway:Databases:MEGA25:LocalLoginEnabled"] = local.ToString(),
            ["Gateway:Databases:MEGA25:AllowExternal"] = "true",
            ["Gateway:Databases:MEGA25:Users:0:Enabled"] = "true",
            ["Gateway:Databases:MEGA25:Users:0:Issuer"] = Issuer,
            ["Gateway:Databases:MEGA25:Users:0:Subject"] = Subject,
            ["Gateway:Databases:MEGA25:Users:0:Username"] = "ERP_USER",
            ["Gateway:Databases:MEGA25:Procedures:Pls.TestOperation:Operations:View:Enabled"] = "true",
            ["Gateway:Databases:MEGA25:Procedures:Pls.TestOperation:Operations:View:AllowExternal"] = "true",
            ["Gateway:Databases:MEGA25:Procedures:Pls.TestOperation:Operations:View:AllowedParameters:0"] = "LineMember",
            ["Gateway:Databases:MEGA25:Procedures:Pls.TestOperation:Operations:Internal:Enabled"] = "true",
            ["Gateway:Databases:MEGA25:Procedures:Pls.TestOperation:Operations:ExecuteScript:Enabled"] = "true",
            ["Gateway:Databases:MEGA25:Procedures:Pls.TestOperation:Operations:ExecuteScript:AllowExternal"] = "true",
            ["Attachments:StorageRoot"] = StorageDir,
            ["Attachments:QuarantineRoot"] = QuarantineDir,
            ["Attachments:MaxFileSizeBytes"] = "1048576",
            ["Attachments:RequireVirusScan"] = "true",
            ["Gateway:CorsOrigins:0"] = "https://app.example.test",
            ["Live:Enabled"] = "true",
            ["Live:MaxConnectionsPerUser"] = "3",
            ["Live:RevalidateSeconds"] = "1",
            ["Live:MaxMessageBytes"] = "256",
            ["Live:MaxMessagesPer10Seconds"] = "5"
        }));
        builder.ConfigureServices(services =>
        {
            services.PostConfigure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, options =>
                options.Events.OnAuthenticationFailed = context =>
                {
                    AuthenticationError = context.Exception.Message;
                    return Task.CompletedTask;
                });
            services.RemoveAll<IOperationPermissionStore>();
            services.AddSingleton<IOperationPermissionStore>(Permissions);
            services.RemoveAll<IProcedureExecutor>();
            services.AddSingleton<IProcedureExecutor>(Executor);
            services.RemoveAll<IAuthStore>();
            services.AddSingleton<IAuthStore>(AuthStore);
            services.RemoveAll<IAttachmentStore>();
            services.AddSingleton<IAttachmentStore>(AttachmentStore);
            services.RemoveAll<ILegacyFileSource>();
            services.AddSingleton<ILegacyFileSource>(LegacyFiles);
            services.RemoveAll<IVirusScanner>();
            services.AddSingleton<IVirusScanner>(Scanner);
        });
    }

    public string Token(string? issuer = null, string subject = Subject, string audience = "plus-api-v2",
        bool expired = false, bool forced = false, RSA? key = null, string type = "at+jwt")
    {
        var credentials = new SigningCredentials(new RsaSecurityKey(key ?? Key), SecurityAlgorithms.RsaSha256);
        var header = new JwtHeader(credentials) { ["typ"] = type };
        var claims = new List<Claim> { new("sub", subject), new("name", "Administrator") };
        if (forced) claims.Add(new("force_password_change", "true"));
        var payload = new JwtPayload(issuer ?? Issuer, audience, claims,
            DateTime.UtcNow.AddMinutes(-10), DateTime.UtcNow.AddMinutes(expired ? -5 : 5));
        return new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(header, payload));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            Key.Dispose();
            if (File.Exists(keyPath)) File.Delete(keyPath);
            if (File.Exists(keyPath + ".pub")) File.Delete(keyPath + ".pub");
            if (Directory.Exists(StorageDir)) Directory.Delete(StorageDir, true);
            if (Directory.Exists(QuarantineDir)) Directory.Delete(QuarantineDir, true);
        }
    }
}

public sealed class FakeExecutor : IProcedureExecutor
{
    public int Calls { get; private set; }
    public ExecutionContext? LastContext { get; private set; }
    public Exception? Error { get; set; }
    public ApiEnvelope Result { get; set; } = new(true, 0, "", [], []);
    public Task<ApiEnvelope> ExecuteAsync(ExecRequest request, ExecutionContext context, CancellationToken cancellationToken)
    {
        Calls++;
        LastContext = context;
        if (Error is not null) throw Error;
        return Task.FromResult(Result);
    }
}

public sealed class GatewayTests
{
    private const string ValidBody = """{"database":"MEGA25","proc":"Pls.TestOperation","operation":"View","lineData":{"PageGroupID":51},"extraParams":{"LineMember":[{"Amount":10}]}}""";

    [Fact]
    public async Task Health_is_available_without_executing_SQL()
    {
        using var factory = new GatewayFactory();
        var response = await factory.CreateClient().GetAsync("/health/live");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Fact]
    public void Network_classification_handles_ipv4_ipv6_and_unknown_addresses()
    {
        using var factory = new GatewayFactory();
        var policy = factory.Services.GetRequiredService<GatewayPolicy>();
        Assert.Equal("internal", policy.Zone(IPAddress.Parse("10.1.2.3")));
        Assert.Equal("internal", policy.Zone(IPAddress.Parse("::ffff:10.1.2.3")));
        Assert.Equal("internal", policy.Zone(IPAddress.Parse("fd00::1")));
        Assert.Equal("external", policy.Zone(IPAddress.Parse("192.0.2.10")));
        Assert.Equal("external", policy.Zone(null));
    }

    private static Task<HttpResponseMessage> Send(GatewayFactory factory, string? token, string body = ValidBody, bool spoofProxy = false)
    {
        var client = factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/exec")
        { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (spoofProxy) request.Headers.Add("X-Forwarded-For", "10.0.0.1");
        return client.SendAsync(request);
    }

    [Fact]
    public async Task Anonymous_request_never_reaches_executor()
    {
        using var factory = new GatewayFactory();
        var response = await Send(factory, null);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.False((await response.Content.ReadFromJsonAsync<ApiEnvelope>())!.Ok);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Fact]
    public async Task Valid_token_uses_mapped_database_username()
    {
        using var factory = new GatewayFactory();
        var response = await Send(factory, factory.Token());
        Assert.True(response.StatusCode == HttpStatusCode.OK, factory.AuthenticationError ?? response.StatusCode.ToString());
        Assert.Equal("ERP_USER", factory.Executor.LastContext!.Username);
        Assert.Equal("external", factory.Executor.LastContext.AccessZone);
        Assert.Equal(1, factory.Executor.Calls);
    }

    [Theory]
    [InlineData("issuer")]
    [InlineData("audience")]
    [InlineData("expiry")]
    [InlineData("signature")]
    [InlineData("id-token")]
    public async Task Invalid_tokens_are_rejected(string fault)
    {
        using var factory = new GatewayFactory();
        using var wrongKey = RSA.Create(2048);
        var token = factory.Token(issuer: fault == "issuer" ? "https://wrong.test" : null,
            audience: fault == "audience" ? "other-api" : "plus-api-v2", expired: fault == "expiry",
            key: fault == "signature" ? wrongKey : null, type: fault == "id-token" ? "JWT" : "at+jwt");
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send(factory, token)).StatusCode);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Theory]
    [InlineData("other-user", false)]
    [InlineData(GatewayFactory.Subject, true)]
    public async Task Unmapped_or_restricted_identity_is_denied(string subject, bool forced)
    {
        using var factory = new GatewayFactory();
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(factory, factory.Token(subject: subject, forced: forced))).StatusCode);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Theory]
    [InlineData("MEGA25", "Pls.TestOperation", "ExecuteScript")]
    [InlineData("OTHER", "Pls.TestOperation", "View")]
    [InlineData("MEGA25", "Pls.UnknownOperation", "View")]
    [InlineData("MEGA25", "Pls.TestOperation", "Delete")]
    [InlineData("MEGA25", "Pls.TestOperation", "Internal")]
    public async Task Unauthorized_targets_are_denied(string database, string proc, string operation)
    {
        using var factory = new GatewayFactory();
        var body = JsonSerializer.Serialize(new { database, proc, operation });
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(factory, factory.Token(), body, spoofProxy: true)).StatusCode);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Theory]
    [InlineData("User")]
    [InlineData("user")]
    [InlineData("IP")]
    [InlineData("SqlStatement")]
    [InlineData("Unknown")]
    public async Task Client_cannot_supply_reserved_or_unapproved_parameters(string name)
    {
        using var factory = new GatewayFactory();
        var body = JsonSerializer.Serialize(new { database = "MEGA25", proc = "Pls.TestOperation", operation = "View",
            extraParams = new Dictionary<string, string> { [name] = "admin" } });
        Assert.Equal(HttpStatusCode.BadRequest, (await Send(factory, factory.Token(), body)).StatusCode);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Fact]
    public async Task Unknown_top_level_properties_are_rejected()
    {
        using var factory = new GatewayFactory();
        var body = """{"database":"MEGA25","proc":"Pls.TestOperation","operation":"View","User":"admin"}""";
        Assert.Equal(HttpStatusCode.BadRequest, (await Send(factory, factory.Token(), body)).StatusCode);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Fact]
    public async Task Execution_failure_is_redacted_and_never_retried()
    {
        using var factory = new GatewayFactory();
        factory.Executor.Error = new InvalidOperationException("secret SQL and password");
        var response = await Send(factory, factory.Token());
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.DoesNotContain("secret", await response.Content.ReadAsStringAsync());
        Assert.Equal(1, factory.Executor.Calls);
    }

    [Fact]
    public async Task Business_failure_has_unsuccessful_http_status()
    {
        using var factory = new GatewayFactory();
        factory.Executor.Result = ApiEnvelope.Error("Not completed.");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Send(factory, factory.Token())).StatusCode);
    }

    [Fact]
    public void Binding_preserves_omission_null_and_structured_line_members()
    {
        ParameterMetadata[] metadata = [new("@User", SqlDbType.NVarChar, 100, 0, 0, false),
            new("@Operation", SqlDbType.VarChar, 100, 0, 0, false), new("@State", SqlDbType.Int, 4, 10, 0, true),
            new("@LineData", SqlDbType.NVarChar, -1, 0, 0, false), new("@LineMember", SqlDbType.NVarChar, -1, 0, 0, false)];
        var context = new ExecutionContext(new(), "MEGA25", "Pls.TestOperation", new(), "ERP_USER", "127.0.0.1", "external");
        using var omitted = new SqlCommand();
        ParameterBinder.Bind(omitted, metadata, new("MEGA25", "Pls.TestOperation", "View"), context);
        Assert.False(omitted.Parameters.Contains("@LineData"));
        using var explicitNull = new SqlCommand();
        var request = new ExecRequest("MEGA25", "Pls.TestOperation", "View", JsonSerializer.SerializeToElement<object?>(null),
            new() { ["LineMember"] = JsonSerializer.SerializeToElement(new[] { new { Amount = 10 } }) });
        ParameterBinder.Bind(explicitNull, metadata, request, context);
        Assert.Equal(DBNull.Value, explicitNull.Parameters["@LineData"].Value);
        Assert.Equal("[{\"Amount\":10}]", explicitNull.Parameters["@LineMember"].Value);
        Assert.Equal(-1, explicitNull.Parameters["@LineMember"].Size);
        Assert.Equal(ParameterDirection.Output, explicitNull.Parameters["@State"].Direction);
    }

    [Theory]
    [InlineData(SqlDbType.Int, "2147483648")]
    [InlineData(SqlDbType.TinyInt, "-1")]
    [InlineData(SqlDbType.Bit, "1")]
    [InlineData(SqlDbType.Date, "\"not-a-date\"")]
    [InlineData(SqlDbType.Decimal, "1.234")]
    [InlineData(SqlDbType.Decimal, "123456.00")]
    public void Invalid_typed_values_are_rejected(SqlDbType type, string json)
    {
        var metadata = new ParameterMetadata("@Value", type, 8, 6, 2, false);
        Assert.Equal(400, Assert.Throws<GatewayException>(() =>
            ParameterBinder.ConvertValue(metadata, JsonDocument.Parse(json).RootElement)).Status);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    public void Status_failure_overrides_success_output_and_discards_sensitive_results(int? statusResultSet)
    {
        var data = new Dictionary<string, List<Dictionary<string, object?>>>
        { ["List0"] = [new() { ["State"] = 1, ["Message"] = "sensitive SQL" }] };
        var result = ResultEnvelope.Create(data, new() { ["State"] = 0 }, statusResultSet);
        Assert.False(result.Ok);
        Assert.Empty(result.Data);
        Assert.DoesNotContain("sensitive", result.Message);
    }

    [Fact]
    public void Procedure_validation_message_from_output_parameters_is_returned()
    {
        var data = new Dictionary<string, List<Dictionary<string, object?>>>
        { ["List0"] = [new() { ["State"] = 1, ["Message"] = "Admin only" }] };
        var result = ResultEnvelope.Create(data, new() { ["State"] = 1, ["Message"] = "Admin only" }, null);
        Assert.False(result.Ok);
        Assert.Empty(result.Data);
        Assert.Equal("Admin only", result.Message);
    }

    [Theory]
    [InlineData(0, "Success")]
    [InlineData(1, "SQL Exception: Invalid column name 'Secret'. (Line: 12)")]
    [InlineData(1, "")]
    public void Catch_or_sql_error_messages_stay_hidden(int outputState, string outputMessage)
    {
        var data = new Dictionary<string, List<Dictionary<string, object?>>>
        { ["List0"] = [new() { ["State"] = 208, ["Message"] = "SQL Exception: Invalid column name 'Secret'." }] };
        var result = ResultEnvelope.Create(data, new() { ["State"] = outputState, ["Message"] = outputMessage }, null);
        Assert.False(result.Ok);
        Assert.Equal("The operation was not completed.", result.Message);
    }

    [Fact]
    public void Business_state_column_is_not_mistaken_for_execution_status()
    {
        var data = new Dictionary<string, List<Dictionary<string, object?>>>
        { ["List0"] = [new() { ["State"] = 10, ["DocumentID"] = 47 }] };
        Assert.True(ResultEnvelope.Create(data, new() { ["State"] = 0 }, null).Ok);
    }
}

public sealed class FakePermissions : IOperationPermissionStore
{
    public OperationOptions? Permission { get; set; }
    public Exception? Error { get; set; }
    public int Calls { get; private set; }
    public Task<OperationOptions?> FindAsync(DatabaseOptions database, string procedure, string operation,
        CancellationToken cancellationToken)
    {
        Calls++;
        if (Error is not null) throw Error;
        return Task.FromResult(Permission);
    }
}
