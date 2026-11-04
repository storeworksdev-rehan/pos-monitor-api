using Microsoft.Extensions.Options;
using PosMonitoringAgent.Collectors;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Workers;

/// <summary>
/// Watches the POS process every ApplicationHealthSeconds and checks SQL / central API
/// connectivity every ConnectivitySeconds. Results feed the metrics event; state changes
/// (POS crashed, restarted, SQL lost) are queued as their own events, crashes as critical.
/// </summary>
public sealed class ApplicationHealthWorker(
    ILogger<ApplicationHealthWorker> logger,
    IOptions<AgentOptions> options,
    ProcessCollector processes,
    SqlHealthCollector sql,
    TelemetryApiClient api,
    HealthSnapshotStore snapshots,
    LocalQueueService queue,
    UploadTrigger uploadTrigger) : PeriodicWorker(logger)
{
    private readonly IntervalOptions _intervals = options.Value.Intervals;
    private ApplicationHealth? _lastApp;
    private bool? _lastSqlConnected;
    private DateTimeOffset _lastConnectivityCheck = DateTimeOffset.MinValue;

    protected override TimeSpan Interval => TimeSpan.FromSeconds(_intervals.ApplicationHealthSeconds);

    protected override async Task RunOnceAsync(CancellationToken ct)
    {
        var app = processes.Collect();
        snapshots.UpdateApplication(app);
        await DetectApplicationChangeAsync(app, ct);
        _lastApp = app;

        if (DateTimeOffset.UtcNow - _lastConnectivityCheck >= TimeSpan.FromSeconds(_intervals.ConnectivitySeconds))
        {
            await CheckConnectivityAsync(ct);
        }
    }

    private async Task DetectApplicationChangeAsync(ApplicationHealth current, CancellationToken ct)
    {
        ApplicationStateChange? change = null;
        var priority = EventPriority.High;

        if (_lastApp is null)
        {
            if (!current.ProcessRunning)
            {
                change = new(current.Name, "unknown", "stopped", "POS not running when the agent started", null, current.Version);
            }
        }
        else if (_lastApp.ProcessRunning && !current.ProcessRunning)
        {
            change = new(current.Name, "running", "stopped", "POS process exited", _lastApp.ProcessId, _lastApp.Version);
            priority = EventPriority.Critical;
        }
        else if (!_lastApp.ProcessRunning && current.ProcessRunning)
        {
            change = new(current.Name, "stopped", "running", "POS process started", current.ProcessId, current.Version);
        }
        else if (_lastApp.ProcessRunning && current.ProcessRunning && _lastApp.ProcessId != current.ProcessId)
        {
            change = new(current.Name, "running", "running", $"POS restarted (pid {_lastApp.ProcessId} -> {current.ProcessId})", current.ProcessId, current.Version);
        }
        else if (_lastApp.Responding == true && current.Responding == false)
        {
            change = new(current.Name, "running", "not-responding", "POS window stopped responding", current.ProcessId, current.Version);
            priority = EventPriority.Critical;
        }

        if (change is null)
        {
            return;
        }

        Logger.LogWarning("POS state change: {Reason}", change.Reason);
        await queue.EnqueueAsync(EventTypes.ApplicationState, change, priority, ct);
        if (priority == EventPriority.Critical)
        {
            uploadTrigger.Request();
        }
    }

    private async Task CheckConnectivityAsync(CancellationToken ct)
    {
        var sqlTask = sql.CheckAsync(ct);
        var apiTask = api.IsConfigured ? api.PingAsync(ct) : Task.FromResult<(bool, long?)>((false, null));
        await Task.WhenAll(sqlTask, apiTask);

        var sqlResult = await sqlTask;
        var (apiConnected, apiMs) = await apiTask;
        _lastConnectivityCheck = DateTimeOffset.UtcNow;

        snapshots.UpdateConnectivity(new ConnectivityHealth
        {
            LocalSqlConnected = sqlResult.Connected,
            SqlResponseTimeMs = sqlResult.ResponseTimeMs,
            SqlErrorCode = sqlResult.ErrorCode,
            CentralApiConnected = api.IsConfigured ? apiConnected : null,
            ApiResponseTimeMs = apiMs,
            TransactionHealth = sqlResult.TransactionHealth,
            CheckedAt = _lastConnectivityCheck,
        });

        if (sqlResult.Connected is { } connected && _lastSqlConnected is { } previous && connected != previous)
        {
            Logger.LogWarning("Local SQL connectivity changed: connected={Connected} error={Error}", connected, sqlResult.ErrorCode);
            await queue.EnqueueAsync(
                EventTypes.ConnectivityChange,
                new ConnectivityChange("local-sql", connected, sqlResult.ErrorCode, sqlResult.ResponseTimeMs),
                connected ? EventPriority.Normal : EventPriority.High,
                ct);
        }

        _lastSqlConnected = sqlResult.Connected ?? _lastSqlConnected;
    }
}
