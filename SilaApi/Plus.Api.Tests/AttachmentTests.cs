using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Plus.Api.Attachments;
using Xunit;

namespace Plus.Api.Tests;

public sealed class FakeAttachmentStore : IAttachmentStore
{
    public List<(string Operation, string User, string LineData)> Calls { get; } = [];
    // Per-operation override; default = success with no rows (Insert returns FileHistory row 41).
    public Dictionary<string, AttachmentResult> Results { get; } = [];
    public Task<AttachmentResult> ExecuteAsync(DatabaseOptions database, string operation, string username,
        object lineData, CancellationToken cancellationToken)
    {
        Calls.Add((operation, username, JsonSerializer.Serialize(lineData)));
        if (Results.TryGetValue(operation, out var result)) return Task.FromResult(result);
        return Task.FromResult(operation == "Insert"
            ? new AttachmentResult(0, "", [new()
            {
                ["ID"] = 41, ["FileID"] = 410800, ["FileName"] = "410800-20260929120000-0.pdf",
                ["CreatedDate"] = new DateTime(2026, 9, 29, 12, 0, 0),
            }])
            : new AttachmentResult(0, "", []));
    }
}

public sealed class FakeLegacyFiles(byte[] content) : ILegacyFileSource
{
    public List<string> Requested { get; } = [];
    public Task<HttpResponseMessage?> OpenAsync(string? fileUrl, CancellationToken cancellationToken)
    {
        if (!LegacyFileSource.IsAllowed(fileUrl, ["10.1.245.245:7001"], out _)) return Task.FromResult<HttpResponseMessage?>(null);
        Requested.Add(fileUrl!);
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(content) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/html");   // must be ignored
        return Task.FromResult<HttpResponseMessage?>(response);
    }
}

public sealed class FakeScanner : IVirusScanner
{
    public ScanResult Result { get; set; } = ScanResult.Clean;
    public int Calls { get; private set; }
    public Task<ScanResult> ScanAsync(string path, CancellationToken cancellationToken)
    {
        Calls++;
        return Task.FromResult(Result);
    }
}

public sealed class AttachmentTests
{
    internal static readonly byte[] Pdf = Encoding.ASCII.GetBytes("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF");
    private static readonly byte[] Exe = [0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00];

    private static byte[] Office(string mainPart, bool macro = false)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, true))
        {
            using (var w = new StreamWriter(zip.CreateEntry("[Content_Types].xml").Open()))
                w.Write(macro ? "<Types><Override ContentType=\"application/vnd.ms-excel.sheet.macroEnabled.main+xml\"/></Types>"
                              : "<Types/>");
            using (var w = new StreamWriter(zip.CreateEntry(mainPart).Open())) w.Write("<x/>");
            if (macro) using (var w = new StreamWriter(zip.CreateEntry("xl/vbaProject.bin").Open())) w.Write("vba");
        }
        return buffer.ToArray();
    }

    private static string? Check(string extension, byte[] content)
    {
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllBytes(path, content);
            var rule = FileTypePolicy.ForExtension(extension);
            return rule is null ? "not allowed" : FileTypePolicy.Validate(path, rule);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void Allowed_types_with_matching_content_pass()
    {
        Assert.Null(Check(".pdf", Pdf));
        Assert.Null(Check(".png", [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1]));
        Assert.Null(Check(".jpg", [0xFF, 0xD8, 0xFF, 0xE0, 1]));
        Assert.Null(Check(".xlsx", Office("xl/workbook.xml")));
        Assert.Null(Check(".docx", Office("word/document.xml")));
        Assert.Null(Check(".csv", Encoding.UTF8.GetBytes("a,b\n1,2\n")));
    }

    [Theory]
    [InlineData(".exe")]
    [InlineData(".js")]
    [InlineData(".html")]
    [InlineData(".svg")]
    [InlineData(".xlsm")]
    [InlineData(".docm")]
    [InlineData(".zip")]
    [InlineData("")]
    public void Dangerous_or_unknown_extensions_are_not_allowed(string extension) =>
        Assert.Null(FileTypePolicy.ForExtension(extension));

    [Fact]
    public void Content_that_does_not_match_the_extension_is_rejected()
    {
        Assert.NotNull(Check(".pdf", Exe));                                // renamed executable
        Assert.NotNull(Check(".jpg", Pdf));
        Assert.NotNull(Check(".txt", Exe));                                // binary as text
        Assert.NotNull(Check(".xlsx", Office("word/document.xml")));      // wrong Office kind
        Assert.NotNull(Check(".xlsx", Office("xl/workbook.xml", macro: true)));   // macros
        Assert.NotNull(Check(".docx", [0x50, 0x4B, 0x03, 0x04, 0, 0]));   // broken zip
    }

    private static HttpRequestMessage Upload(GatewayFactory factory, string? token, string fileName, byte[] content,
        string extraUser = "mhd", string? description = "Copy of PI")
    {
        var form = new MultipartFormDataContent
        {
            { new StringContent("MEGA25"), "database" },
            { new StringContent("PurchaseOrder"), "entityType" },
            { new StringContent("2700001"), "entityKey" },
            { new StringContent(extraUser), "user" },   // the old API trusted this; the gateway must not
        };
        if (description is not null) form.Add(new StringContent(description), "description");
        var file = new ByteArrayContent(content);
        file.Headers.ContentType = new MediaTypeHeaderValue("text/html");   // a lie the server must ignore
        form.Add(file, "file", fileName);
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v2/attachments") { Content = form };
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return request;
    }

    [Fact]
    public async Task Anonymous_requests_are_refused_before_any_SQL()
    {
        using var factory = new GatewayFactory();
        var client = factory.CreateClient();
        var list = await client.GetAsync("/api/v2/attachments?database=MEGA25&entityType=PurchaseOrder&entityKey=1");
        var upload = await client.SendAsync(Upload(factory, null, "a.pdf", Pdf));
        Assert.Equal(HttpStatusCode.Unauthorized, list.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, upload.StatusCode);
        Assert.Empty(factory.AttachmentStore.Calls);
    }

    [Fact]
    public async Task Upload_uses_the_token_identity_and_stores_only_a_scanned_file()
    {
        using var factory = new GatewayFactory();
        var response = await factory.CreateClient().SendAsync(Upload(factory, factory.Token(), "Invoice.pdf", Pdf));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(41, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("attachmentID").GetInt32());

        // every SQL call ran as the mapped token user, never the posted "user" field
        Assert.All(factory.AttachmentStore.Calls, c => Assert.Equal("ERP_USER", c.User));
        Assert.Equal(["CheckAccess", "Insert", "SetExist"], factory.AttachmentStore.Calls.Select(c => c.Operation));
        var insert = factory.AttachmentStore.Calls.Single(c => c.Operation == "Insert").LineData;
        Assert.Contains("\"FileOrginalName\":\"Invoice.pdf\"", insert);
        Assert.Contains("\"Extension\":\".pdf\"", insert);                  // from the allowlist, not the posted text/html
        Assert.Contains("\"FileDescription\":\"Copy of PI\"", insert);
        Assert.Equal(1, factory.Scanner.Calls);

        // stored under <db>/<CreatedDate>/<FileHistory.FileName>, and the FileHistory row
        // gets a link the old system can open
        var storedPath = Assert.Single(Directory.GetFiles(factory.StorageDir, "*", SearchOption.AllDirectories));
        Assert.Equal(Path.Combine(factory.StorageDir, "MEGA25", "20260929", "410800-20260929120000-0.pdf"), storedPath);
        var setExist = factory.AttachmentStore.Calls.Single(c => c.Operation == "SetExist").LineData;
        Assert.Contains("/api/v2/files/MEGA25/410800-20260929120000-0.pdf", setExist);
        Assert.Empty(Directory.GetFiles(factory.QuarantineDir));
    }

    [Fact]
    public async Task Upload_never_overwrites_or_deletes_an_existing_file_at_the_target_path()
    {
        using var factory = new GatewayFactory();
        // a file already sits where the new row's file would go
        var target = Path.Combine(factory.StorageDir, "MEGA25", "20260929", "410800-20260929120000-0.pdf");
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        await File.WriteAllTextAsync(target, "EXISTING");

        var response = await factory.CreateClient().SendAsync(Upload(factory, factory.Token(), "a.pdf", Pdf));

        Assert.False(response.IsSuccessStatusCode);
        Assert.Equal("EXISTING", await File.ReadAllTextAsync(target));                  // untouched
        Assert.Contains(factory.AttachmentStore.Calls, c => c.Operation == "CancelInsert");
        Assert.Empty(Directory.GetFiles(factory.QuarantineDir));
    }

    [Fact]
    public async Task Renamed_executable_is_rejected_and_nothing_is_kept()
    {
        using var factory = new GatewayFactory();
        var response = await factory.CreateClient().SendAsync(Upload(factory, factory.Token(), "invoice.pdf", Exe));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.DoesNotContain(factory.AttachmentStore.Calls, c => c.Operation == "Insert");
        Assert.False(Directory.Exists(factory.StorageDir) && Directory.EnumerateFiles(factory.StorageDir, "*", SearchOption.AllDirectories).Any());
        Assert.Empty(Directory.GetFiles(factory.QuarantineDir));
    }

    [Fact]
    public async Task Disallowed_extension_is_rejected_before_SQL()
    {
        using var factory = new GatewayFactory();
        var response = await factory.CreateClient().SendAsync(Upload(factory, factory.Token(), "run.exe", Exe));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(factory.AttachmentStore.Calls);
    }

    [Theory]
    [InlineData(ScanResult.Threat, HttpStatusCode.BadRequest)]
    [InlineData(ScanResult.Unavailable, HttpStatusCode.ServiceUnavailable)]
    public async Task Infected_or_unscanned_files_are_refused(ScanResult scan, HttpStatusCode expected)
    {
        using var factory = new GatewayFactory();
        factory.Scanner.Result = scan;
        var response = await factory.CreateClient().SendAsync(Upload(factory, factory.Token(), "a.pdf", Pdf));
        Assert.Equal(expected, response.StatusCode);
        Assert.DoesNotContain(factory.AttachmentStore.Calls, c => c.Operation == "Insert");
        Assert.Empty(Directory.GetFiles(factory.QuarantineDir));
    }

    [Fact]
    public async Task No_page_access_means_no_upload()
    {
        using var factory = new GatewayFactory();
        factory.AttachmentStore.Results["CheckAccess"] = new(403, "You do not have access to this page", []);
        var response = await factory.CreateClient().SendAsync(Upload(factory, factory.Token(), "a.pdf", Pdf));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(0, factory.Scanner.Calls);
    }

    private static Dictionary<string, object?> Row(string fileName, string fileUrl) => new()
    {
        ["ID"] = 7, ["FileID"] = 410800, ["FileName"] = fileName, ["FileOrginalName"] = "Invoice.pdf",
        ["FileURL"] = fileUrl, ["FileDisplay"] = null, ["CreatedDate"] = new DateTime(2026, 9, 28, 9, 0, 0),
        ["CreatedBy"] = "ERP_USER",
    };

    private const string Record = "database=MEGA25&entityType=PurchaseOrder&entityKey=2700001";

    [Fact]
    public async Task Download_serves_the_stored_file_as_an_attachment_and_refuses_bad_names()
    {
        using var factory = new GatewayFactory();
        Directory.CreateDirectory(Path.Combine(factory.StorageDir, "MEGA25", "20260928"));
        await File.WriteAllBytesAsync(Path.Combine(factory.StorageDir, "MEGA25", "20260928", "410800-20260928090000-0.pdf"), Pdf);
        factory.AttachmentStore.Results["Get"] = new(0, "",
            [Row("410800-20260928090000-0.pdf", "https://files.example/api/v2/files/MEGA25/410800-20260928090000-0.pdf")]);
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());

        var response = await client.GetAsync($"/api/v2/attachments/7/download?{Record}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/pdf", response.Content.Headers.ContentType!.MediaType);   // from the allowlist
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition!.DispositionType);
        Assert.Equal("Invoice.pdf", response.Content.Headers.ContentDisposition!.FileNameStar);
        Assert.Equal(Pdf, await response.Content.ReadAsByteArrayAsync());
        Assert.Contains("\"EntityKey\":\"2700001\"", factory.AttachmentStore.Calls.Single(c => c.Operation == "Get").LineData);

        // a stored name that is not ours (path tricks included) is never opened from disk
        factory.AttachmentStore.Results["Get"] = new(0, "",
            [Row("../../etc/passwd", "https://files.example/api/v2/files/MEGA25/x")]);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v2/attachments/7/download?{Record}")).StatusCode);

        // download needs the record: without it the SP is never asked
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/v2/attachments/7/download?database=MEGA25")).StatusCode);
    }

    private static byte[] Png(int width, int height)
    {
        using var bitmap = new SkiaSharp.SKBitmap(width, height);
        using (var canvas = new SkiaSharp.SKCanvas(bitmap))
        {
            canvas.Clear(SkiaSharp.SKColors.SteelBlue);
        }
        // photo-like noise, so the PNG is as heavy as a real picture (stripes compress to nothing)
        var random = new Random(7);
        for (var y = 0; y < height; y += 2)
            for (var x = 0; x < width; x += 2)
                bitmap.SetPixel(x, y, new SkiaSharp.SKColor((byte)random.Next(256), (byte)random.Next(256), (byte)random.Next(256)));
        using var image = SkiaSharp.SKImage.FromBitmap(bitmap);
        return image.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100).ToArray();
    }

    [Fact]
    public async Task Preview_serves_a_small_jpeg_of_a_large_image_and_the_original_otherwise()
    {
        using var factory = new GatewayFactory();
        var day = Path.Combine(factory.StorageDir, "MEGA25", "20260928");
        Directory.CreateDirectory(day);
        var big = Png(2400, 1600);
        await File.WriteAllBytesAsync(Path.Combine(day, "410800-20260928090000-0.png"), big);
        factory.AttachmentStore.Results["Get"] = new(0, "",
            [Row("410800-20260928090000-0.png", "https://files.example/api/v2/files/MEGA25/410800-20260928090000-0.png")]);
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());

        var response = await client.GetAsync($"/api/v2/attachments/7/download?{Record}&preview=true");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("image/jpeg", response.Content.Headers.ContentType!.MediaType);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        using (var decoded = SkiaSharp.SKBitmap.Decode(bytes))
        {
            Assert.Equal(ImagePreview.MaxSide, Math.Max(decoded.Width, decoded.Height));
            Assert.Equal(320, decoded.Height);   // aspect kept: 2400x1600 -> 480x320
        }
        Assert.True(bytes.Length < big.Length / 4);
        Assert.True(File.Exists(Path.Combine(day, "410800-20260928090000-0.png.preview.jpg")));   // kept for next time
        Assert.Equal(big, await File.ReadAllBytesAsync(Path.Combine(day, "410800-20260928090000-0.png")));   // original untouched

        // without preview=true: the original, unchanged
        var original = await client.GetAsync($"/api/v2/attachments/7/download?{Record}");
        Assert.Equal("image/png", original.Content.Headers.ContentType!.MediaType);
        Assert.Equal(big, await original.Content.ReadAsByteArrayAsync());

        // a small image is served as it is, a PDF has no preview: both get the original
        var small = Png(200, 100);
        await File.WriteAllBytesAsync(Path.Combine(day, "410801-20260928090000-0.png"), small);
        factory.AttachmentStore.Results["Get"] = new(0, "",
            [Row("410801-20260928090000-0.png", "https://files.example/api/v2/files/MEGA25/410801-20260928090000-0.png")]);
        Assert.Equal(small, await (await client.GetAsync($"/api/v2/attachments/7/download?{Record}&preview=true")).Content.ReadAsByteArrayAsync());
        await File.WriteAllBytesAsync(Path.Combine(day, "410802-20260928090000-0.pdf"), Pdf);
        factory.AttachmentStore.Results["Get"] = new(0, "",
            [Row("410802-20260928090000-0.pdf", "https://files.example/api/v2/files/MEGA25/410802-20260928090000-0.pdf")]);
        var pdf = await client.GetAsync($"/api/v2/attachments/7/download?{Record}&preview=true");
        Assert.Equal("application/pdf", pdf.Content.Headers.ContentType!.MediaType);
        Assert.Equal(Pdf, await pdf.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task List_marks_old_system_files_with_their_own_link()
    {
        using var factory = new GatewayFactory();
        factory.AttachmentStore.Results["List"] = new(0, "",
        [
            Row("410800-20260928090000-0.pdf", "https://files.example/api/v2/files/MEGA25/410800-20260928090000-0.pdf"),
            Row("410733-20250101101010-0.jpg", "http://10.1.245.245:7001/FileManager/Local/Download?fileID=410733"),
            Row("old.pdf", "javascript:alert(1)"),
        ]);
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());
        var items = (await client.GetFromJsonAsync<JsonElement>($"/api/v2/attachments?{Record}")).EnumerateArray().ToList();

        Assert.Equal(3, items.Count);
        Assert.False(items[0].GetProperty("legacy").GetBoolean());
        Assert.Equal("Invoice.pdf", items[0].GetProperty("fileName").GetString());
        Assert.True(items[1].GetProperty("legacy").GetBoolean());
        // the old link itself never reaches the browser
        Assert.DoesNotContain("10.1.245.245", items[1].GetRawText());
    }

    [Fact]
    public async Task Old_system_files_are_fetched_only_from_the_configured_file_server()
    {
        using var factory = new GatewayFactory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());

        // allowed host: streamed back, typed by our allowlist (not the old server's header)
        factory.AttachmentStore.Results["Get"] = new(0, "", [Row("410239-202609281150343-6.pdf",
            "http://10.1.245.245:7001/FileManager/Local/Download?fileID=410239-202609281150343-6.pdf&FileName=UTT Offer.pdf")]);
        var ok = await client.GetAsync($"/api/v2/attachments/7/download?{Record}");
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("application/pdf", ok.Content.Headers.ContentType!.MediaType);
        Assert.Equal(Pdf, await ok.Content.ReadAsByteArrayAsync());
        Assert.Contains("10.1.245.245:7001", Assert.Single(factory.LegacyFiles.Requested));

        // any other address in a FileHistory row is never fetched
        factory.AttachmentStore.Results["Get"] = new(0, "", [Row("x.pdf", "http://169.254.169.254/latest/meta-data")]);
        var blocked = await client.GetAsync($"/api/v2/attachments/7/download?{Record}");
        Assert.Equal(HttpStatusCode.NotFound, blocked.StatusCode);
        Assert.Single(factory.LegacyFiles.Requested);
    }

    [Theory]
    [InlineData("http://10.1.245.245:7001/FileManager/x", true)]
    [InlineData("https://10.1.245.245:7001/FileManager/x", true)]
    [InlineData("http://10.1.245.245:7002/FileManager/x", false)]
    [InlineData("http://user@10.1.245.245:7001/x", false)]
    [InlineData("file:///C:/Windows/win.ini", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("", false)]
    public void Legacy_links_must_match_a_configured_host(string url, bool allowed) =>
        Assert.Equal(allowed, LegacyFileSource.IsAllowed(url, ["10.1.245.245:7001"], out _));

    [Theory]
    [InlineData(null)]
    [InlineData("   ")]
    public async Task Upload_without_a_description_is_refused_before_any_SQL(string? description)
    {
        using var factory = new GatewayFactory();
        var response = await factory.CreateClient().SendAsync(
            Upload(factory, factory.Token(), "a.pdf", Pdf, description: description));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(factory.AttachmentStore.Calls);
        Assert.Equal(0, factory.Scanner.Calls);
    }

    [Fact]
    public async Task Description_edit_runs_as_the_token_user_and_requires_text()
    {
        using var factory = new GatewayFactory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());

        var ok = await client.PostAsJsonAsync("/api/v2/attachments/7/description", new
        {
            database = "MEGA25", entityType = "PurchaseOrder", entityKey = "2700001", description = "  Copy of BL  ",
        });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var call = Assert.Single(factory.AttachmentStore.Calls);
        Assert.Equal("UpdateDescription", call.Operation);
        Assert.Equal("ERP_USER", call.User);
        Assert.Contains("\"ID\":7", call.LineData);
        Assert.Contains("\"FileDescription\":\"Copy of BL\"", call.LineData);

        var empty = await client.PostAsJsonAsync("/api/v2/attachments/7/description", new
        {
            database = "MEGA25", entityType = "PurchaseOrder", entityKey = "2700001", description = " ",
        });
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);
        Assert.Single(factory.AttachmentStore.Calls);
    }

    [Fact]
    public async Task Delete_is_a_soft_delete_that_keeps_the_file()
    {
        using var factory = new GatewayFactory();
        var path = Path.Combine(factory.StorageDir, "MEGA25", "20260928", "410800-20260928090000-0.pdf");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, Pdf);
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());

        var response = await client.DeleteAsync($"/api/v2/attachments/7?{Record}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Delete", Assert.Single(factory.AttachmentStore.Calls).Operation);
        Assert.True(File.Exists(path));
    }

    [Theory]
    [InlineData("10.1.2.3", HttpStatusCode.OK)]
    [InlineData("10.2.0.1", HttpStatusCode.NotFound)]      // private, but not an office range
    [InlineData("203.0.113.9", HttpStatusCode.NotFound)]
    public async Task Office_link_opens_without_login_only_from_the_internal_network(string ip, HttpStatusCode expected)
    {
        using var factory = new GatewayFactory();
        var name = "410800-20260928090000-0.pdf";
        Directory.CreateDirectory(Path.Combine(factory.StorageDir, "MEGA25", "20260928"));
        await File.WriteAllBytesAsync(Path.Combine(factory.StorageDir, "MEGA25", "20260928", name), Pdf);
        factory.AttachmentStore.Results["GetByFileName"] = new(0, "", [Row(name, "https://files.example/api/v2/files/MEGA25/" + name)]);
        // Settings > Office Networks: one office range, plus a junk entry that must be ignored
        factory.AttachmentStore.Results["GetOfficeNetworks"] = new(0, "",
            [new() { ["Cidr"] = "10.1.0.0/16" }, new() { ["Cidr"] = "not-a-network" }]);

        var context = await factory.Server.SendAsync(c =>
        {
            c.Request.Method = "GET";
            c.Request.Scheme = "https";
            c.Request.Path = $"/api/v2/files/MEGA25/{name}";
            c.Connection.RemoteIpAddress = IPAddress.Parse(ip);
        });
        Assert.Equal((int)expected, context.Response.StatusCode);
        Assert.All(factory.AttachmentStore.Calls, c => Assert.Equal("__lan_link__", c.User));
        // outside the office the file itself is never looked up
        Assert.Equal(expected == HttpStatusCode.OK,
            factory.AttachmentStore.Calls.Any(c => c.Operation == "GetByFileName"));
    }

    [Fact]
    public async Task Office_link_is_off_when_no_office_network_is_set_up()
    {
        using var factory = new GatewayFactory();   // GetOfficeNetworks returns no rows
        var context = await factory.Server.SendAsync(c =>
        {
            c.Request.Method = "GET";
            c.Request.Scheme = "https";
            c.Request.Path = "/api/v2/files/MEGA25/410800-20260928090000-0.pdf";
            c.Connection.RemoteIpAddress = IPAddress.Parse("10.1.2.3");
        });
        Assert.Equal(404, context.Response.StatusCode);
        Assert.DoesNotContain(factory.AttachmentStore.Calls, c => c.Operation == "GetByFileName");
    }
}

public sealed class FilesApiTests
{
    [Fact]
    public async Task Files_API_accepts_main_API_tokens_but_never_issues_tokens_or_runs_exec()
    {
        using var main = new GatewayFactory(localLogin: true);
        using var files = new GatewayFactory(verifyWith: main);
        using var mainClient = main.CreateClient();
        using var filesClient = files.CreateClient();

        // sign in on the MAIN API
        var login = await mainClient.PostAsJsonAsync("/api/v2/auth/login",
            new { database = "MEGA25", username = "ERP_USER", password = "Example-test-password-123" });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var token = (await login.Content.ReadFromJsonAsync<Plus.Api.Auth.TokenResponse>())!.AccessToken;

        // the FILES API accepts that token (public key + shared session check)
        filesClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var list = await filesClient.GetAsync("/api/v2/attachments?entityType=PurchaseOrder&entityKey=1");
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        Assert.Equal("ERP_USER", Assert.Single(files.AttachmentStore.Calls).User);

        // ...but it cannot issue tokens or run stored procedures
        var filesLogin = await filesClient.PostAsJsonAsync("/api/v2/auth/login",
            new { database = "MEGA25", username = "ERP_USER", password = "Example-test-password-123" });
        Assert.Equal(HttpStatusCode.NotFound, filesLogin.StatusCode);
        var exec = await filesClient.PostAsJsonAsync("/api/v2/exec",
            new { database = "MEGA25", proc = "Pls.TestOperation", operation = "View" });
        Assert.Equal(HttpStatusCode.NotFound, exec.StatusCode);
        Assert.Equal(0, files.Executor.Calls);

        // a token signed by some other key is refused
        filesClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", files.Token());
        var forged = await filesClient.GetAsync("/api/v2/attachments?entityType=PurchaseOrder&entityKey=1");
        Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);

        // logging out on the main API ends access on the Files API too
        var logout = new HttpRequestMessage(HttpMethod.Post, "/api/v2/auth/logout") { Content = new StringContent("") };
        logout.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        Assert.Equal(HttpStatusCode.NoContent, (await mainClient.SendAsync(logout)).StatusCode);
        filesClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var afterLogout = await filesClient.GetAsync("/api/v2/attachments?entityType=PurchaseOrder&entityKey=1");
        Assert.Equal(HttpStatusCode.Unauthorized, afterLogout.StatusCode);
    }
}

public sealed class AttachmentsDisabledTests
{
    [Fact]
    public async Task A_server_without_attachment_storage_refuses_every_attachment_endpoint()
    {
        // The main API (no Attachments section): list, upload, download, delete all 503.
        using var gateway = new GatewayFactory();
        using var factory = gateway.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?> { ["Attachments:StorageRoot"] = "" })));
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", gateway.Token());
        var list = await client.GetAsync("/api/v2/attachments?database=MEGA25&entityType=PurchaseOrder&entityKey=1");
        var download = await client.GetAsync("/api/v2/attachments/7/download?database=MEGA25&entityType=PurchaseOrder&entityKey=1");
        var delete = await client.DeleteAsync("/api/v2/attachments/7?database=MEGA25&entityType=PurchaseOrder&entityKey=1");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, list.StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, download.StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, delete.StatusCode);
    }
}
