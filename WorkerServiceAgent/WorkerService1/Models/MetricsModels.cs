namespace PosMonitoringAgent.Models;

/// <summary>Body of a "metrics" event. Envelope fields (eventId, deviceId, ...) are added by the queue.</summary>
public sealed record MetricsPayload(
    SystemMetrics System,
    ApplicationHealth? Application,
    ConnectivityHealth? Connectivity);

public sealed record SystemMetrics
{
    public required string Os { get; init; }
    public string? OsEdition { get; init; }
    public string? OsBuild { get; init; }
    public double? CpuUsage { get; init; }
    public long TotalMemoryMB { get; init; }
    public long UsedMemoryMB { get; init; }
    public int MemoryLoadPercent { get; init; }
    public double? DiskFreeGB { get; init; }
    public long UptimeSeconds { get; init; }
    public IReadOnlyList<DiskMetrics> Disks { get; init; } = [];
    public NetworkMetrics? Network { get; init; }
}

public sealed record DiskMetrics(string Name, double TotalGB, double FreeGB, double FreePercent, bool IsSystemDrive);

public sealed record NetworkMetrics(
    bool IsAvailable,
    int ActiveInterfaces,
    long? BytesSentPerSec,
    long? BytesReceivedPerSec);

public sealed record MemoryMetrics(long TotalMB, long UsedMB, int LoadPercent);

public sealed record ApplicationHealth
{
    public required string Name { get; init; }
    public string? Version { get; init; }
    public bool ProcessRunning { get; init; }
    public int InstanceCount { get; init; }
    public int? ProcessId { get; init; }
    public long? UptimeSeconds { get; init; }
    public double? CpuUsage { get; init; }
    public long? WorkingSetMB { get; init; }
    public int? HandleCount { get; init; }
    public int? ThreadCount { get; init; }

    /// <summary>Only known when the agent can see the POS main window (not from session 0).</summary>
    public bool? Responding { get; init; }
}

public sealed record ConnectivityHealth
{
    public bool? LocalSqlConnected { get; init; }
    public long? SqlResponseTimeMs { get; init; }
    public int? SqlErrorCode { get; init; }
    public bool? CentralApiConnected { get; init; }
    public long? ApiResponseTimeMs { get; init; }

    /// <summary>Aggregate counts/timestamps only, never transaction contents.</summary>
    public IReadOnlyDictionary<string, object?>? TransactionHealth { get; init; }
    public DateTimeOffset CheckedAt { get; init; }
}

public sealed record SqlHealthResult(
    bool? Connected,
    long? ResponseTimeMs,
    int? ErrorCode,
    IReadOnlyDictionary<string, object?>? TransactionHealth);

public sealed record ApplicationStateChange(
    string Name,
    string PreviousState,
    string CurrentState,
    string Reason,
    int? ProcessId,
    string? Version);

public sealed record ConnectivityChange(
    string Target,
    bool Connected,
    int? ErrorCode,
    long? ResponseTimeMs);
