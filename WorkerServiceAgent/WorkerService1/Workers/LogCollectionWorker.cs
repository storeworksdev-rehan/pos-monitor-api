using Microsoft.Extensions.Options;
using PosMonitoringAgent.Collectors;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Workers;

/// <summary>
/// Every LogCollectionSeconds: filtered Windows events and POS log errors.
/// Read positions are saved only after the entries are in the queue.
/// Critical entries wake the upload worker immediately.
/// </summary>
public sealed class LogCollectionWorker(
    ILogger<LogCollectionWorker> logger,
    IOptions<AgentOptions> options,
    WindowsEventCollector windowsEvents,
    PosLogFileCollector posLogs,
    LocalQueueService queue,
    UploadTrigger uploadTrigger) : PeriodicWorker(logger)
{
    protected override TimeSpan Interval => TimeSpan.FromSeconds(options.Value.Intervals.LogCollectionSeconds);

    protected override async Task RunOnceAsync(CancellationToken ct)
    {
        var critical = false;
        var total = 0;

        foreach (var collect in new Func<CancellationToken, Task<LogCollectionBatch>>[] { windowsEvents.CollectAsync, posLogs.CollectAsync })
        {
            LogCollectionBatch batch;
            try
            {
                batch = await collect(ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Logger.LogError(ex, "Log collector failed");
                continue;
            }

            foreach (var entry in batch.Entries)
            {
                await queue.EnqueueAsync(EventTypes.Log, entry, entry.Priority, ct);
                critical |= entry.Priority == EventPriority.Critical;
            }

            await queue.SetStatesAsync(batch.Checkpoints, ct);
            total += batch.Entries.Count;
        }

        if (total > 0)
        {
            Logger.LogInformation("Queued {Count} log entr(ies){Critical}", total, critical ? " including critical" : string.Empty);
        }

        if (critical)
        {
            uploadTrigger.Request();
        }
    }
}
