namespace PosMonitoringAgent.Configuration;

/// <summary>
/// Remote, read-only access to POS log files under one locked folder. Section: "FileAccess".
/// Requests arrive from the central API (the agent polls for them), so no inbound port is opened.
/// </summary>
public sealed class FileAccessOptions
{
    public const string SectionName = "FileAccess";

    public bool Enabled { get; set; } = true;

    /// <summary>The only folder that can be listed or read. Nothing outside it is ever served.</summary>
    public string RootPath { get; set; } = @"C:\XeniaRetail\Logs";

    /// <summary>Only files with these extensions can be read (all files are still listed).</summary>
    public string[] AllowedExtensions { get; set; } = [];

    /// <summary>Largest chunk of a file returned per request; bigger files are paged.</summary>
    public int MaxReadBytes { get; set; } = 1024 * 1024;

    public int MaxListEntries { get; set; } = 2000;

    /// <summary>Depth limit when a folder is listed with subfolders.</summary>
    public int MaxRecursionDepth { get; set; } = 6;

    /// <summary>Mask card numbers, passwords, tokens and emails in file content before sending.</summary>
    public bool RedactContent { get; set; } = true;

    /// <summary>How long each poll waits on the server for a request (long-poll).</summary>
    public int PollWaitSeconds { get; set; } = 20;
}
