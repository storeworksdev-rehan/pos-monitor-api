namespace PosMonitoringAgent.Configuration;

/// <summary>Identity and scheduling settings for the agent. Section: "Agent".</summary>
public sealed class AgentOptions
{
    public const string SectionName = "Agent";

    /// <summary>Store identifier, e.g. STORE001. Required.</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>Optional explicit device id. Defaults to POS-{StoreId}-{MachineName}.</summary>
    public string? DeviceId { get; set; }

    /// <summary>Folder for the SQLite queue and installation id. Relative paths resolve against the exe folder.</summary>
    public string DataDirectory { get; set; } = @"%ProgramData%\PosMonitoringAgent";

    public IntervalOptions Intervals { get; set; } = new();
}

public sealed class IntervalOptions
{
    public int SystemMetricsSeconds { get; set; } = 60;
    public int ApplicationHealthSeconds { get; set; } = 30;
    public int ConnectivitySeconds { get; set; } = 60;
    public int HeartbeatSeconds { get; set; } = 60;
    public int LogCollectionSeconds { get; set; } = 120;
    public int UploadSeconds { get; set; } = 30;
}

/// <summary>Central telemetry API. Section: "TelemetryApi".</summary>
public sealed class TelemetryApiOptions
{
    public const string SectionName = "TelemetryApi";

    /// <summary>Base URL of the central API. Empty means "queue locally only".</summary>
    public string? BaseUrl { get; set; }
    public string? ApiKey { get; set; }
    public string BatchPath { get; set; } = "api/telemetry/batch";
    public string HealthPath { get; set; } = "api/health";
    public int TimeoutSeconds { get; set; } = 30;
    public int MaxBatchEvents { get; set; } = 200;
    public int MaxBatchBytes { get; set; } = 512 * 1024;
    public bool EnableGzip { get; set; }
    public int BackoffBaseSeconds { get; set; } = 5;
    public int BackoffMaxSeconds { get; set; } = 300;

    /// <summary>Minimum gap between immediate uploads triggered by critical events (rate limit).</summary>
    public int CriticalFlushMinIntervalSeconds { get; set; } = 15;
}

/// <summary>SQLite offline queue limits. Section: "LocalQueue".</summary>
public sealed class QueueOptions
{
    public const string SectionName = "LocalQueue";

    /// <summary>Hard cap on the queue database size. Lowest-priority, oldest events are dropped first.</summary>
    public int MaxDatabaseSizeMB { get; set; } = 200;

    /// <summary>Low/Normal events (metrics, routine logs) older than this are deleted.</summary>
    public int RoutineRetentionHours { get; set; } = 72;

    /// <summary>High/Critical events older than this are deleted.</summary>
    public int CriticalRetentionDays { get; set; } = 14;

    /// <summary>Metrics older than this are thinned to one sample per bucket.</summary>
    public int DownsampleMetricsAfterHours { get; set; } = 6;
    public int DownsampleBucketMinutes { get; set; } = 15;

    /// <summary>Events the server explicitly rejected this many times are discarded.</summary>
    public int MaxDeliveryAttempts { get; set; } = 5;

    public int MaintenanceIntervalMinutes { get; set; } = 10;
}

/// <summary>The monitored POS application. Section: "PosApplication".</summary>
public sealed class PosApplicationOptions
{
    public const string SectionName = "PosApplication";

    public string Name { get; set; } = "POS";

    /// <summary>Process names without ".exe".</summary>
    public string[] ProcessNames { get; set; } = [];

    /// <summary>Optional path to the POS exe, used to read the version when the process is not running.</summary>
    public string? ExecutablePath { get; set; }

    public string? LogDirectory { get; set; }
    public string LogFilePattern { get; set; } = "*.log";

    /// <summary>Case-insensitive regex patterns; a log line is collected only if one matches.</summary>
    public string[] LogErrorPatterns { get; set; } = [];

    public int MaxLogEntriesPerCycle { get; set; } = 100;
    public int MaxBytesPerFilePerCycle { get; set; } = 1024 * 1024;
    public int MaxMessageLength { get; set; } = 2000;
}

/// <summary>Local SQL Server connectivity check. Section: "SqlHealth".</summary>
public sealed class SqlHealthOptions
{
    public const string SectionName = "SqlHealth";

    public bool Enabled { get; set; } = true;
    public string? ConnectionString { get; set; }
    public int ConnectTimeoutSeconds { get; set; } = 5;

    /// <summary>
    /// Optional aggregate-only query for transaction health, e.g. counts and last timestamp.
    /// Only numeric, boolean and date columns of the first row are reported; text columns are ignored.
    /// </summary>
    public string? TransactionHealthQuery { get; set; }
    public int QueryTimeoutSeconds { get; set; } = 10;
}

/// <summary>Windows Event Log collection. Section: "EventLog".</summary>
public sealed class EventLogOptions
{
    public const string SectionName = "EventLog";

    public string[] Channels { get; set; } = [];

    /// <summary>1 = Critical only, 2 = + Error, 3 = + Warning.</summary>
    public int MaxLevel { get; set; } = 2;

    /// <summary>If non-empty, only these providers are collected.</summary>
    public string[] ProviderAllowList { get; set; } = [];
    public string[] ProviderDenyList { get; set; } = [];

    /// <summary>Event ids treated as critical when they mention a POS process (e.g. 1000 crash, 1002 hang, 1026 .NET crash).</summary>
    public int[] CriticalEventIds { get; set; } = [];

    /// <summary>On first run, how far back to read.</summary>
    public int InitialLookbackMinutes { get; set; } = 60;
    public int MaxEventsPerCycle { get; set; } = 100;
    public int MaxMessageLength { get; set; } = 2000;
}
