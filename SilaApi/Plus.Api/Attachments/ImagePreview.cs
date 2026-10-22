using SkiaSharp;

namespace Plus.Api.Attachments;

// Small JPEG previews of stored images, for chat bubbles: at most MaxSide px on
// the longest side. Made once (on upload, or on the first request for an older
// file) and kept next to the original as "<stored name>.preview.jpg"; the
// original is never changed. Anything that can't be previewed -- not an image,
// unreadable, too large to decode safely -- returns null and the caller serves
// the original instead.
public static class ImagePreview
{
    public const int MaxSide = 480;
    // An image this small (bytes) whose sides already fit is served as it is.
    private const long SmallEnough = 120 * 1024;
    // Decompression-bomb guard: refuse to decode more pixels than this.
    private const long MaxPixels = 60_000_000;

    public static bool Supports(string extension) =>
        extension.Equals(".png", StringComparison.OrdinalIgnoreCase)
        || extension.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
        || extension.Equals(".jpeg", StringComparison.OrdinalIgnoreCase);

    public static string PathFor(string original) => original + ".preview.jpg";

    // The preview's path (made now if missing), or null: serve the original.
    public static string? Ensure(string original)
    {
        var target = PathFor(original);
        if (File.Exists(target)) return target;
        if (!Supports(Path.GetExtension(original)) || !File.Exists(original)) return null;
        try
        {
            using var codec = SKCodec.Create(original);
            if (codec is null) return null;
            var (w, h) = (codec.Info.Width, codec.Info.Height);
            if (w <= 0 || h <= 0 || (long)w * h > MaxPixels) return null;
            var scale = Math.Min(1.0, MaxSide / (double)Math.Max(w, h));
            if (scale >= 1.0 && new FileInfo(original).Length <= SmallEnough) return null;

            using var decoded = SKBitmap.Decode(codec);
            if (decoded is null) return null;
            var nw = Math.Max(1, (int)Math.Round(w * scale));
            var nh = Math.Max(1, (int)Math.Round(h * scale));
            using var resized = decoded.Resize(new SKImageInfo(nw, nh), new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear));
            if (resized is null) return null;
            // JPEG has no transparency: flatten onto white (screenshots, logos)
            using var surface = SKSurface.Create(new SKImageInfo(nw, nh, SKColorType.Rgba8888, SKAlphaType.Premul));
            surface.Canvas.Clear(SKColors.White);
            surface.Canvas.DrawBitmap(resized, 0, 0);
            using var image = surface.Snapshot();
            using var data = image.Encode(SKEncodedImageFormat.Jpeg, 80);
            if (data is null) return null;

            // write beside it, then move into place: a reader never sees half a file
            var temp = $"{target}.{Guid.NewGuid():N}.tmp";
            using (var stream = File.Create(temp)) data.SaveTo(stream);
            try { File.Move(temp, target, overwrite: false); }
            catch (IOException) when (File.Exists(target)) { File.Delete(temp); }   // made by a parallel request
            return target;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException
                                      or InvalidOperationException or OutOfMemoryException)
        {
            return null;
        }
    }
}
