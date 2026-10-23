using System.IO.Compression;

namespace Plus.Api.Attachments;

// One allowed upload type. ContentType is what the gateway stores and serves --
// never the browser-supplied Content-Type. Inline = may be opened in the
// browser (PDF / images / audio); everything else is always downloaded.
public sealed record FileTypeRule(string Extension, string ContentType, bool Inline, FileKind Kind);

public enum FileKind { Pdf, Png, Jpeg, OfficeWord, OfficeExcel, OfficePowerPoint, Text, Mp4Audio, Aac, Mp3, Ogg, Wav, WebM }

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
        // voice notes: what the mobile app records (.m4a) and the other common recorders
        [".m4a"] = new(".m4a", "audio/mp4", true, FileKind.Mp4Audio),
        [".aac"] = new(".aac", "audio/aac", true, FileKind.Aac),
        [".mp3"] = new(".mp3", "audio/mpeg", true, FileKind.Mp3),
        [".ogg"] = new(".ogg", "audio/ogg", true, FileKind.Ogg),
        [".opus"] = new(".opus", "audio/ogg", true, FileKind.Ogg),
        [".wav"] = new(".wav", "audio/wav", true, FileKind.Wav),
        [".webm"] = new(".webm", "audio/webm", true, FileKind.WebM),
    };

    public static string AllowedList => string.Join(", ", Rules.Keys.Order());

    public static FileTypeRule? ForExtension(string? extension) =>
        extension is not null && Rules.TryGetValue(extension, out var rule) ? rule : null;

    // null = the file content matches its type; otherwise the reason it does not.
    public static string? Validate(string path, FileTypeRule rule)
    {
        using var stream = File.OpenRead(path);
        var head = new byte[12];
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
            // MP4 container: a box whose type (bytes 4-7) is "ftyp"
            FileKind.Mp4Audio => read >= 8 && head.AsSpan(4, 4).SequenceEqual("ftyp"u8) ? null : "not an M4A audio file",
            // ADTS frame sync: 12 bits set, layer 00
            FileKind.Aac => read >= 2 && head[0] == 0xFF && (head[1] & 0xF6) == 0xF0 ? null : "not an AAC audio file",
            // an ID3 tag, or an MPEG audio frame sync (11 bits set)
            FileKind.Mp3 => StartsWith(head, read, "ID3"u8) || read >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0
                ? null : "not an MP3 audio file",
            FileKind.Ogg => StartsWith(head, read, "OggS"u8) ? null : "not an Ogg audio file",
            FileKind.Wav => StartsWith(head, read, "RIFF"u8) && read >= 12 && head.AsSpan(8, 4).SequenceEqual("WAVE"u8)
                ? null : "not a WAV audio file",
            FileKind.WebM => StartsWith(head, read, [0x1A, 0x45, 0xDF, 0xA3]) ? null : "not a WebM audio file",
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
