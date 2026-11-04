using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Collectors;

/// <summary>
/// Tails the POS application's own log files and keeps only error lines (plus stack traces).
/// Read offsets are persisted so restarts neither duplicate nor skip lines. Lines are redacted,
/// identical messages are merged, and a per-cycle cap prevents an error storm from flooding the queue.
/// </summary>
public sealed class PosLogFileCollector
{
    private const int MaxContinuationLines = 30;
    private static readonly TimeSpan MaxFileAge = TimeSpan.FromHours(24);

    private readonly PosApplicationOptions _options;
    private readonly LocalQueueService _queue;
    private readonly ILogger<PosLogFileCollector> _logger;
    private readonly Regex? _errorPattern;
    private readonly DateTime _agentStartUtc = DateTime.UtcNow;

    private static readonly Regex CriticalLevel = new(@"\b(FATAL|CRITICAL)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex ErrorLevel = new(@"\b(ERROR|ERR)\b|Exception", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public PosLogFileCollector(
        IOptions<PosApplicationOptions> options,
        LocalQueueService queue,
        ILogger<PosLogFileCollector> logger)
    {
        _options = options.Value;
        _queue = queue;
        _logger = logger;
        if (_options.LogErrorPatterns.Length > 0)
        {
            _errorPattern = new Regex(
                string.Join('|', _options.LogErrorPatterns.Select(p => $"(?:{p})")),
                RegexOptions.IgnoreCase | RegexOptions.Compiled,
                TimeSpan.FromMilliseconds(250));
        }
    }

    public async Task<LogCollectionBatch> CollectAsync(CancellationToken ct)
    {
        var directory = string.IsNullOrWhiteSpace(_options.LogDirectory)
            ? null
            : Environment.ExpandEnvironmentVariables(_options.LogDirectory);
        if (directory is null || _errorPattern is null || !Directory.Exists(directory))
        {
            return LogCollectionBatch.Empty;
        }

        var cutoff = DateTime.UtcNow - MaxFileAge;
        var files = new DirectoryInfo(directory)
            .EnumerateFiles(_options.LogFilePattern, SearchOption.TopDirectoryOnly)
            .Where(f => f.LastWriteTimeUtc >= cutoff)
            .OrderBy(f => f.LastWriteTimeUtc)
            .ToList();

        var merged = new Dictionary<(string File, string Message), LogEntry>();
        var checkpoints = new Dictionary<string, string>();
        var suppressed = 0;

        foreach (var file in files)
        {
            ct.ThrowIfCancellationRequested();
            var key = $"poslog:{file.FullName.ToLowerInvariant()}";
            var (offset, creationTicks) = ParseState(await _queue.GetStateAsync(key, ct));
            var fileCreation = file.CreationTimeUtc.Ticks;

            if (creationTicks is null)
            {
                // First time we see this file: only read it from the start if it appeared after the agent started.
                offset = file.CreationTimeUtc >= _agentStartUtc ? 0 : file.Length;
            }
            else if (creationTicks != fileCreation || file.Length < offset)
            {
                offset = 0; // rotated or truncated
            }

            try
            {
                var (lines, newOffset) = ReadCompleteLines(file.FullName, offset);
                checkpoints[key] = $"{newOffset.ToString(CultureInfo.InvariantCulture)}|{fileCreation.ToString(CultureInfo.InvariantCulture)}";

                foreach (var (message, level) in ExtractErrors(lines))
                {
                    var redacted = SensitiveDataRedactor.Redact(message, _options.MaxMessageLength) ?? string.Empty;
                    var mergeKey = (file.Name, redacted);
                    if (merged.TryGetValue(mergeKey, out var existing))
                    {
                        merged[mergeKey] = existing with { Occurrences = existing.Occurrences + 1 };
                        continue;
                    }

                    if (merged.Count >= _options.MaxLogEntriesPerCycle)
                    {
                        suppressed++;
                        continue;
                    }

                    merged[mergeKey] = new LogEntry
                    {
                        Source = "pos-log",
                        Level = level == EventPriority.Critical ? "critical" : level == EventPriority.High ? "error" : "warning",
                        OccurredAt = DateTimeOffset.UtcNow,
                        File = file.Name,
                        Message = redacted,
                        Priority = level,
                    };
                }
            }
            catch (IOException ex)
            {
                _logger.LogDebug(ex, "Could not read POS log {File}", file.FullName);
            }
            catch (UnauthorizedAccessException)
            {
                _logger.LogWarning("No permission to read POS log {File}", file.FullName);
            }
        }

        var entries = merged.Values.ToList();
        if (suppressed > 0)
        {
            entries.Add(new LogEntry
            {
                Source = "pos-log",
                Level = "warning",
                OccurredAt = DateTimeOffset.UtcNow,
                Message = $"{suppressed} additional POS log error(s) suppressed by the per-cycle limit of {_options.MaxLogEntriesPerCycle}",
                Priority = EventPriority.High,
            });
        }

        return new LogCollectionBatch(entries, checkpoints);
    }

    private (List<string> Lines, long NewOffset) ReadCompleteLines(string path, long offset)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (offset >= stream.Length)
        {
            return ([], Math.Min(offset, stream.Length));
        }

        stream.Seek(offset, SeekOrigin.Begin);
        var toRead = (int)Math.Min(_options.MaxBytesPerFilePerCycle, stream.Length - offset);
        var buffer = new byte[toRead];
        var read = stream.ReadAtLeast(buffer, toRead, throwOnEndOfStream: false);

        // Only consume whole lines; a partial last line is picked up next cycle.
        var lastNewline = Array.LastIndexOf(buffer, (byte)'\n', read - 1);
        int consumed;
        if (lastNewline >= 0)
        {
            consumed = lastNewline + 1;
        }
        else if (read == _options.MaxBytesPerFilePerCycle)
        {
            consumed = read; // a single enormous line; take it rather than stall forever
        }
        else
        {
            return ([], offset);
        }

        var text = Encoding.UTF8.GetString(buffer, 0, consumed);
        var lines = text.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0).ToList();
        return (lines, offset + consumed);
    }

    private IEnumerable<(string Message, EventPriority Level)> ExtractErrors(List<string> lines)
    {
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
            bool matched;
            try
            {
                matched = _errorPattern!.IsMatch(line);
            }
            catch (RegexMatchTimeoutException)
            {
                matched = false;
            }

            if (!matched)
            {
                continue;
            }

            // Attach stack trace / continuation lines (indented or "at ...").
            var sb = new StringBuilder(line);
            var extra = 0;
            while (i + 1 < lines.Count && extra < MaxContinuationLines && IsContinuation(lines[i + 1]))
            {
                sb.Append('\n').Append(lines[++i]);
                extra++;
            }

            var level = CriticalLevel.IsMatch(line) ? EventPriority.Critical
                : ErrorLevel.IsMatch(line) ? EventPriority.High
                : EventPriority.Normal;
            yield return (sb.ToString(), level);
        }
    }

    private static bool IsContinuation(string line) =>
        line.Length > 0 && (char.IsWhiteSpace(line[0]) || line.StartsWith("at ", StringComparison.Ordinal) || line.StartsWith("---", StringComparison.Ordinal));

    private static (long Offset, long? CreationTicks) ParseState(string? state)
    {
        var parts = state?.Split('|');
        if (parts is { Length: 2 } &&
            long.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var offset) &&
            long.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var ticks))
        {
            return (offset, ticks);
        }

        return (0, null);
    }
}
