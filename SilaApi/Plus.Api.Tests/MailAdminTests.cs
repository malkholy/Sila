using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Plus.Api.MailAdmin;
using Xunit;

namespace Plus.Api.Tests;

// Test only: the caller's address comes from a request header, first in the pipeline.
public sealed class TestClientIp : IStartupFilter
{
    public const string Header = "X-Test-Client-IP";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (context, call) =>
        {
            if (IPAddress.TryParse(context.Request.Headers[Header], out var ip)) context.Connection.RemoteIpAddress = ip;
            await call(context);
        });
        next(app);
    };
}

public sealed class MailAdminTests
{
    private const string Key = "0123456789abcdef0123456789abcdef";
    private const string Office = "10.1.20.30";        // in MailAdmin:AllowedNetworks (10.1.0.0/16)
    private const string Company = "203.0.113.7";      // the connector's address (MailAdmin:ConnectorNetworks)

    private const string Snapshot = """
        {"overview":{"accounts":{"Mailboxes":1}},"accounts":[{"UserID":4,"SmtpAddress":"m@example.test"}],
         "errors":[],"details":{"4":{"account":{"UserID":4},"folders":[]}}}
        """;

    private static (WebApplicationFactory<Program> Factory, GatewayFactory Gateway) Create(string adminUser = "ERP_USER", bool configured = true,
        string? anyNetworkUser = null)
    {
        MailAdminEndpoints.DetailsWait = TimeSpan.FromSeconds(1);
        var gateway = new GatewayFactory();
        var factory = gateway.WithWebHostBuilder(b =>
        {
            b.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["MailAdmin:ConnectorKey"] = configured ? Key : "",
                ["MailAdmin:ConnectorNetworks:0"] = "203.0.113.0/24",
                ["MailAdmin:Database"] = "MEGA25",
                ["MailAdmin:Users:0"] = adminUser,
                ["MailAdmin:AllowedNetworks:0"] = "10.1.0.0/16",
                ["MailAdmin:AnyNetworkUsers:0"] = anyNetworkUser,
            }));
            b.ConfigureTestServices(services => services.AddTransient<IStartupFilter, TestClientIp>());
        });
        return (factory, gateway);
    }

    private static async Task<(HttpStatusCode Status, string Body)> Admin(WebApplicationFactory<Program> factory, GatewayFactory gateway,
        object body, bool signedIn = true, string ip = Office)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/mail/admin") { Content = JsonContent.Create(body) };
        if (signedIn) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", gateway.Token());
        request.Headers.Add(TestClientIp.Header, ip);
        var response = await factory.CreateClient().SendAsync(request);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    private static async Task<(HttpStatusCode Status, string Body)> Push(WebApplicationFactory<Program> factory, string json = Snapshot,
        string? key = Key, string ip = Company)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/mail/monitor/push")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        if (key is not null) request.Headers.Add("X-Connector-Key", key);
        request.Headers.Add(TestClientIp.Header, ip);
        var response = await factory.CreateClient().SendAsync(request);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task The_screen_shows_the_last_push()
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
        {
            Assert.Equal(HttpStatusCode.OK, (await Push(factory)).Status);
            var (status, body) = await Admin(factory, gateway, new { action = "overview" });
            Assert.Equal(HttpStatusCode.OK, status);
            var root = JsonDocument.Parse(body).RootElement;
            Assert.Equal(1, root.GetProperty("data").GetProperty("accounts").GetProperty("Mailboxes").GetInt32());
            Assert.True(root.GetProperty("pushedAt").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(-1));
            var accounts = JsonDocument.Parse((await Admin(factory, gateway, new { action = "accounts" })).Body).RootElement;
            Assert.Equal("m@example.test", accounts.GetProperty("data")[0].GetProperty("SmtpAddress").GetString());
        }
    }

    [Fact]
    public async Task Before_any_push_the_screen_says_so()
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
        {
            var (status, body) = await Admin(factory, gateway, new { action = "overview" });
            Assert.Equal(HttpStatusCode.ServiceUnavailable, status);
            Assert.Contains("has not reported yet", body);
        }
    }

    [Fact]
    public async Task Mailbox_details_are_asked_for_and_served_once_pushed()
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
        {
            await Push(factory, """{"overview":{},"accounts":[],"errors":[]}""");
            // not pushed yet: the wait runs out, and the connector is told to send it
            Assert.Equal(HttpStatusCode.GatewayTimeout, (await Admin(factory, gateway, new { action = "account", userId = 4 })).Status);
            var (_, answer) = await Push(factory, """{"overview":{},"accounts":[],"errors":[]}""");
            Assert.Equal([4], JsonDocument.Parse(answer).RootElement.GetProperty("wantDetails").EnumerateArray().Select(x => x.GetInt32()));
            // the connector sends it: now it is served
            await Push(factory);
            var (status, body) = await Admin(factory, gateway, new { action = "account", userId = 4 });
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.Equal(4, JsonDocument.Parse(body).RootElement.GetProperty("data").GetProperty("account").GetProperty("UserID").GetInt32());
        }
    }

    [Fact]
    public async Task Sync_now_is_handed_to_the_connector_once()
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
        {
            Assert.Equal(HttpStatusCode.OK, (await Admin(factory, gateway, new { action = "sync", userId = 4 })).Status);
            var syncs = JsonDocument.Parse((await Push(factory)).Body).RootElement.GetProperty("syncs");
            Assert.Equal(4, syncs[0].GetProperty("userId").GetInt32());
            Assert.Equal("ERP_USER", syncs[0].GetProperty("requestedBy").GetString());   // from the token
            Assert.Equal(0, JsonDocument.Parse((await Push(factory)).Body).RootElement.GetProperty("syncs").GetArrayLength());
        }
    }

    [Fact]
    public async Task A_signed_out_caller_is_refused()
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
            Assert.Equal(HttpStatusCode.Unauthorized, (await Admin(factory, gateway, new { action = "overview" }, signedIn: false)).Status);
    }

    [Fact]
    public async Task A_user_who_is_not_a_mail_admin_is_refused()
    {
        var (factory, gateway) = Create(adminUser: "someone_else");
        using (gateway) using (factory)
        {
            await Push(factory);
            Assert.Equal(HttpStatusCode.Forbidden, (await Admin(factory, gateway, new { action = "overview" })).Status);
        }
    }

    [Theory]
    [InlineData("45.63.120.200")]     // the internet
    [InlineData("10.2.0.5")]          // a 10.x range that is not in the list
    public async Task A_mail_admin_outside_the_company_network_is_refused(string ip)
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
        {
            await Push(factory);
            var (status, body) = await Admin(factory, gateway, new { action = "overview" }, ip: ip);
            Assert.Equal(HttpStatusCode.Forbidden, status);
            Assert.Contains($"company network (this server sees your address as {ip})", body);
        }
    }

    [Fact]
    public async Task A_mail_admin_in_AnyNetworkUsers_opens_it_from_outside()
    {
        var (factory, gateway) = Create(anyNetworkUser: "erp_user");
        using (gateway) using (factory)
        {
            await Push(factory);
            Assert.Equal(HttpStatusCode.OK, (await Admin(factory, gateway, new { action = "overview" }, ip: "45.63.120.200")).Status);
        }
    }

    [Fact]
    public async Task AnyNetworkUsers_does_not_make_someone_a_mail_admin()
    {
        var (factory, gateway) = Create(adminUser: "someone_else", anyNetworkUser: "ERP_USER");
        using (gateway) using (factory)
        {
            await Push(factory);
            Assert.Equal(HttpStatusCode.Forbidden, (await Admin(factory, gateway, new { action = "overview" }, ip: "45.63.120.200")).Status);
        }
    }

    [Theory]
    [InlineData("drop", null)]
    [InlineData("account", null)]        // needs a user
    [InlineData("account", -1)]
    [InlineData("../admin/overview", null)]
    public async Task Anything_else_is_refused(string action, int? userId)
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
            Assert.Equal(HttpStatusCode.BadRequest, (await Admin(factory, gateway, new { action, userId })).Status);
    }

    [Fact]
    public async Task Only_the_connector_may_push()
    {
        var (factory, gateway) = Create();
        using (gateway) using (factory)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await Push(factory, key: null)).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Push(factory, key: Key[..^1] + "X")).Status);
            Assert.Equal(HttpStatusCode.NotFound, (await Push(factory, ip: "45.63.120.200")).Status);    // not the company address
            Assert.Equal(HttpStatusCode.BadRequest, (await Push(factory, json: """{"overview":[]}""")).Status);
            Assert.Equal(HttpStatusCode.BadRequest, (await Push(factory, json: "not json")).Status);
            // nothing above was kept
            Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Admin(factory, gateway, new { action = "overview" })).Status);
        }
    }

    [Fact]
    public async Task Not_configured_means_off()
    {
        var (factory, gateway) = Create(configured: false);
        using (gateway) using (factory)
        {
            Assert.Equal(HttpStatusCode.NotFound, (await Push(factory)).Status);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Admin(factory, gateway, new { action = "overview" })).Status);
        }
    }
}
