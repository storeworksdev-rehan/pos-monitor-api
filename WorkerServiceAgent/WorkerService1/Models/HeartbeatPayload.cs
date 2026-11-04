namespace PosMonitoringAgent.Models;

public sealed record HeartbeatPayload
{
    public DateTimeOffset LastSeen { get; init; }
    public required string MachineName { get; init; }
    public required string InstallationId { get; init; }
    public DateTimeOffset AgentStartedAt { get; init; }
    public long AgentUptimeSeconds { get; init; }
    public long PendingEvents { get; init; }
    public long PendingCriticalEvents { get; init; }
    public long PendingBytes { get; init; }
    public long? OldestPendingAgeSeconds { get; init; }
    public DateTimeOffset? LastSuccessfulUploadAt { get; init; }
    public int ConsecutiveUploadFailures { get; init; }
}
