using System.Net;
using System.Text;
using Sila.MailConnector;
using Sila.MailConnector.Ews;
using Sila.MailConnector.Files;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class AttachmentTests
{
    private static string Answer(string inner) => $"""
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
                    xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
                    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
          <s:Body><m:GetAttachmentResponse><m:ResponseMessages>{inner}</m:ResponseMessages></m:GetAttachmentResponse></s:Body>
        </s:Envelope>
        """;

    private static string File(string name, string type, byte[] content) => Answer($"""
        <m:GetAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
          <m:Attachments><t:FileAttachment><t:AttachmentId Id="A1"/><t:Name>{name}</t:Name><t:ContentType>{type}</t:ContentType>
            <t:Content>{Convert.ToBase64String(content)}</t:Content></t:FileAttachment></m:Attachments>
        </m:GetAttachmentResponseMessage>
        """);

    private static async Task<(AttachmentDownload? Result, byte[] Written)> Read(string xml, long max = 1024 * 1024)
    {
        using var output = new MemoryStream();
        var result = await EwsClient.ReadAttachmentAsync(new MemoryStream(Encoding.UTF8.GetBytes(xml)), output, max, CancellationToken.None);
        return (result, output.ToArray());
    }

    [Fact]
    public async Task A_file_attachment_is_decoded_into_the_destination()
    {
        var bytes = Enumerable.Range(0, 200_000).Select(i => (byte)(i * 7)).ToArray();   // several base64 chunks
        var (result, written) = await Read(File("Invoice 12.pdf", "application/pdf", bytes));
        Assert.Equal(bytes, written);
        Assert.Equal(("Invoice 12.pdf", "application/pdf", 200_000L, false), (result!.Name, result.ContentType, result.Bytes, result.IsMessage));
    }

    [Fact]
    public async Task An_attached_message_comes_as_its_mime()
    {
        var mime = Encoding.UTF8.GetBytes("Subject: Hello\r\n\r\nBody");
        var (result, written) = await Read(Answer($"""
            <m:GetAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
              <m:Attachments><t:ItemAttachment><t:AttachmentId Id="A2"/><t:Name>Hello</t:Name>
                <t:Message><t:MimeContent CharacterSet="UTF-8">{Convert.ToBase64String(mime)}</t:MimeContent><t:Subject>Hello</t:Subject></t:Message>
              </t:ItemAttachment></m:Attachments>
            </m:GetAttachmentResponseMessage>
            """));
        Assert.Equal(mime, written);
        Assert.Equal(("Hello", "message/rfc822", true), (result!.Name, result.ContentType, result.IsMessage));
    }

    [Fact]
    public async Task An_error_answer_is_classified()
    {
        var error = await Assert.ThrowsAsync<EwsException>(() => Read(Answer("""
            <m:GetAttachmentResponseMessage ResponseClass="Error"><m:MessageText>The specified object was not found in the store.</m:MessageText>
              <m:ResponseCode>ErrorItemNotFound</m:ResponseCode></m:GetAttachmentResponseMessage>
            """)));
        Assert.Equal((EwsErrorKind.NotFound, "ErrorItemNotFound"), (error.Kind, error.Code));
    }

    [Fact]
    public async Task A_file_past_the_limit_is_refused()
    {
        var error = await Assert.ThrowsAsync<EwsException>(() => Read(File("big.bin", "application/octet-stream", new byte[300_000]), max: 100_000));
        Assert.Equal("AttachmentTooLarge", error.Code);
    }

    [Fact]
    public async Task A_soap_fault_becomes_an_ews_error()
    {
        var error = await Assert.ThrowsAsync<EwsException>(() => Read("""
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>a:ErrorServerBusy</faultcode>
              <faultstring>The server cannot service this request right now.</faultstring>
              <detail><e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">ErrorServerBusy</e:ResponseCode></detail>
            </s:Fault></s:Body></s:Envelope>
            """));
        Assert.Equal(EwsErrorKind.Throttling, error.Kind);
    }

    [Fact]
    public async Task An_answer_without_a_response_message_is_null()
    {
        var (result, _) = await Read("<html><body>Bad gateway</body></html>");
        Assert.Null(result);
    }

    [Fact]
    public async Task The_request_asks_for_one_attachment_with_mime_for_messages()
    {
        var exchange = new FakeExchange(HttpStatusCode.OK, File("a.txt", "text/plain", "hi"u8.ToArray()));
        var ews = new EwsClient(new HttpClient(exchange), new StaticMonitor<ExchangeOptions>(new ExchangeOptions
        {
            EwsUrl = "https://exchange.example.test/EWS/Exchange.asmx", Username = "svc", Password = "secret",
        }));
        using var output = new MemoryStream();
        var result = await ews.DownloadAttachmentAsync("m.elkholy@example.test", "AAMk=", output, 1024, TimeSpan.FromSeconds(30), CancellationToken.None);
        Assert.Equal("hi", Encoding.UTF8.GetString(output.ToArray()));
        Assert.Equal(2, result.Bytes);
        var sent = exchange.Sent.Single();
        Assert.Contains("<t:AttachmentId Id=\"AAMk=\" />", sent.Body);
        Assert.Contains("<t:IncludeMimeContent>true</t:IncludeMimeContent>", sent.Body);
        Assert.Equal("m.elkholy@example.test", sent.Request.Headers.GetValues("X-AnchorMailbox").Single());
    }

    [Fact]
    public void Files_are_kept_a_thousand_per_folder_and_never_outside_the_root()
    {
        Assert.Equal(Path.Combine("4", "186", "186125.bin"), AttachmentCache.RelativePath(4, 186125));
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "sila-att"));
        Assert.Equal(Path.Combine(root, "4", "186", "186125.bin"), AttachmentCache.Inside(root, "4/186/186125.bin"));
        Assert.Null(AttachmentCache.Inside(root, "../other/secret.txt"));
        Assert.Null(AttachmentCache.Inside(root, Path.Combine(Path.GetTempPath(), "x.bin")));
    }
}
