using System.Net;
using System.Text.Json;
using Xunit;

namespace Sila.MailApi.Tests;

public sealed class AdminTests
{
    private const string Snapshot = """
        {"overview":{"accounts":{"Mailboxes":1}},"accounts":[{"UserID":4,"SmtpAddress":"m@example.test"}],
         "errors":[],"details":{"4":{"account":{"UserID":4},"folders":[]}}}
        """;

    // ---- who may use the Mail Monitor (both roles) ----

    [Fact]
    public async Task Only_mail_admins_from_an_allowed_place()
    {
        using var app = new TestApp();
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.Admin(new { action = "overview" }, null)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.Admin(new { action = "overview" }, app.Token("someone_else"))).Status);
        var (status, body) = await app.Admin(new { action = "overview" }, app.Token(), ip: "45.63.120.200");
        Assert.Equal(HttpStatusCode.Forbidden, status);
        Assert.Contains("(this server sees your address as 45.63.120.200)", body);
        Assert.Empty(app.Connector.Calls);
    }

    [Fact]
    public async Task An_AnyNetworkUsers_admin_may_open_it_from_outside()
    {
        using var app = new TestApp(anyNetworkUser: "mhd");
        Assert.Equal(HttpStatusCode.OK, (await app.Admin(new { action = "overview" }, app.Token(), ip: "45.63.120.200")).Status);
    }

    // ---- Internal role: live figures, the connector on this server ----

    [Fact]
    public async Task Internal_figures_are_live()
    {
        using var app = new TestApp();
        var (status, body) = await app.Admin(new { action = "overview" }, app.Token());
        Assert.Equal(HttpStatusCode.OK, status);
        var root = JsonDocument.Parse(body).RootElement;
        Assert.Equal(1, root.GetProperty("data").GetProperty("accounts").GetProperty("Mailboxes").GetInt32());
        Assert.True(root.GetProperty("pushedAt").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(-1));
        Assert.Equal(HttpStatusCode.NotFound, (await app.Admin(new { action = "account", userId = 99 }, app.Token())).Status);
    }

    [Fact]
    public async Task Internal_add_asks_the_connector_and_answers_at_once()
    {
        using var app = new TestApp();
        var (status, body) = await app.Admin(new { action = "add", userId = 12, email = " Mona@Example.test ", username = "mona", displayName = "Mona" },
            app.Token());
        Assert.Equal(HttpStatusCode.OK, status);
        var root = JsonDocument.Parse(body).RootElement;
        Assert.True(root.GetProperty("done").GetBoolean());
        Assert.True(root.GetProperty("ok").GetBoolean());
        Assert.Equal(["add:12:mona@example.test:mona"], app.Connector.Calls);
    }

    [Theory]
    [InlineData("not-an-address", "mona")]
    [InlineData("a@b.test, c@d.test", "mona")]
    [InlineData("mona@example.test", "")]
    public async Task Add_needs_one_address_and_a_username(string email, string username)
    {
        using var app = new TestApp();
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Admin(new { action = "add", userId = 12, email, username }, app.Token())).Status);
        Assert.Empty(app.Connector.Calls);
    }

    [Fact]
    public async Task Internal_sync_goes_to_the_connector()
    {
        using var app = new TestApp();
        Assert.Equal(HttpStatusCode.OK, (await app.Admin(new { action = "sync", userId = 4 }, app.Token())).Status);
        Assert.Equal(["sync:4"], app.Connector.Calls);
    }

    // ---- External role: the pushed snapshot ----

    [Fact]
    public async Task External_serves_the_last_push()
    {
        using var app = new TestApp(role: "External");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await app.Admin(new { action = "overview" }, app.Token())).Status);
        Assert.Equal(HttpStatusCode.OK, (await app.Push(Snapshot)).Status);
        var root = JsonDocument.Parse((await app.Admin(new { action = "overview" }, app.Token())).Body).RootElement;
        Assert.Equal(1, root.GetProperty("data").GetProperty("accounts").GetProperty("Mailboxes").GetInt32());
        var account = JsonDocument.Parse((await app.Admin(new { action = "account", userId = 4 }, app.Token())).Body).RootElement;
        Assert.Equal(4, account.GetProperty("data").GetProperty("account").GetProperty("UserID").GetInt32());
    }

    [Fact]
    public async Task External_add_is_handed_over_and_its_answer_comes_back()
    {
        using var app = new TestApp(role: "External");
        var requestId = JsonDocument.Parse((await app.Admin(new { action = "add", userId = 12, email = "mona@example.test", username = "mona" },
            app.Token())).Body).RootElement.GetProperty("requestId").GetString()!;
        var adds = JsonDocument.Parse((await app.Push(Snapshot)).Body).RootElement.GetProperty("adds");
        Assert.Equal(("mona", "mhd"), (adds[0].GetProperty("username").GetString(), adds[0].GetProperty("requestedBy").GetString()));
        await app.Push($$"""
            {"overview":{},"accounts":[],"errors":[],
             "addResults":[{"requestId":"{{requestId}}","userId":12,"email":"mona@example.test","ok":true,"message":"Added."}]}
            """);
        var result = JsonDocument.Parse((await app.Admin(new { action = "addResult", requestId }, app.Token())).Body).RootElement;
        Assert.True(result.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task Only_the_connector_may_push_and_only_to_the_external_copy()
    {
        using (var external = new TestApp(role: "External"))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await external.Push(Snapshot, key: null)).Status);
            Assert.Equal(HttpStatusCode.NotFound, (await external.Push(Snapshot, ip: "45.63.120.200")).Status);
            Assert.Equal(HttpStatusCode.BadRequest, (await external.Push("""{"overview":[]}""")).Status);
        }
        using var inside = new TestApp(role: "Internal");
        Assert.Equal(HttpStatusCode.NotFound, (await inside.Push(Snapshot)).Status);
    }
}
