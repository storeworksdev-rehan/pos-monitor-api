using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Collectors;

/// <summary>
/// Reads new Critical/Error (optionally Warning) events from the configured channels.
/// Remembers the last EventRecordID per channel so nothing is read twice or skipped.
/// </summary>
public sealed class WindowsEventCollector(
    IOptions<EventLogOptions> options,
    IOptions<PosApplicationOptions> posOptions,
    LocalQueueService queue,
    ILogger<WindowsEventCollector> logger)
{
    private readonly EventLogOptions _options = options.Value;
    private readonly string[] _posProcessNames = posOptions.Value.ProcessNames
        .Select(n => Path.GetFileNameWithoutExtension(n.Trim()))
        .Where(n => n.Length > 0)
        .ToArray();

    public async Task<LogCollectionBatch> CollectAsync(CancellationToken ct)
    {
        if (_options.Channels.Length == 0)
        {
            return LogCollectionBatch.Empty;
        }

        var entries = new List<LogEntry>();
        var checkpoints = new Dictionary<string, string>();
        var budget = Math.Max(1, _options.MaxEventsPerCycle);

        foreach (var channel in _options.Channels)
        {
            ct.ThrowIfCancellationRequested();
            var key = $"eventlog:{channel}";
            long? bookmark = long.TryParse(await queue.GetStateAsync(key, ct), out var b) ? b : null;

            try
            {
                var newest = GetNewestRecordId(channel);
                if (bookmark.HasValue && newest.HasValue && newest.Value < bookmark.Value)
                {
                    logger.LogInformation("Event log {Channel} was cleared; restarting from the beginning", channel);
                    bookmark = 0;
                }

                var read = ReadChannel(channel, bookmark, budget - entries.Count, entries, out var lastRecordId, out var exhausted);
                budget -= read;

                // If we stopped because of the budget, continue from the last event read next cycle.
                // Otherwise jump to the newest record so non-matching events are not rescanned.
                var next = exhausted
                    ? lastRecordId ?? bookmark
                    : new[] { lastRecordId, newest, bookmark }.Max();
                if (next.HasValue)
                {
                    checkpoints[key] = next.Value.ToString(CultureInfo.InvariantCulture);
                }
            }
            catch (EventLogNotFoundException)
            {
                logger.LogDebug("Event log channel {Channel} does not exist", channel);
            }
            catch (UnauthorizedAccessException)
            {
                logger.LogWarning("No permission to read event log channel {Channel}", channel);
            }
            catch (EventLogException ex)
            {
                logger.LogWarning(ex, "Failed to read event log channel {Channel}", channel);
            }

            if (entries.Count >= _options.MaxEventsPerCycle)
            {
                break;
            }
        }

        return new LogCollectionBatch(entries, checkpoints);
    }

    private int ReadChannel(
        string channel,
        long? bookmark,
        int budget,
        List<LogEntry> sink,
        out long? lastRecordId,
        out bool exhausted)
    {
        lastRecordId = null;
        exhausted = false;
        if (budget <= 0)
        {
            exhausted = true;
            return 0;
        }

        var levels = string.Join(" or ", Enumerable.Range(1, Math.Clamp(_options.MaxLevel, 1, 4)).Select(l => $"Level={l}"));
        var position = bookmark.HasValue
            ? $"EventRecordID > {bookmark.Value}"
            : $"TimeCreated[timediff(@SystemTime) <= {(long)TimeSpan.FromMinutes(_options.InitialLookbackMinutes).TotalMilliseconds}]";
        var query = new EventLogQuery(channel, PathType.LogName, $"*[System[({levels}) and {position}]]");

        var added = 0;
        using var reader = new EventLogReader(query);
        while (true)
        {
            using var record = reader.ReadEvent();
            if (record is null)
            {
                break;
            }

            lastRecordId = record.RecordId ?? lastRecordId;
            if (!IsProviderIncluded(record.ProviderName))
            {
                continue;
            }

            sink.Add(ToEntry(channel, record));
            added++;
            if (added >= budget)
            {
                exhausted = true;
                break;
            }
        }

        return added;
    }

    private LogEntry ToEntry(string channel, EventRecord record)
    {
        string? message = null;
        try
        {
            message = record.FormatDescription();
        }
        catch (EventLogException)
        {
            // Provider metadata missing; provider and event id still identify the event.
        }

        var level = record.Level switch
        {
            1 => "critical",
            2 => "error",
            3 => "warning",
            _ => "information",
        };

        return new LogEntry
        {
            Source = "windows-event",
            Level = level,
            OccurredAt = record.TimeCreated is { } t ? new DateTimeOffset(t.ToUniversalTime(), TimeSpan.Zero) : DateTimeOffset.UtcNow,
            Channel = channel,
            Provider = record.ProviderName,
            WindowsEventId = record.Id,
            RecordId = record.RecordId,
            Message = SensitiveDataRedactor.Redact(message, _options.MaxMessageLength),
            Priority = Classify(record, message),
        };
    }

    private EventPriority Classify(EventRecord record, string? message)
    {
        if (record.Level == 1)
        {
            return EventPriority.Critical;
        }

        // Application Error / Hang / .NET Runtime events about the POS itself are crashes.
        if (_options.CriticalEventIds.Contains(record.Id) &&
            message is not null &&
            _posProcessNames.Any(p => message.Contains(p, StringComparison.OrdinalIgnoreCase)))
        {
            return EventPriority.Critical;
        }

        return record.Level == 2 ? EventPriority.High : EventPriority.Normal;
    }

    private bool IsProviderIncluded(string? provider)
    {
        provider ??= string.Empty;
        if (_options.ProviderDenyList.Contains(provider, StringComparer.OrdinalIgnoreCase))
        {
            return false;
        }

        return _options.ProviderAllowList.Length == 0 ||
               _options.ProviderAllowList.Contains(provider, StringComparer.OrdinalIgnoreCase);
    }

    private static long? GetNewestRecordId(string channel)
    {
        var query = new EventLogQuery(channel, PathType.LogName, "*") { ReverseDirection = true };
        using var reader = new EventLogReader(query);
        using var newest = reader.ReadEvent();
        return newest?.RecordId;
    }
}
