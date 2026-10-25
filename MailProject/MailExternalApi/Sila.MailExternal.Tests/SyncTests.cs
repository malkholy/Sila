using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Sila.Mail.Contract;
using Xunit;

namespace Sila.MailExternal.Tests;

public sealed class SyncTests
{
    private const string Key = "0123456789abcdef0123456789abcdef";

    private static PublishBatch Batch(long after = 10, long to = 20, long seq = 15) => new(after, to,
        [new UserRow(4, "m@example.test", "mhd", true, "OK", null, null, 10, 2, seq)],
        [new FolderRow(7, 4, null, "INBOX", "Inbox", "Inbox", 10, 2, null, seq)],
        [new MessageRow(18245, 4, 7, "ITEM", "CK", "<a@b>", "CONV", "Hi", "Sales", "s@example.test", null,
            new DateTime(2026, 10, 25, 7, 22, 38, DateTimeKind.Utc), false, 0, 1, true, false, "preview",
            [new RecipientRow(1, 0, "Mona", "m@example.test")], seq)],
        [new BodyRow(18245, [0x1F, 0x8B, 1, 2, 3], "Hi", seq)],
        [new AttachmentRow(9, 18245, "ATT", "invoice.pdf", "application/pdf", 4821, false, null, seq)],
        new PublishDeletes([], [], [new KeySeq(35020, seq)], [], []));

    [Fact]
    public void A_complete_batch_passes_and_survives_the_wire()
    {
        var json = JsonSerializer.Serialize(Batch(), BatchJson.Options);
        var back = JsonSerializer.Deserialize<PublishBatch>(json, BatchJson.Options)!;
        Assert.Null(BatchJson.Problem(back));
        Assert.Equal(new byte[] { 0x1F, 0x8B, 1, 2, 3 }, back.Bodies[0].HtmlGz);   // bytes travel as base64
        Assert.Equal(DateTimeKind.Utc, back.Messages[0].ReceivedAt.Kind);
        Assert.Equal("Mona", back.Messages[0].Recipients[0].Name);
        Assert.Equal(35020, back.Deletes.Messages[0].Id);
    }

    [Fact]
    public void Unknown_fields_are_refused() =>
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<PublishBatch>(
            """{"afterSeq":0,"toSeq":1,"users":[],"folders":[],"messages":[],"bodies":[],"attachments":[],"deletes":{"users":[],"folders":[],"messages":[],"bodies":[],"attachments":[]},"sql":"DROP"}""",
            BatchJson.Options));

    [Theory]
    [InlineData(30, 20, 15)]   // ToSeq before AfterSeq
    [InlineData(10, 20, 25)]   // a row newer than the batch
    [InlineData(10, 20, 0)]    // a row without a sequence
    public void A_batch_out_of_order_is_refused(long after, long to, long seq) =>
        Assert.NotNull(BatchJson.Problem(Batch(after, to, seq)));

    [Fact]
    public void A_batch_with_a_missing_list_is_refused() =>
        Assert.NotNull(BatchJson.Problem(Batch() with { Bodies = null! }));

    [Theory]
    [InlineData("41.128.171.146", true)]
    [InlineData("41.128.171.147", false)]
    [InlineData("10.1.245.2", false)]
    public void Only_the_company_address_may_send(string ip, bool allowed) =>
        Assert.Equal(allowed, new SyncOptions { Key = Key, AllowedNetworks = ["41.128.171.146/32"] }.IsAllowed(IPAddress.Parse(ip)));

    [Theory]
    [InlineData(Key, true)]
    [InlineData("0123456789abcdef0123456789abcdeX", false)]
    [InlineData(null, false)]
    public void The_sync_key_must_match(string? presented, bool ok) =>
        Assert.Equal(ok, new SyncOptions { Key = Key }.IsKey(presented));

    private static WebApplicationFactory<Program> Factory(string key = Key) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Sync:Key"] = key,
                ["ConnectionStrings:Mail"] = "Server=127.0.0.1,1;Database=None;Connect Timeout=1",
            }));
        });

    private static async Task<HttpResponseMessage> Apply(WebApplicationFactory<Program> factory, byte[] body, string? key, bool gzip = true)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/sync/v1/apply");
        var content = gzip ? Gzip(body) : body;
        request.Content = new ByteArrayContent(content);
        request.Content.Headers.ContentType = new("application/json");
        if (gzip) request.Content.Headers.ContentEncoding.Add("gzip");
        if (key is not null) request.Headers.Add("X-Sync-Key", key);
        return await factory.CreateClient().SendAsync(request);
    }

    private static byte[] Gzip(byte[] data)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true)) gzip.Write(data);
        return output.ToArray();
    }

    [Fact]
    public async Task Without_the_key_nothing_is_read()
    {
        using var factory = Factory();
        var json = JsonSerializer.SerializeToUtf8Bytes(Batch(), BatchJson.Options);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Apply(factory, json, null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Apply(factory, json, Key[..^1] + "X")).StatusCode);
    }

    [Fact]
    public async Task Sync_is_off_without_a_key_configured()
    {
        using var factory = Factory(key: "");
        var json = JsonSerializer.SerializeToUtf8Bytes(Batch(), BatchJson.Options);
        Assert.Equal(HttpStatusCode.NotFound, (await Apply(factory, json, Key)).StatusCode);
    }

    [Fact]
    public async Task A_bad_batch_is_refused_before_the_database()
    {
        using var factory = Factory();
        Assert.Equal(HttpStatusCode.BadRequest, (await Apply(factory, "not json"u8.ToArray(), Key)).StatusCode);
        var outOfOrder = JsonSerializer.SerializeToUtf8Bytes(Batch(after: 30, to: 20), BatchJson.Options);
        var response = await Apply(factory, outOfOrder, Key);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("out of order", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Health_answers_without_the_database()
    {
        using var factory = Factory();
        var json = JsonDocument.Parse(await factory.CreateClient().GetStringAsync("/health")).RootElement;
        Assert.True(json.GetProperty("success").GetBoolean());
        Assert.False(json.GetProperty("databaseOk").GetBoolean());
    }

    [Fact]
    public void Gzip_round_trip_helper_is_sane() =>
        Assert.Equal("x", Encoding.UTF8.GetString(Decompress(Gzip("x"u8.ToArray()))));

    private static byte[] Decompress(byte[] data)
    {
        using var input = new GZipStream(new MemoryStream(data), CompressionMode.Decompress);
        using var output = new MemoryStream();
        input.CopyTo(output);
        return output.ToArray();
    }
}
