using System.IO.Compression;

namespace Plus.Api.Attachments;

// One allowed upload type. ContentType is what the gateway stores and serves --
// never the browser-supplied Content-Type. Inline = may be opened in the
// browser (PDF / images); everything else is always downloaded.
public sealed record FileTypeRule(string Extension, string ContentType, bool Inline, FileKind Kind);

public enum FileKind { Pdf, Png, Jpeg, OfficeWord, OfficeExcel, OfficePowerPoint, Text }

// Allowlist of upload types + a content check that the bytes really are that
// type (a renamed .exe fails). Office files must be macro-free OOXML.
public static class FileTypePolicy
{
    private static readonly Dictionary<string, FileTypeRule> Rules = new(StringComparer.OrdinalIgnoreCase)
    {
        [".pdf"] = new(".pdf", "application/pdf", true, FileKind.Pdf),
        [".png"] = new(".png", "image/png", true, FileKind.Png),
        [".jpg"] = new(".jpg", "image/jpeg", true, FileKind.Jpeg),
        [".jpeg"] = new(".jpeg", "image/jpeg", true, FileKind.Jpeg),
        [".docx"] = new(".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false, FileKind.OfficeWord),
        [".xlsx"] = new(".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false, FileKind.OfficeExcel),
        [".pptx"] = new(".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", false, FileKind.OfficePowerPoint),
        [".txt"] = new(".txt", "text/plain", false, FileKind.Text),
        [".csv"] = new(".csv", "text/csv", false, FileKind.Text),
    };

    public static string AllowedList => string.Join(", ", Rules.Keys.Order());

    public static FileTypeRule? ForExtension(string? extension) =>
        extension is not null && Rules.TryGetValue(extension, out var rule) ? rule : null;

    // null = the file content matches its type; otherwise the reason it does not.
    public static string? Validate(string path, FileTypeRule rule)
    {
        using var stream = File.OpenRead(path);
        var head = new byte[8];
        var read = stream.Read(head, 0, head.Length);
        stream.Position = 0;
        return rule.Kind switch
        {
            FileKind.Pdf => StartsWith(head, read, "%PDF-"u8) ? null : "not a PDF file",
            FileKind.Png => StartsWith(head, read, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) ? null : "not a PNG image",
            FileKind.Jpeg => StartsWith(head, read, [0xFF, 0xD8, 0xFF]) ? null : "not a JPEG image",
            FileKind.OfficeWord => ValidateOffice(stream, head, read, "word/document.xml"),
            FileKind.OfficeExcel => ValidateOffice(stream, head, read, "xl/workbook.xml"),
            FileKind.OfficePowerPoint => ValidateOffice(stream, head, read, "ppt/presentation.xml"),
            FileKind.Text => ValidateText(stream),
            _ => "unsupported type",
        };
    }

    private static bool StartsWith(byte[] head, int read, ReadOnlySpan<byte> signature) =>
        read >= signature.Length && head.AsSpan(0, signature.Length).SequenceEqual(signature);

    // OOXML = a zip with [Content_Types].xml and the expected main part, and no
    // VBA project anywhere (macro-enabled .xlsm/.docm renamed to .xlsx fail here).
    private static string? ValidateOffice(Stream stream, byte[] head, int read, string mainPart)
    {
        if (!StartsWith(head, read, [0x50, 0x4B, 0x03, 0x04])) return "not an Office document";
        try
        {
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: true);
            if (zip.Entries.Count > 10000) return "Office document has too many parts";
            var hasTypes = false; var hasMain = false;
            foreach (var entry in zip.Entries)
            {
                var name = entry.FullName.Replace('\\', '/');
                if (name.EndsWith("vbaProject.bin", StringComparison.OrdinalIgnoreCase)
                    || name.EndsWith("vbaData.xml", StringComparison.OrdinalIgnoreCase))
                    return "Office documents with macros are not allowed";
                if (name.Equals("[Content_Types].xml", StringComparison.OrdinalIgnoreCase))
                {
                    hasTypes = true;
                    if (entry.Length > 1024 * 1024) return "invalid Office document";
                    using var reader = new StreamReader(entry.Open());
                    var types = reader.ReadToEnd();
                    if (types.Contains("macroEnabled", StringComparison.OrdinalIgnoreCase)
                        || types.Contains("vbaProject", StringComparison.OrdinalIgnoreCase))
                        return "Office documents with macros are not allowed";
                }
                if (name.Equals(mainPart, StringComparison.OrdinalIgnoreCase)) hasMain = true;
            }
            return hasTypes && hasMain ? null : "not a valid Office document of this type";
        }
        catch (InvalidDataException)
        {
            return "damaged or invalid Office document";
        }
    }

    // Text/CSV: must not be binary (executables and most binary formats
    // contain NUL bytes in their first 64 KB).
    private static string? ValidateText(Stream stream)
    {
        var buffer = new byte[64 * 1024];
        var read = stream.Read(buffer, 0, buffer.Length);
        return buffer.AsSpan(0, read).Contains((byte)0) ? "not a text file" : null;
    }
}
