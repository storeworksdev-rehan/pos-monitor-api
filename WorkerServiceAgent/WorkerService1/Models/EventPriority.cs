namespace PosMonitoringAgent.Models;

/// <summary>Upload order and retention class. Higher values upload first and are kept longest.</summary>
public enum EventPriority
{
    Low = 0,
    Normal = 1,
    High = 2,
    Critical = 3,
}

public static class EventTypes
{
    public const string Metrics = "metrics";
    public const string Heartbeat = "heartbeat";
    public const string Log = "log";
    public const string ApplicationState = "application.state";
    public const string ConnectivityChange = "connectivity.change";
}
