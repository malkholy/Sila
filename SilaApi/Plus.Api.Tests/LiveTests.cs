using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Plus.Api.Auth;
using Xunit;

namespace Plus.Api.Tests;

public sealed class LiveTests
{
    private static async Task<TokenResponse> Login(HttpClient client)
    {
        var response = await client.PostAsJsonAsync("/api/v2/auth/login",
            new { database = "MEGA25", username = "ERP_USER", password = "Example-test-password-123" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<TokenResponse>())!;
    }

    private static async Task<HttpResponseMessage> RequestTicket(HttpClient client, string? token, string database = "MEGA25")
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/live/ticket")
        {
            Content = JsonContent.Create(new { database })
        };
        if (token is not null) request.Headers.Authorization = new("Bearer", token);
        return await client.SendAsync(request);
    }

    private static async Task<string> Ticket(HttpClient client, string token)
    {
        var response = await RequestTicket(client, token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return json.RootElement.GetProperty("ticket").GetString()!;
    }

    private static Task<WebSocket> Connect(GatewayFactory factory, string ticket, string? origin = "https://app.example.test")
    {
        var client = factory.Server.CreateWebSocketClient();
        if (origin is not null) client.ConfigureRequest = request => request.Headers.Origin = origin;
        return client.ConnectAsync(new Uri(factory.Server.BaseAddress, $"api/v2/live?ticket={Uri.EscapeDataString(ticket)}"),
            CancellationToken.None);
    }

    // Next text frame as JSON, or null when the server closed the socket.
    private static async Task<JsonElement?> Next(WebSocket socket, int seconds = 10)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
        var buffer = new byte[8192];
        var result = await socket.ReceiveAsync(buffer, timeout.Token);
        if (result.MessageType == WebSocketMessageType.Close) return null;
        return JsonDocument.Parse(Encoding.UTF8.GetString(buffer, 0, result.Count)).RootElement.Clone();
    }

    private static Task Send(WebSocket socket, string text) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    [Fact]
    public async Task Ticket_requires_a_signed_in_local_session()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await RequestTicket(client, null)).StatusCode);
        var token = await Login(client);
        Assert.Equal(HttpStatusCode.Forbidden, (await RequestTicket(client, token.AccessToken, "OTHER")).StatusCode);
    }

    [Fact]
    public async Task External_tokens_get_no_ticket()
    {
        using var factory = new GatewayFactory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Forbidden, (await RequestTicket(client, factory.Token())).StatusCode);
    }

    [Fact]
    public async Task Connect_says_hello_with_the_user_from_the_session_and_answers_ping()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var token = await Login(client);
        using var socket = await Connect(factory, await Ticket(client, token.AccessToken));
        var hello = (await Next(socket))!.Value;
        Assert.Equal("hello", hello.GetProperty("type").GetString());
        Assert.Equal("ERP_USER", hello.GetProperty("user").GetString());
        Assert.Contains("ERP_USER", hello.GetProperty("online").EnumerateArray().Select(x => x.GetString()));
        await Send(socket, """{"type":"ping"}""");
        Assert.Equal("pong", (await Next(socket))!.Value.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Ticket_is_single_use()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var ticket = await Ticket(client, (await Login(client)).AccessToken);
        using var first = await Connect(factory, ticket);
        await Assert.ThrowsAnyAsync<Exception>(() => Connect(factory, ticket));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-ticket")]
    public async Task Unknown_ticket_is_refused(string ticket)
    {
        using var factory = new GatewayFactory(true);
        await Assert.ThrowsAnyAsync<Exception>(() => Connect(factory, ticket));
    }

    [Fact]
    public async Task Foreign_origin_is_refused_and_burns_no_ticket()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var ticket = await Ticket(client, (await Login(client)).AccessToken);
        await Assert.ThrowsAnyAsync<Exception>(() => Connect(factory, ticket, "https://evil.example.test"));
        using var socket = await Connect(factory, ticket);
        Assert.Equal("hello", (await Next(socket))!.Value.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Connections_per_user_are_limited()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var token = (await Login(client)).AccessToken;
        var open = new List<WebSocket>();
        for (var i = 0; i < 3; i++) open.Add(await Connect(factory, await Ticket(client, token)));
        await Assert.ThrowsAnyAsync<Exception>(async () => await Connect(factory, await Ticket(client, token)));
        open.ForEach(x => x.Dispose());
    }

    [Fact]
    public async Task Logout_closes_the_socket_with_session_ended()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        var token = await Login(client);
        using var socket = await Connect(factory, await Ticket(client, token.AccessToken));
        await Next(socket);   // hello
        var logout = new HttpRequestMessage(HttpMethod.Post, "/api/v2/auth/logout");
        logout.Headers.Authorization = new("Bearer", token.AccessToken);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(logout)).StatusCode);
        Assert.Null(await Next(socket));
        Assert.Equal(4401, (int)socket.CloseStatus!);
    }

    [Fact]
    public async Task Disabled_account_is_dropped_on_revalidation()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        using var socket = await Connect(factory, await Ticket(client, (await Login(client)).AccessToken));
        await Next(socket);   // hello
        factory.AuthStore.Disabled = true;
        Assert.Null(await Next(socket));
        Assert.Equal(4401, (int)socket.CloseStatus!);
    }

    [Fact]
    public async Task Oversized_frame_closes_with_message_too_big()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        using var socket = await Connect(factory, await Ticket(client, (await Login(client)).AccessToken));
        await Next(socket);   // hello
        await Send(socket, "{\"type\":\"" + new string('x', 400) + "\"}");
        Assert.Null(await Next(socket));
        Assert.Equal(WebSocketCloseStatus.MessageTooBig, socket.CloseStatus);
    }

    [Fact]
    public async Task Flooding_closes_with_policy_violation()
    {
        using var factory = new GatewayFactory(true);
        using var client = factory.CreateClient();
        using var socket = await Connect(factory, await Ticket(client, (await Login(client)).AccessToken));
        await Next(socket);   // hello
        for (var i = 0; i < 6; i++) await Send(socket, """{"type":"noise"}""");
        Assert.Null(await Next(socket));
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, socket.CloseStatus);
    }
}
