using System.Xml.Linq;
using Sila.MailConnector.Ews;
using Sila.MailConnector.Sync;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class BodyTests
{
    [Theory]
    [InlineData("<p>Hi<script>alert(1)</script></p>", "<p>Hi</p>")]
    [InlineData("<a href=\"javascript:alert(1)\">x</a>", "<a>x</a>")]
    [InlineData("<img src=\"x\" onerror=\"alert(1)\">", "<img src=\"x\">")]
    [InlineData("<iframe src=\"https://evil.test\"></iframe><p>ok</p>", "<p>ok</p>")]
    [InlineData("<form action=\"https://evil.test\"><input name=\"p\"></form>", "")]
    [InlineData("<style>body{display:none}</style><p>ok</p>", "<p>ok</p>")]
    [InlineData("<p data-x=\"1\">ok</p>", "<p>ok</p>")]
    public void Active_content_is_removed(string html, string expected) =>
        Assert.Equal(expected, BodySanitizer.Html(html));

    [Theory]
    [InlineData("<img src=\"cid:image001.png@01DB2A\">")]
    [InlineData("<a href=\"mailto:sales@example.test\">mail</a>")]
    [InlineData("<a href=\"https://glcpaints.com/\">site</a>")]
    [InlineData("<p style=\"color: rgba(255, 0, 0, 1)\">red</p>")]
    [InlineData("<table><tbody><tr><td>cell</td></tr></tbody></table>")]
    public void Mail_formatting_stays(string html) =>
        Assert.Equal(html, BodySanitizer.Html(html));

    [Fact]
    public void Empty_html_is_stored_as_none() => Assert.Null(BodySanitizer.Html("  "));

    [Fact]
    public void Compressed_html_reads_back_unchanged_and_smaller()
    {
        var html = string.Concat(Enumerable.Repeat("<p style=\"color: rgba(0, 0, 0, 1)\">شحنة Order 4512 — مرحبا</p>", 500));
        var stored = BodySanitizer.Compress(html)!;
        Assert.Equal(html, BodySanitizer.Decompress(stored));
        Assert.True(stored.Length < html.Length * 2 / 10);   // UTF-16 is 2 bytes a char; expect > 10x here
        Assert.Equal(new byte[] { 0x1F, 0x8B }, stored[..2]);   // gzip, as SQL Server's DECOMPRESS expects
    }

    [Fact]
    public void Search_text_is_capped_at_64k() =>
        Assert.Equal(65_536, BodySanitizer.Text(new string('x', 100_000))!.Length);

    [Fact]
    public void Body_and_attachments_are_parsed()
    {
        var item = XElement.Parse("""
            <t:Message xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
              <t:ItemId Id="A1" ChangeKey="CK1" />
              <t:Body BodyType="HTML">&lt;p&gt;Hello&lt;/p&gt;</t:Body>
              <t:TextBody BodyType="Text">Hello</t:TextBody>
              <t:Attachments>
                <t:FileAttachment>
                  <t:AttachmentId Id="AT1" /><t:Name>invoice.pdf</t:Name><t:ContentType>application/pdf</t:ContentType>
                  <t:Size>48213</t:Size><t:IsInline>false</t:IsInline>
                </t:FileAttachment>
                <t:FileAttachment>
                  <t:AttachmentId Id="AT2" /><t:Name>image001.png</t:Name><t:ContentType>image/png</t:ContentType>
                  <t:ContentId>image001.png@01DB2A</t:ContentId><t:Size>1024</t:Size><t:IsInline>true</t:IsInline>
                </t:FileAttachment>
                <t:ItemAttachment><t:AttachmentId Id="AT3" /><t:Name>Fwd: order</t:Name><t:Size>9000</t:Size></t:ItemAttachment>
              </t:Attachments>
            </t:Message>
            """);
        var body = EwsClient.ParseBody("A1", item);
        Assert.Equal("<p>Hello</p>", body.Html);
        Assert.Equal("Hello", body.Text);
        Assert.Equal(
            [
                new MailAttachmentInfo("AT1", "invoice.pdf", "application/pdf", 48213, false, null),
                new MailAttachmentInfo("AT2", "image001.png", "image/png", 1024, true, "image001.png@01DB2A"),
                new MailAttachmentInfo("AT3", "Fwd: order", "message/rfc822", 9000, false, null),
            ], body.Attachments);
    }

    [Fact]
    public void A_plain_text_message_has_no_html()
    {
        var item = XElement.Parse("""
            <t:Message xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
              <t:ItemId Id="A1" /><t:Body BodyType="Text">Just text</t:Body><t:TextBody>Just text</t:TextBody>
            </t:Message>
            """);
        var body = EwsClient.ParseBody("A1", item);
        Assert.Null(body.Html);
        Assert.Equal("Just text", body.Text);
    }
}
