using System.Text.Json.Serialization;

namespace PosMonitoringAgent.Models;

/// <summary>Body of a "log" event. Messages are redacted and truncated before they get here.</summary>
public sealed record LogEntry
{
    /// <summary>"windows-event" or "pos-log".</summary>
    public required string Source { get; init; }
    public required string Level { get; init; }
    /// <summary>When the event/line was written (envelope timestamp is when it was queued).</summary>
    public DateTimeOffset OccurredAt { get; init; }
    public string? Channel { get; init; }
    public string? Provider { get; init; }
    /// <summary>Windows event id (not to be confused with the envelope's unique eventId).</summary>
    public int? WindowsEventId { get; init; }
    public long? RecordId { get; init; }
    public string? File { get; init; }
    public string? Message { get; init; }

    /// <summary>Identical messages within one collection cycle are merged.</summary>
    public int Occurrences { get; init; } = 1;

    [JsonIgnore]
    public EventPriority Priority { get; init; } = EventPriority.Normal;
}

/// <summary>
/// Entries plus the read positions to persist once the entries are safely queued,
/// so a crash between reading and queueing re-reads instead of losing events.
/// </summary>
public sealed record LogCollectionBatch(
    IReadOnlyList<LogEntry> Entries,
    IReadOnlyDictionary<string, string> Checkpoints)
{
    public static readonly LogCollectionBatch Empty = new([], new Dictionary<string, string>());
}
