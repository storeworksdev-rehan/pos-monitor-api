using System.Text;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Services;

/// <summary>
/// Read-only browsing of files under a single locked root folder (default C:\XeniaRetail\Logs).
///
/// Every requested path is normalized and must stay inside the root: "..", other drives,
/// UNC/device paths, wildcards, alternate data streams and links/junctions are refused.
/// A path that is a folder returns its listing; a path that is a file returns its content
/// (paged for large files, redacted by default); anything else is "not found".
/// </summary>
public sealed class FileAccessService
{
    private readonly FileAccessOptions _options;
    private readonly ILogger<FileAccessService> _logger;
    private readonly HashSet<string> _extensions;
    private readonly string? _rootError;

    public FileAccessService(IOptions<FileAccessOptions> options, ILogger<FileAccessService> logger)
    {
        _options = options.Value;
        _logger = logger;
        _extensions = new HashSet<string>(
            _options.AllowedExtensions.Select(e => e.StartsWith('.') ? e : "." + e),
            StringComparer.OrdinalIgnoreCase);

        Root = Path.GetFullPath(Environment.ExpandEnvironmentVariables(_options.RootPath)).TrimEnd('\\');
        if (Root.Length <= 2)
        {
            // Never allow a whole drive to be exposed by a configuration mistake.
            _rootError = $"FileAccess:RootPath '{_options.RootPath}' is a drive root; refusing to serve files.";
            _logger.LogError("{Error}", _rootError);
        }
    }

    public string Root { get; }

    public RemoteCommandResult Browse(RemoteCommandArgs? args)
    {
        if (!_options.Enabled)
        {
            return RemoteCommandResult.Failure("disabled", "File access is disabled on this device.");
        }

        if (_rootError is not null)
        {
            return RemoteCommandResult.Failure("disabled", _rootError);
        }

        if (!TryResolve(args?.Path, out var full, out var error))
        {
            return RemoteCommandResult.Failure("denied", error);
        }

        try
        {
            if (File.Exists(full))
            {
                return ReadFile(full, args ?? new RemoteCommandArgs(full));
            }

            if (Directory.Exists(full))
            {
                return RemoteCommandResult.Success(List(full, args?.Recursive ?? false));
            }

            var parent = Path.GetDirectoryName(full);
            var hint = parent is not null && IsUnderRoot(parent) && Directory.Exists(parent)
                ? $" The folder '{parent}' exists."
                : string.Empty;
            return RemoteCommandResult.Failure("not-found", $"'{full}' was not found on this device.{hint}");
        }
        catch (UnauthorizedAccessException)
        {
            return RemoteCommandResult.Failure("denied", $"The agent has no permission to read '{full}'.");
        }
        catch (IOException ex)
        {
            return RemoteCommandResult.Failure("io-error", ex.Message);
        }
    }

    // ------------------------------------------------------------------ path lock

    private bool TryResolve(string? requested, out string full, out string error)
    {
        full = Root;
        error = string.Empty;
        if (string.IsNullOrWhiteSpace(requested))
        {
            return true;
        }

        var path = requested.Trim().Replace('/', '\\');
        if (path.IndexOfAny(['\0', '*', '?', '"', '<', '>', '|']) >= 0)
        {
            error = "The path contains characters that are not allowed.";
            return false;
        }

        if (path.StartsWith(@"\\", StringComparison.Ordinal))
        {
            error = "Network and device paths are not allowed.";
            return false;
        }

        // A colon is only valid as the drive separator ("C:"); anything else is an alternate data stream.
        var colon = path.IndexOf(':');
        if (colon >= 0 && (colon != 1 || path.IndexOf(':', colon + 1) >= 0))
        {
            error = "The path format is not allowed.";
            return false;
        }

        // Paths without a drive are taken relative to the root.
        var candidate = colon == 1 ? path : Path.Combine(Root, path.TrimStart('\\'));
        try
        {
            full = Path.GetFullPath(candidate).TrimEnd('\\');
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            error = "The path is not valid.";
            return false;
        }

        if (!IsUnderRoot(full))
        {
            error = $"Only files under {Root} can be accessed.";
            return false;
        }

        if (PassesThroughLink(full))
        {
            error = "Links and junctions are not followed.";
            return false;
        }

        return true;
    }

    private bool IsUnderRoot(string full) =>
        full.Equals(Root, StringComparison.OrdinalIgnoreCase) ||
        full.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase);

    /// <summary>A junction or symlink inside the root could point anywhere; refuse to traverse one.</summary>
    private bool PassesThroughLink(string full)
    {
        var current = full;
        while (current.Length > Root.Length)
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                {
                    return true;
                }
            }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
            {
                // Not existing is fine here; Browse reports "not found".
            }

            current = Path.GetDirectoryName(current) ?? Root;
        }

        return false;
    }

    private string? ParentOf(string full) =>
        full.Equals(Root, StringComparison.OrdinalIgnoreCase) ? null : Path.GetDirectoryName(full);

    // ------------------------------------------------------------------ listing

    private DirectoryListing List(string full, bool recursive)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = recursive,
            MaxRecursionDepth = Math.Max(1, _options.MaxRecursionDepth),
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.System,
            ReturnSpecialDirectories = false,
        };

        var entries = new List<FileEntry>();
        var truncated = false;
        foreach (var info in new DirectoryInfo(full).EnumerateFileSystemInfos("*", options))
        {
            if (entries.Count >= _options.MaxListEntries)
            {
                truncated = true;
                break;
            }

            entries.Add(info is FileInfo file
                ? new FileEntry(file.Name, file.FullName, "file", file.Length, ToUtc(file.LastWriteTimeUtc), IsReadable(file.Extension))
                : new FileEntry(info.Name, info.FullName, "directory", null, ToUtc(info.LastWriteTimeUtc), false));
        }

        // Folders first (by name), then files newest first: the latest logs are usually what is wanted.
        var sorted = entries
            .OrderBy(e => e.Type == "directory" ? 0 : 1)
            .ThenBy(e => e.Type == "directory" ? e.Path : string.Empty, StringComparer.OrdinalIgnoreCase)
            .ThenByDescending(e => e.Type == "file" ? e.Modified : DateTimeOffset.MinValue)
            .ToList();

        return new DirectoryListing("directory", full, Root, ParentOf(full), recursive, truncated, sorted.Count, sorted);
    }

    private bool IsReadable(string extension) => _extensions.Count == 0 || _extensions.Contains(extension);

    private static DateTimeOffset ToUtc(DateTime utc) => new(DateTime.SpecifyKind(utc, DateTimeKind.Utc));

    // ------------------------------------------------------------------ reading

    private RemoteCommandResult ReadFile(string full, RemoteCommandArgs args)
    {
        var info = new FileInfo(full);
        if (!IsReadable(info.Extension))
        {
            return RemoteCommandResult.Failure(
                "unsupported",
                $"Only {string.Join(", ", _extensions.Order())} files can be opened. The file exists ({info.Length:N0} bytes).");
        }

        var max = Math.Max(4096, _options.MaxReadBytes);
        using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var size = stream.Length;

        // Encoding from the byte-order mark at the start of the file.
        var bom = new byte[3];
        var bomRead = stream.Read(bom, 0, 3);
        var (encoding, bomLength) = DetectEncoding(bom, bomRead);
        var unit = encoding.Equals(Encoding.Unicode) || encoding.Equals(Encoding.BigEndianUnicode) ? 2 : 1;

        // Explicit offset pages through the file; otherwise show the end of large files (newest log lines).
        long start = args.Offset is { } offset
            ? Math.Clamp(offset, bomLength, size)
            : args.Tail && size > max ? size - max : bomLength;
        start -= (start - bomLength) % unit;
        var count = (int)Math.Min(max, size - start);

        // Does the chunk start at the beginning of a line? (Next/previous pages always do.)
        var startsOnLine = start <= bomLength;
        if (!startsOnLine && unit == 1)
        {
            stream.Seek(start - 1, SeekOrigin.Begin);
            startsOnLine = stream.ReadByte() == '\n';
        }

        var buffer = new byte[count];
        stream.Seek(start, SeekOrigin.Begin);
        var read = stream.ReadAtLeast(buffer, count, throwOnEndOfStream: false);

        if (unit == 1 && Array.IndexOf(buffer, (byte)0, 0, Math.Min(read, 8192)) >= 0)
        {
            return RemoteCommandResult.Failure("unsupported", "This looks like a binary file and cannot be shown as text.");
        }

        // Show whole lines only: drop a partial first line (chunk starts mid-file) and a partial last line.
        var from = 0;
        var to = read;
        if (unit == 1)
        {
            if (!startsOnLine)
            {
                var nl = Array.IndexOf(buffer, (byte)'\n', 0, read);
                if (nl >= 0 && nl < read - 1)
                {
                    from = nl + 1;
                }
            }

            if (start + read < size)
            {
                var nl = Array.LastIndexOf(buffer, (byte)'\n', read - 1);
                if (nl >= from)
                {
                    to = nl + 1;
                }
            }
        }

        var text = encoding.GetString(buffer, from, to - from);
        if (_options.RedactContent)
        {
            text = RedactLines(text);
        }

        var chunkStart = start + from;
        var chunkLength = to - from;
        return RemoteCommandResult.Success(new FileContent(
            Kind: "file",
            Path: full,
            Name: info.Name,
            Parent: ParentOf(full),
            Size: size,
            Modified: ToUtc(info.LastWriteTimeUtc),
            Offset: chunkStart,
            Length: chunkLength,
            Truncated: chunkStart > bomLength || chunkStart + chunkLength < size,
            HasMoreBefore: chunkStart > bomLength,
            HasMoreAfter: chunkStart + chunkLength < size,
            Encoding: encoding.WebName,
            Redacted: _options.RedactContent,
            Content: text));
    }

    private static (Encoding Encoding, int BomLength) DetectEncoding(byte[] bom, int read)
    {
        if (read >= 3 && bom[0] == 0xEF && bom[1] == 0xBB && bom[2] == 0xBF)
        {
            return (new UTF8Encoding(false), 3);
        }

        if (read >= 2 && bom[0] == 0xFF && bom[1] == 0xFE)
        {
            return (Encoding.Unicode, 2);
        }

        if (read >= 2 && bom[0] == 0xFE && bom[1] == 0xFF)
        {
            return (Encoding.BigEndianUnicode, 2);
        }

        return (new UTF8Encoding(false), 0);
    }

    private static string RedactLines(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var line in text.Split('\n'))
        {
            if (sb.Length > 0)
            {
                sb.Append('\n');
            }

            sb.Append(SensitiveDataRedactor.Redact(line, int.MaxValue));
        }

        return sb.ToString();
    }
}
