using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sila.MailApi.Admin;
using Sila.MailApi.Users;
using Xunit;

namespace Sila.MailApi.Tests;

public sealed class UserMailTests
{
    [Fact]
    public async Task Without_a_token_nothing_is_read()
    {
        using var app = new TestApp();
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.Get("/mail/v1/folders", null)).Status);
        Assert.Empty(app.Mail.Calls);
    }

    [Fact]
    public async Task A_token_not_signed_by_7400_is_refused()
    {
        using var app = new TestApp();
        using var other = RSA.Create(2048);
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.Get("/mail/v1/folders", app.Token(signWith: other))).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.Get("/mail/v1/folders", app.Token(issuer: "https://evil.test"))).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.Get("/mail/v1/folders", app.Token(expired: true))).Status);
        Assert.Empty(app.Mail.Calls);
    }

    [Fact]
    public async Task A_token_for_another_database_or_a_pending_password_change_is_refused()
    {
        using var app = new TestApp();
        Assert.Equal(HttpStatusCode.Forbidden, (await app.Get("/mail/v1/folders", app.Token(db: "MEGA25"))).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.Get("/mail/v1/folders", app.Token(forced: true))).Status);
        Assert.Empty(app.Mail.Calls);
    }

    [Fact]
    public async Task The_mailbox_is_the_one_of_the_token_user()
    {
        using var app = new TestApp();
        var (status, _) = await app.Get("/mail/v1/folders", app.Token("mhd"));
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(["folders:4"], app.Mail.Calls);   // user #4 = mhd's mailbox, from the token
    }

    [Fact]
    public async Task No_mailbox_or_a_switched_off_one_says_so()
    {
        using var app = new TestApp();
        var (status, body) = await app.Get("/mail/v1/me", app.Token("nobody"));
        Assert.Equal(HttpStatusCode.NotFound, status);
        Assert.Contains("No mailbox is set up for you", body);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.Get("/mail/v1/me", app.Token("off"))).Status);
    }

    [Fact]
    public async Task Another_users_folder_or_message_is_not_found()
    {
        using var app = new TestApp();
        Assert.Equal(HttpStatusCode.NotFound, (await app.Get("/mail/v1/folders/99/messages", app.Token())).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await app.Get("/mail/v1/messages/123", app.Token())).Status);
        Assert.Contains("message:4:123", app.Mail.Calls);   // always asked within the caller's own mailbox
    }

    [Fact]
    public async Task Bad_paging_and_search_input_is_refused()
    {
        using var app = new TestApp();
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Get("/mail/v1/folders/7/messages?before=yesterday", app.Token())).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Get("/mail/v1/search?q=a", app.Token())).Status);
        Assert.Equal(HttpStatusCode.OK, (await app.Get("/mail/v1/search?q=order", app.Token())).Status);
    }

    [Fact]
    public void The_page_cursor_round_trips()
    {
        var at = new DateTime(2026, 10, 25, 7, 22, 38, 123, DateTimeKind.Utc);
        Assert.Equal((at, 18245L), Cursor.Parse(Cursor.Make(at, 18245)));
        Assert.Null(Cursor.Parse("1.2.3"));
        Assert.Null(Cursor.Parse("-5.7"));
    }

    [Fact]
    public void Search_words_are_values_not_patterns() =>
        Assert.Equal(@"50\% off \[sale] a\_b c\\d", SqlUserMailStore.EscapeLike(@"50% off [sale] a_b c\d"));   // a lone ] is literal in LIKE

    [Fact]
    public void Stored_bodies_decompress()
    {
        var html = "<p dir=\"rtl\">مرحبا — Order 4512</p>";
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true)) gzip.Write(Encoding.Unicode.GetBytes(html));
        Assert.Equal(html, SqlUserMailStore.Gunzip(output.ToArray()));
    }

    [Fact]
    public async Task Health_names_the_role()
    {
        using var app = new TestApp(role: "External");
        var json = JsonDocument.Parse((await app.Get("/health", null)).Body).RootElement;
        Assert.Equal("External", json.GetProperty("role").GetString());
    }

    [Fact]
    public async Task An_attachment_comes_from_the_connector_under_its_own_name()
    {
        using var app = new TestApp();
        using var response = await app.GetResponse("/mail/v1/attachments/50", app.Token("mhd"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("file-body", await response.Content.ReadAsStringAsync());
        Assert.Equal("application/pdf", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal("Invoice 12.pdf", response.Content.Headers.ContentDisposition!.FileNameStar);
        Assert.Equal(["file:4:50"], app.Connector.Calls);
    }

    [Fact]
    public async Task Another_mailbox_attachment_is_not_found_and_never_fetched()
    {
        using var app = new TestApp();
        var (status, _) = await app.Get("/mail/v1/attachments/999", app.Token("mhd"));
        Assert.Equal(HttpStatusCode.NotFound, status);
        Assert.Empty(app.Connector.Calls);
        Assert.Equal(HttpStatusCode.NotFound, (await app.Get("/mail/v1/attachments/50", app.Token("nobody"))).Status);
        Assert.Empty(app.Connector.Calls);
    }

    [Fact]
    public async Task A_page_or_script_attachment_is_only_ever_a_download()
    {
        using var app = new TestApp();
        using var html = await app.GetResponse("/mail/v1/attachments/51", app.Token("mhd"));
        Assert.Equal("application/octet-stream", html.Content.Headers.ContentType!.MediaType);
        Assert.Equal("attachment", html.Content.Headers.ContentDisposition!.DispositionType);
        using var message = await app.GetResponse("/mail/v1/attachments/52", app.Token("mhd"));
        Assert.Equal("Re: offer.eml", message.Content.Headers.ContentDisposition!.FileNameStar);
    }

    [Fact]
    public async Task The_connector_reason_is_passed_on()
    {
        using var app = new TestApp();
        app.Connector.File = new ConnectorFile(413, "The attachment is larger than 50 MB. Open it in Outlook.");
        var (status, body) = await app.Get("/mail/v1/attachments/50", app.Token("mhd"));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, status);
        Assert.Contains("Open it in Outlook", body);
    }

    [Fact]
    public async Task Outside_the_company_attachments_are_not_offered_yet()
    {
        using var app = new TestApp(role: "External");
        var (status, body) = await app.Get("/mail/v1/attachments/50", app.Token("mhd"));
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Contains("company network", body);
        Assert.Empty(app.Connector.Calls);
    }
}
