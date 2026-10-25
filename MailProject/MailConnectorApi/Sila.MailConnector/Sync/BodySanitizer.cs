using System.IO.Compression;
using System.Text;
using Ganss.Xss;

namespace Sila.MailConnector.Sync;

// Mail HTML is untrusted: it is sanitized here, once, before it is stored, so
// neither database ever holds active content (MailPlan 3). Removed: scripts,
// frames, objects, forms, event handlers, style blocks, and any link or image
// that is not http(s), mailto or cid (inline images). Inline style attributes
// stay (mail layout depends on them), with their CSS checked by the library.
// The app still shows bodies in a sandboxed frame -- this is not the only layer.
public static class BodySanitizer
{
    public const int MaxHtmlChars = 2_000_000;
    // The text is kept for search only.
    public const int MaxTextChars = 65_536;

    private static readonly HtmlSanitizer Sanitizer = Create();

    private static HtmlSanitizer Create()
    {
        var sanitizer = new HtmlSanitizer();
        sanitizer.AllowedSchemes.Add("mailto");
        sanitizer.AllowedSchemes.Add("cid");
        foreach (var tag in new[] { "form", "input", "button", "select", "option", "optgroup", "textarea", "label",
                     "fieldset", "legend", "datalist", "output", "style" })
            sanitizer.AllowedTags.Remove(tag);
        sanitizer.AllowDataAttributes = false;
        return sanitizer;
    }

    // Thread-safe: the configuration is never changed after Create.
    public static string? Html(string? html) =>
        string.IsNullOrWhiteSpace(html) ? null : Sanitizer.Sanitize(html.Length > MaxHtmlChars ? html[..MaxHtmlChars] : html);

    public static string? Text(string? text) =>
        text is null || text.Length <= MaxTextChars ? text : text[..MaxTextChars];

    // Stored form of the HTML (MailMessageBody.BodyHtmlGz): gzip of the UTF-16 text,
    // the same bytes as SQL Server's COMPRESS(nvarchar), so SQL can read it with
    // CAST(DECOMPRESS(BodyHtmlGz) AS NVARCHAR(MAX)) and C# with Decompress below.
    public static byte[]? Compress(string? html)
    {
        if (html is null) return null;
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
            gzip.Write(Encoding.Unicode.GetBytes(html));
        return output.ToArray();
    }

    public static string? Decompress(byte[]? stored)
    {
        if (stored is null) return null;
        using var gzip = new GZipStream(new MemoryStream(stored), CompressionMode.Decompress);
        using var text = new MemoryStream();
        gzip.CopyTo(text);
        return Encoding.Unicode.GetString(text.GetBuffer(), 0, (int)text.Length);
    }
}
