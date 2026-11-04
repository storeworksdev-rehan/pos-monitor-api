using Microsoft.Extensions.Options;
using PosMonitoringAgent.Collectors;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Workers;

/// <summary>
/// Every SystemMetricsSeconds: CPU, memory, disk and network, combined with the latest
/// application and connectivity snapshot into one "metrics" event.
/// </summary>
public sealed class SystemMetricsWorker(
    ILogger<SystemMetricsWorker> logger,
    IOptions<AgentOptions> options,
    CpuCollector cpu,
    MemoryCollector memory,
    DiskCollector disk,
    NetworkCollector network,
    DeviceIdentityService identity,
    HealthSnapshotStore snapshots,
    LocalQueueService queue) : PeriodicWorker(logger)
{
    private readonly IntervalOptions _intervals = options.Value.Intervals;

    protected override TimeSpan Interval => TimeSpan.FromSeconds(_intervals.SystemMetricsSeconds);

    protected override async Task RunOnceAsync(CancellationToken ct)
    {
        var cpuUsage = await cpu.SampleAsync(ct);
        var mem = memory.Collect();
        var disks = disk.Collect();

        var system = new SystemMetrics
        {
            Os = identity.OsName,
            OsEdition = identity.OsEdition,
            OsBuild = identity.OsBuild,
            CpuUsage = cpuUsage,
            TotalMemoryMB = mem?.TotalMB ?? 0,
            UsedMemoryMB = mem?.UsedMB ?? 0,
            MemoryLoadPercent = mem?.LoadPercent ?? 0,
            DiskFreeGB = disks.FirstOrDefault(d => d.IsSystemDrive)?.FreeGB,
            UptimeSeconds = Environment.TickCount64 / 1000,
            Disks = disks,
            Network = network.Collect(),
        };

        // Do not report application/connectivity data that is more than a few cycles old.
        var maxAge = TimeSpan.FromSeconds(3 * Math.Max(_intervals.ApplicationHealthSeconds, _intervals.ConnectivitySeconds));
        var (application, connectivity) = snapshots.GetLatest(maxAge);

        var seq = await queue.EnqueueAsync(EventTypes.Metrics, new MetricsPayload(system, application, connectivity), EventPriority.Normal, ct);
        Logger.LogDebug("Queued metrics #{Sequence}: cpu={Cpu}% mem={Used}/{Total}MB", seq, cpuUsage, system.UsedMemoryMB, system.TotalMemoryMB);
    }
}
