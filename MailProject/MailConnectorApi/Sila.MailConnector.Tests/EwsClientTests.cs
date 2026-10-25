using System.Net;
using System.Text;
using System.Xml.Linq;
using Microsoft.Extensions.Options;
using Sila.MailConnector;
using Sila.MailConnector.Ews;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class StaticMonitor<T>(T value) : IOptionsMonitor<T>
{
    public T CurrentValue => value;
    public T Get(string? name) => value;
    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

// Answers every request with one canned EWS reply and keeps what was sent.
public sealed class FakeExchange(HttpStatusCode status, string body) : HttpMessageHandler
{
    public List<(HttpRequestMessage Request, string Body)> Sent { get; } = [];
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Sent.Add((request, await request.Content!.ReadAsStringAsync(ct)));
        return new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "text/xml") };
    }
}

public sealed class EwsClientTests
{
    private static readonly ExchangeOptions Settings = new()
    {
        EwsUrl = "https://exchange.example.test/EWS/Exchange.asmx",
        Domain = "EXAMPLE", Username = "svc-sila-mail", Password = "secret",
        AllowedDomains = ["example.test"],
    };

    private const string Envelope = """
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
                    xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
                    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
          <s:Body>{0}</s:Body>
        </s:Envelope>
        """;

    private const string InboxReply = """
        <m:GetFolderResponse><m:ResponseMessages>
          <m:GetFolderResponseMessage ResponseClass="Success">
            <m:ResponseCode>NoError</m:ResponseCode>
            <m:Folders><t:Folder>
              <t:FolderId Id="AAMkInbox" ChangeKey="AQAAAB" />
              <t:DisplayName>Inbox</t:DisplayName>
              <t:TotalCount>18402</t:TotalCount>
              <t:ChildFolderCount>3</t:ChildFolderCount>
              <t:UnreadCount>12</t:UnreadCount>
            </t:Folder></m:Folders>
          </m:GetFolderResponseMessage>
        </m:ResponseMessages></m:GetFolderResponse>
        """;

    private static (EwsClient Client, FakeExchange Exchange) Create(HttpStatusCode status, string body)
    {
        var exchange = new FakeExchange(status, string.Format(Envelope, body));
        return (new EwsClient(new HttpClient(exchange), new StaticMonitor<ExchangeOptions>(Settings)), exchange);
    }

    private static string ErrorReply(string code, string text) => $"""
        <m:GetFolderResponse><m:ResponseMessages>
          <m:GetFolderResponseMessage ResponseClass="Error">
            <m:MessageText>{text}</m:MessageText>
            <m:ResponseCode>{code}</m:ResponseCode>
          </m:GetFolderResponseMessage>
        </m:ResponseMessages></m:GetFolderResponse>
        """;

    [Fact]
    public async Task Reads_the_folder_and_its_counts()
    {
        var (client, _) = Create(HttpStatusCode.OK, InboxReply);
        var folder = await client.GetFolderAsync("mona@example.test", "inbox", CancellationToken.None);
        Assert.Equal(new FolderInfo("AAMkInbox", "AQAAAB", "Inbox", 18402, 12), folder);
    }

    [Fact]
    public async Task Impersonates_the_mailbox_and_routes_to_it()
    {
        var (client, exchange) = Create(HttpStatusCode.OK, InboxReply);
        await client.GetFolderAsync("mona@example.test", "inbox", CancellationToken.None);
        var (request, body) = Assert.Single(exchange.Sent);
        Assert.Equal("mona@example.test", request.Headers.GetValues("X-AnchorMailbox").Single());
        XNamespace t = "http://schemas.microsoft.com/exchange/services/2006/types";
        var xml = XDocument.Parse(body);
        Assert.Equal("mona@example.test", xml.Descendants(t + "SmtpAddress").Single().Value);
        Assert.Equal("Exchange2013_SP1", (string?)xml.Descendants(t + "RequestServerVersion").Single().Attribute("Version"));
        Assert.Equal("inbox", (string?)xml.Descendants(t + "DistinguishedFolderId").Single().Attribute("Id"));
    }

    [Fact]
    public void A_mailbox_value_never_becomes_markup()
    {
        var body = EwsClient.BuildEnvelope("Exchange2013_SP1", "a</t:SmtpAddress><x/>@example.test", new XElement("b"));
        XNamespace t = "http://schemas.microsoft.com/exchange/services/2006/types";
        var xml = XDocument.Parse(body);
        Assert.Equal("a</t:SmtpAddress><x/>@example.test", xml.Descendants(t + "SmtpAddress").Single().Value);
        Assert.Empty(xml.Descendants("x"));
    }

    [Theory]
    [InlineData("ErrorImpersonateUserDenied", EwsErrorKind.Permission)]
    [InlineData("ErrorNonExistentMailbox", EwsErrorKind.NotFound)]
    [InlineData("ErrorMailboxStoreUnavailable", EwsErrorKind.Connection)]
    [InlineData("ErrorSomethingNew", EwsErrorKind.Other)]
    public async Task Error_replies_are_classified(string code, EwsErrorKind kind)
    {
        var (client, _) = Create(HttpStatusCode.OK, ErrorReply(code, "Refused."));
        var error = await Assert.ThrowsAsync<EwsException>(() => client.GetFolderAsync("mona@example.test", "inbox", CancellationToken.None));
        Assert.Equal(kind, error.Kind);
        Assert.Equal(code, error.Code);
        Assert.Equal("Refused.", error.Message);
    }

    [Fact]
    public async Task Throttling_fault_carries_the_back_off()
    {
        const string fault = """
            <s:Fault>
              <faultcode xmlns:a="http://schemas.microsoft.com/exchange/services/2006/types">a:ErrorServerBusy</faultcode>
              <faultstring xml:lang="en-US">The server cannot service this request right now.</faultstring>
              <detail>
                <e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">ErrorServerBusy</e:ResponseCode>
                <e:Message xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">The server cannot service this request right now.</e:Message>
                <t:MessageXml><t:Value Name="BackOffMilliseconds">2500</t:Value></t:MessageXml>
              </detail>
            </s:Fault>
            """;
        var (client, _) = Create(HttpStatusCode.InternalServerError, fault);
        var error = await Assert.ThrowsAsync<EwsException>(() => client.GetFolderAsync("mona@example.test", "inbox", CancellationToken.None));
        Assert.Equal(EwsErrorKind.Throttling, error.Kind);
        Assert.Equal(2500, error.BackOffMilliseconds);
    }

    [Fact]
    public async Task A_refused_sign_in_is_an_authentication_error()
    {
        var (client, _) = Create(HttpStatusCode.Unauthorized, "");
        var error = await Assert.ThrowsAsync<EwsException>(() => client.GetFolderAsync("mona@example.test", "inbox", CancellationToken.None));
        Assert.Equal(EwsErrorKind.Authentication, error.Kind);
    }

    [Fact]
    public async Task Only_known_folders_are_asked_for()
    {
        var (client, exchange) = Create(HttpStatusCode.OK, InboxReply);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => client.GetFolderAsync("mona@example.test", "root\"/>", CancellationToken.None));
        Assert.Empty(exchange.Sent);
    }

    [Fact]
    public void The_service_account_never_signs_in_with_basic()
    {
        using var handler = EwsClient.CreateHandler(Settings);
        var uri = new Uri(Settings.EwsUrl);
        var credentials = Assert.IsType<CredentialCache>(handler.Credentials);
        Assert.NotNull(credentials.GetCredential(uri, "Negotiate"));
        Assert.NotNull(credentials.GetCredential(uri, "NTLM"));
        Assert.Null(credentials.GetCredential(uri, "Basic"));
        Assert.False(handler.AllowAutoRedirect);
    }

    [Theory]
    [InlineData("127.0.0.1", true)]
    [InlineData("::1", true)]
    [InlineData("::ffff:10.0.5.20", true)]      // IPv4 seen through IPv6
    [InlineData("10.0.5.21", false)]
    [InlineData("8.8.8.8", false)]
    public void Only_listed_networks_may_call(string ip, bool allowed)
    {
        var options = new AccessOptions { AllowedNetworks = ["127.0.0.1/32", "::1/128", "10.0.5.20/32"] };
        Assert.Equal(allowed, AccessOptions.IsAllowed(IPAddress.Parse(ip), options));
    }
}
