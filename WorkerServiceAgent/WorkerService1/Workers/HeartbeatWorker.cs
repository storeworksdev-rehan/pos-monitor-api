using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Workers;

/// <summary>
/// Every HeartbeatSeconds: "I am alive" plus queue backlog and upload health.
/// Only the newest heartbeat is kept while offline; older ones carry no extra information.
/// </summary>
public sealed class HeartbeatWorker(
    ILogger<HeartbeatWorker> logger,
    IOptions<AgentOptions> options,
    DeviceIdentityService identity,
    LocalQueueService queue,
    UploadStatus uploadStatus) : PeriodicWorker(logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(options.Value.Intervals.HeartbeatSeconds);

    protected override TimeSpan InitialDelay => TimeSpan.FromSeconds(2);

    protected override async Task RunOnceAsync(CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var stats = await queue.GetStatsAsync(ct);

        var heartbeat = new HeartbeatPayload
        {
            LastSeen = now,
            MachineName = identity.MachineName,
            InstallationId = identity.InstallationId,
            AgentStartedAt = identity.StartedAt,
            AgentUptimeSeconds = (long)(now - identity.StartedAt).TotalSeconds,
            PendingEvents = stats.PendingEvents,
            PendingCriticalEvents = stats.PendingCriticalEvents,
            PendingBytes = stats.PendingBytes,
            OldestPendingAgeSeconds = stats.OldestCreatedAt is { } oldest ? (long)(now - oldest).TotalSeconds : null,
            LastSuccessfulUploadAt = uploadStatus.LastSuccessAt,
            ConsecutiveUploadFailures = uploadStatus.ConsecutiveFailures,
        };

        await queue.EnqueueAsync(EventTypes.Heartbeat, heartbeat, EventPriority.High, ct, replacePending: true);
    }
}
