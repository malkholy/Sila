using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Xunit;

namespace Plus.Api.Tests;

public sealed class SqlPermissionTests
{
    private static async Task<HttpStatusCode> Execute(GatewayFactory factory, string operation = "View",
        object? extraParams = null)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());
        var response = await client.PostAsJsonAsync("/api/v2/exec", new
        {
            database = "MEGA25", proc = "Pls.TestOperation", operation, lineData = new { }, extraParams
        });
        return response.StatusCode;
    }

    [Fact]
    public async Task Sql_permissions_apply_changes_on_next_request_and_never_fall_back()
    {
        using var factory = new GatewayFactory(sqlPermissions: true);
        Assert.Equal(HttpStatusCode.Forbidden, await Execute(factory)); // Config allows View, SQL has no row.
        factory.Permissions.Permission = new() { Enabled = true, AllowExternal = true };
        Assert.Equal(HttpStatusCode.OK, await Execute(factory));
        factory.Permissions.Permission.Enabled = false;
        Assert.Equal(HttpStatusCode.Forbidden, await Execute(factory));
        Assert.Equal(1, factory.Executor.Calls);
        Assert.Equal(3, factory.Permissions.Calls);
    }

    [Fact]
    public async Task Sql_external_and_extra_parameter_restrictions_are_enforced()
    {
        using var factory = new GatewayFactory(sqlPermissions: true);
        factory.Permissions.Permission = new() { Enabled = true };
        Assert.Equal(HttpStatusCode.Forbidden, await Execute(factory));
        factory.Permissions.Permission.AllowExternal = true;
        Assert.Equal(HttpStatusCode.BadRequest, await Execute(factory, extraParams: new { LineMember = "x" }));
        factory.Permissions.Permission.AllowedParameters = ["LineMember"];
        Assert.Equal(HttpStatusCode.OK, await Execute(factory, extraParams: new { LineMember = "x" }));
        Assert.Equal(1, factory.Executor.Calls);
    }

    [Theory]
    [InlineData("ExecuteScript")]
    [InlineData("Login")]
    [InlineData("SaveSystemUser")]
    [InlineData("DeleteSystemUser")]
    public async Task Sql_permissions_cannot_enable_blocked_operations(string operation)
    {
        using var factory = new GatewayFactory(sqlPermissions: true);
        factory.Permissions.Permission = new() { Enabled = true, AllowExternal = true };
        Assert.Equal(HttpStatusCode.Forbidden, await Execute(factory, operation));
        Assert.Equal(0, factory.Permissions.Calls);
        Assert.Equal(0, factory.Executor.Calls);
    }

    [Fact]
    public async Task Permission_store_failure_never_executes_business_SQL()
    {
        using var factory = new GatewayFactory(sqlPermissions: true);
        factory.Permissions.Error = new InvalidOperationException("store unavailable");
        Assert.Equal(HttpStatusCode.InternalServerError, await Execute(factory));
        Assert.Equal(0, factory.Executor.Calls);
    }
}
