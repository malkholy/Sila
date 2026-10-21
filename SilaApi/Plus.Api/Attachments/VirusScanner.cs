using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace Plus.Api.Attachments;

public enum ScanResult { Clean, Threat, Unavailable }

public interface IVirusScanner
{
    Task<ScanResult> ScanAsync(string path, CancellationToken cancellationToken);
}

// Microsoft Defender command-line scan of one file:
//   MpCmdRun.exe -Scan -ScanType 3 -File <path> -DisableRemediation
// Exit code 0 = no threat, 2 = threat found; anything else (missing scanner,
// timeout, error) = Unavailable, which the upload endpoint treats as a refusal
// when Attachments:RequireVirusScan is true (fail closed).
public sealed class DefenderScanner(IOptionsMonitor<AttachmentOptions> options, ILogger<DefenderScanner> logger)
    : IVirusScanner
{
    public async Task<ScanResult> ScanAsync(string path, CancellationToken cancellationToken)
    {
        var settings = options.CurrentValue;
        if (!OperatingSystem.IsWindows() || !File.Exists(settings.ScannerPath))
        {
            logger.LogWarning("Virus scanner not found at {ScannerPath}", settings.ScannerPath);
            return ScanResult.Unavailable;
        }
        var start = new ProcessStartInfo(settings.ScannerPath)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var arg in new[] { "-Scan", "-ScanType", "3", "-File", path, "-DisableRemediation" })
            start.ArgumentList.Add(arg);
        using var process = new Process { StartInfo = start };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(settings.ScanTimeoutSeconds, 10, 600)));
        try
        {
            process.Start();
            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            await Task.WhenAll(stdout, stderr);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            logger.LogWarning("Virus scan timed out or was cancelled");
            return ScanResult.Unavailable;
        }
        catch (Exception error)
        {
            logger.LogWarning("Virus scanner failed to run: {ErrorType}", error.GetType().Name);
            return ScanResult.Unavailable;
        }
        return process.ExitCode switch
        {
            0 => ScanResult.Clean,
            2 => ScanResult.Threat,
            _ => LogUnavailable(process.ExitCode),
        };
    }

    private ScanResult LogUnavailable(int exitCode)
    {
        logger.LogWarning("Virus scanner returned exit code {ExitCode}", exitCode);
        return ScanResult.Unavailable;
    }
}
