using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Workers;

/// <summary>
/// Drains the SQLite queue to the central API.
/// - Normally every UploadSeconds; immediately (rate-limited) when a critical event is queued.
/// - On failure, retries with exponential backoff and jitter, honouring Retry-After.
/// - Deletes events only after the server acknowledges them.
/// - Runs queue retention/size maintenance on its own schedule, even while offline.
/// </summary>
public sealed class TelemetryUploadWorker(
    ILogger<TelemetryUploadWorker> logger,
    IOptions<AgentOptions> agentOptions,
    IOptions<TelemetryApiOptions> apiOptions,
    IOptions<QueueOptions> queueOptions,
    LocalQueueService queue,
    TelemetryApiClient api,
    UploadTrigger trigger,
    UploadStatus status) : BackgroundService
{
    private const int MaxRequestsPerDrain = 50;
    private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromHours(1);

    private readonly TelemetryApiOptions _api = apiOptions.Value;
    private readonly TimeSpan _uploadInterval = TimeSpan.FromSeconds(Math.Max(5, agentOptions.Value.Intervals.UploadSeconds));
    private readonly TimeSpan _maintenanceInterval = TimeSpan.FromMinutes(Math.Max(1, queueOptions.Value.MaintenanceIntervalMinutes));
    private readonly TimeSpan _criticalFlushGap = TimeSpan.FromSeconds(Math.Max(1, apiOptions.Value.CriticalFlushMinIntervalSeconds));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!api.IsConfigured)
        {
            logger.LogWarning("TelemetryApi:BaseUrl is not configured; telemetry is kept in the local queue only");
        }

        var nextAttempt = DateTimeOffset.UtcNow.AddSeconds(5);
        var nextMaintenance = DateTimeOffset.UtcNow;
        var lastAttempt = DateTimeOffset.MinValue;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var wait = nextAttempt - DateTimeOffset.UtcNow;
                var triggered = await trigger.WaitAsync(wait, stoppingToken);

                var now = DateTimeOffset.UtcNow;
                if (now >= nextMaintenance)
                {
                    await queue.RunMaintenanceAsync(stoppingToken);
                    nextMaintenance = now + _maintenanceInterval;
                }

                if (triggered)
                {
                    // Critical event: go now, unless we are backing off or just uploaded (rate limit).
                    var earliest = lastAttempt + _criticalFlushGap;
                    if (status.ConsecutiveFailures > 0 || now < earliest)
                    {
                        nextAttempt = status.ConsecutiveFailures > 0 ? nextAttempt : Max(earliest, now);
                        if (nextAttempt > now)
                        {
                            continue;
                        }
                    }
                }
                else if (now < nextAttempt)
                {
                    continue;
                }

                if (!api.IsConfigured)
                {
                    nextAttempt = DateTimeOffset.UtcNow + _uploadInterval;
                    continue;
                }

                lastAttempt = DateTimeOffset.UtcNow;
                var result = await DrainAsync(stoppingToken);
                nextAttempt = DateTimeOffset.UtcNow + (result.Ok ? _uploadInterval : OnFailure(result));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Upload cycle failed");
                nextAttempt = DateTimeOffset.UtcNow + OnFailure(new DrainResult(false, null, ex.Message));
            }
        }
    }

    private async Task<DrainResult> DrainAsync(CancellationToken ct)
    {
        var batchSize = Math.Max(1, _api.MaxBatchEvents);
        var uploaded = 0;

        for (var request = 0; request < MaxRequestsPerDrain; request++)
        {
            var batch = await queue.PeekBatchAsync(batchSize, _api.MaxBatchBytes, ct);
            if (batch.Count == 0)
            {
                break;
            }

            var result = await api.SendBatchAsync(batch, ct);
            switch (result.Outcome)
            {
                case UploadOutcome.Success:
                    var handled = result.AcknowledgedEventIds.Concat(result.RejectedEventIds).ToList();
                    if (handled.Count == 0)
                    {
                        return new DrainResult(false, null, "Server acknowledged none of the events in the batch");
                    }

                    // Rows may already be gone (e.g. a heartbeat replaced mid-upload); that is fine.
                    await queue.RemoveAsync(handled, ct);
                    if (result.RejectedEventIds.Count > 0)
                    {
                        logger.LogWarning("Server permanently rejected {Count} event(s); they were removed", result.RejectedEventIds.Count);
                    }

                    uploaded += result.AcknowledgedEventIds.Count;
                    if (batch.Count < batchSize)
                    {
                        return Done(uploaded);
                    }

                    break;

                case UploadOutcome.Rejected when batch.Count > 1:
                    // Narrow down to the bad event instead of failing the whole batch repeatedly.
                    logger.LogWarning("Batch of {Count} rejected (HTTP {Status}): {Error}; retrying with smaller batches", batch.Count, result.StatusCode, result.Error);
                    batchSize = Math.Max(1, batch.Count / 2);
                    break;

                case UploadOutcome.Rejected:
                    logger.LogWarning("Event {EventId} rejected (HTTP {Status}): {Error}", batch[0].EventId, result.StatusCode, result.Error);
                    await queue.RecordRejectionAsync(batch.Select(e => e.Sequence), ct);
                    return new DrainResult(false, null, $"HTTP {result.StatusCode}");

                default:
                    return new DrainResult(false, result.RetryAfter, result.Error);
            }
        }

        return Done(uploaded);
    }

    private DrainResult Done(int uploaded)
    {
        if (status.ConsecutiveFailures > 0)
        {
            logger.LogInformation("Telemetry API reachable again; resumed uploading");
        }

        if (uploaded > 0)
        {
            logger.LogDebug("Uploaded {Count} event(s)", uploaded);
        }

        status.MarkSuccess();
        return new DrainResult(true, null, null);
    }

    private TimeSpan OnFailure(DrainResult result)
    {
        var failures = status.MarkFailure();

        // Exponential backoff with "equal jitter": half fixed, half random, capped.
        var cap = TimeSpan.FromSeconds(Math.Max(1, _api.BackoffMaxSeconds));
        var exp = TimeSpan.FromSeconds(Math.Min(cap.TotalSeconds, _api.BackoffBaseSeconds * Math.Pow(2, Math.Min(failures - 1, 20))));
        var delay = exp / 2 + TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * exp.TotalMilliseconds / 2);

        if (result.RetryAfter is { } retryAfter && retryAfter > delay)
        {
            delay = retryAfter < MaxRetryAfter ? retryAfter : MaxRetryAfter;
        }

        var level = failures == 1 || failures % 10 == 0 ? LogLevel.Warning : LogLevel.Debug;
        logger.Log(level, "Upload failed ({Failures} in a row): {Error}. Next attempt in {Delay:F0}s", failures, result.Error, delay.TotalSeconds);
        return delay;
    }

    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;

    private sealed record DrainResult(bool Ok, TimeSpan? RetryAfter, string? Error);
}
