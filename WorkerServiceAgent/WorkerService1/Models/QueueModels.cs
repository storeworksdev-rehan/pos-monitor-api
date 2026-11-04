namespace PosMonitoringAgent.Models;

public sealed record QueuedEvent(long Sequence, string EventId, string Json, int SizeBytes);

public sealed record QueueStats(
    long PendingEvents,
    long PendingCriticalEvents,
    long PendingBytes,
    DateTimeOffset? OldestCreatedAt);

public sealed record MaintenanceResult(
    int ExpiredRoutine,
    int ExpiredImportant,
    int PoisonDiscarded,
    int Downsampled,
    int DroppedForSize)
{
    public int Total => ExpiredRoutine + ExpiredImportant + PoisonDiscarded + Downsampled + DroppedForSize;
}

public enum UploadOutcome
{
    Success,
    TransientFailure,
    Rejected,
}

public sealed record UploadResult(
    UploadOutcome Outcome,
    IReadOnlyList<string> AcknowledgedEventIds,
    IReadOnlyList<string> RejectedEventIds,
    TimeSpan? RetryAfter = null,
    int? StatusCode = null,
    string? Error = null)
{
    public static UploadResult Transient(string error, int? status = null, TimeSpan? retryAfter = null) =>
        new(UploadOutcome.TransientFailure, [], [], retryAfter, status, error);

    public static UploadResult BatchRejected(int status, string? error) =>
        new(UploadOutcome.Rejected, [], [], null, status, error);
}

/// <summary>Response body the central API must return for a batch upload.</summary>
public sealed record BatchAcknowledgement(
    IReadOnlyList<string>? AcknowledgedEventIds,
    IReadOnlyList<string>? RejectedEventIds);
