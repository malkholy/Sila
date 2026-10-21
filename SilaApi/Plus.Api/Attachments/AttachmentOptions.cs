namespace Plus.Api.Attachments;

// "Attachments" configuration section. Attachments are disabled (503) until
// StorageRoot and QuarantineRoot are set.
public sealed class AttachmentOptions
{
    // Final files: <StorageRoot>/<database key>/<yyyyMMdd>/<FileHistory.FileName>.
    public string StorageRoot { get; set; } = "";
    // Uploads wait here (random name, no extension) until the content check and
    // the virus scan pass. Keep it outside StorageRoot.
    public string QuarantineRoot { get; set; } = "";
    public long MaxFileSizeBytes { get; set; } = 50L * 1024 * 1024;
    public bool RequireVirusScan { get; set; } = true;
    public string ScannerPath { get; set; } = @"C:\Program Files\Windows Defender\MpCmdRun.exe";
    public int ScanTimeoutSeconds { get; set; } = 120;
    // Base of the FileURL / FileDisplay links written to fil.FileHistory
    // (e.g. https://files.glcpaints.com:5000). Empty = the request's own host.
    public string PublicBaseUrl { get; set; } = "";
    // host:port of the old FileManager whose FileURL links the API may fetch
    // (e.g. "10.1.245.245:7001"). Empty = old-system files cannot be opened.
    public string[] LegacyHosts { get; set; } = [];

    public bool Configured => !string.IsNullOrWhiteSpace(StorageRoot) && !string.IsNullOrWhiteSpace(QuarantineRoot);
}
