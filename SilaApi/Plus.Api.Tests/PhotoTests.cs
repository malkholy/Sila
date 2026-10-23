using System.Net;
using System.Net.Http.Headers;
using Plus.Api.Photos;
using Xunit;

namespace Plus.Api.Tests;

public sealed class FakePhotoSource : IPhotoSource
{
    public byte[]? Body { get; set; } = PhotoTests.Jpeg;
    public List<Uri> Requested { get; } = [];
    public Task<byte[]?> FetchAsync(Uri uri, int maxBytes, CancellationToken cancellationToken)
    {
        Requested.Add(uri);
        return Task.FromResult(Body);
    }
}

public sealed class PhotoTests
{
    public static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, (byte)'J', (byte)'F', (byte)'I', (byte)'F'];
    private const string Link = "https://photos.example.test:7007/General/ShowImage/C-Users-Profile/108056-0.jpg";
    private static readonly PhotoOptions Settings = new() { Hosts = ["photos.example.test:7007"] };

    [Theory]
    [InlineData(Link, true)]
    [InlineData("https://PHOTOS.example.test:7007/general/showimage/x/1-0.jpg", true)]
    [InlineData("https://photos.example.test:7008/General/ShowImage/x/1-0.jpg", false)]      // other port
    [InlineData("https://evil.example.test:7007/General/ShowImage/x/1-0.jpg", false)]        // other host
    [InlineData("https://photos.example.test:7007/General/Other/x/1-0.jpg", false)]          // other path
    [InlineData("https://photos.example.test:7007/General/ShowImage/../Admin/x", false)]     // climbing out
    [InlineData("https://photos.example.test:7007/General/ShowImage/%2e%2e/x", false)]       // escaped
    [InlineData("https://photos.example.test:7007/General/ShowImage/x.jpg?next=http://a", false)]
    [InlineData("https://u:p@photos.example.test:7007/General/ShowImage/x.jpg", false)]
    [InlineData("file:///C:/General/ShowImage/x.jpg", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Only_configured_photo_links_are_fetched(string? url, bool allowed) =>
        Assert.Equal(allowed, PhotoEndpoints.TryResolve(url, Settings, out _));

    [Fact]
    public void Upstream_base_keeps_the_path()
    {
        var settings = new PhotoOptions { Hosts = ["photos.example.test:7007"], UpstreamBase = "http://10.1.245.245:7007/" };
        Assert.True(PhotoEndpoints.TryResolve(Link, settings, out var upstream));
        Assert.Equal("http://10.1.245.245:7007/General/ShowImage/C-Users-Profile/108056-0.jpg", upstream.AbsoluteUri);
    }

    [Fact]
    public void Type_comes_from_the_bytes()
    {
        Assert.Equal("image/jpeg", PhotoEndpoints.ContentType(Jpeg));
        Assert.Equal("image/png", PhotoEndpoints.ContentType([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]));
        Assert.Null(PhotoEndpoints.ContentType("<html><script>"u8.ToArray()));
    }

    [Fact]
    public async Task Photo_needs_a_signed_in_caller()
    {
        using var factory = new GatewayFactory();
        var response = await factory.CreateClient().GetAsync($"/api/v2/photo?url={Uri.EscapeDataString(Link)}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(factory.Photos.Requested);
    }

    [Fact]
    public async Task Photo_is_served_as_an_image_and_cached()
    {
        using var factory = new GatewayFactory();
        var client = factory.CreateClient();
        for (var i = 0; i < 2; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v2/photo?url={Uri.EscapeDataString(Link)}");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());
            var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("image/jpeg", response.Content.Headers.ContentType?.MediaType);
            Assert.Equal(Jpeg, await response.Content.ReadAsByteArrayAsync());
            Assert.Contains("private", response.Headers.CacheControl?.ToString());
        }
        Assert.Single(factory.Photos.Requested);   // the second one came from the cache
    }

    [Fact]
    public async Task Something_that_is_not_an_image_is_refused()
    {
        using var factory = new GatewayFactory();
        factory.Photos.Body = "<html><script>alert(1)</script>"u8.ToArray();
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v2/photo?url={Uri.EscapeDataString(Link)}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());
        var response = await factory.CreateClient().SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Links_to_other_servers_are_never_fetched()
    {
        using var factory = new GatewayFactory();
        using var request = new HttpRequestMessage(HttpMethod.Get,
            $"/api/v2/photo?url={Uri.EscapeDataString("http://169.254.169.254/latest/meta-data/")}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token());
        var response = await factory.CreateClient().SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(factory.Photos.Requested);
    }
}
