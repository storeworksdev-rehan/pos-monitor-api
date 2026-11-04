using System.Threading.Channels;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Services;

/// <summary>Latest application and connectivity results, shared between workers.</summary>
public sealed class HealthSnapshotStore
{
    private readonly object _gate = new();
    private ApplicationHealth? _application;
    private DateTimeOffset _applicationAt;
    private ConnectivityHealth? _connectivity;

    public void UpdateApplication(ApplicationHealth health)
    {
        lock (_gate)
        {
            _application = health;
            _applicationAt = DateTimeOffset.UtcNow;
        }
    }

    public void UpdateConnectivity(ConnectivityHealth health)
    {
        lock (_gate)
        {
            _connectivity = health;
        }
    }

    /// <summary>Returns snapshots no older than <paramref name="maxAge"/>; stale ones come back null.</summary>
    public (ApplicationHealth? Application, ConnectivityHealth? Connectivity) GetLatest(TimeSpan maxAge)
    {
        var cutoff = DateTimeOffset.UtcNow - maxAge;
        lock (_gate)
        {
            return (
                _applicationAt >= cutoff ? _application : null,
                _connectivity is not null && _connectivity.CheckedAt >= cutoff ? _connectivity : null);
        }
    }
}

/// <summary>Upload health, reported in heartbeats.</summary>
public sealed class UploadStatus
{
    private readonly object _gate = new();

    public DateTimeOffset? LastSuccessAt { get; private set; }
    public int ConsecutiveFailures { get; private set; }

    public void MarkSuccess()
    {
        lock (_gate)
        {
            LastSuccessAt = DateTimeOffset.UtcNow;
            ConsecutiveFailures = 0;
        }
    }

    public int MarkFailure()
    {
        lock (_gate)
        {
            return ++ConsecutiveFailures;
        }
    }
}

/// <summary>Lets producers of critical events wake the upload worker immediately.</summary>
public sealed class UploadTrigger
{
    private readonly Channel<bool> _signal = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite });

    public void Request() => _signal.Writer.TryWrite(true);

    /// <summary>Waits up to <paramref name="timeout"/>. Returns true if woken by <see cref="Request"/>.</summary>
    public async Task<bool> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (timeout <= TimeSpan.Zero)
        {
            return _signal.Reader.TryRead(out _);
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            await _signal.Reader.ReadAsync(cts.Token);
            return true;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return false;
        }
    }
}
