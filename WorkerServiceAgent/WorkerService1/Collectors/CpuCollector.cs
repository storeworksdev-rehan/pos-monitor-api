using System.Runtime.InteropServices;

namespace PosMonitoringAgent.Collectors;

/// <summary>
/// Total CPU usage from GetSystemTimes deltas. Needs no performance counters,
/// so it works even when the counter registry is corrupted (common on POS images).
/// </summary>
public sealed partial class CpuCollector
{
    private readonly object _gate = new();
    private (long Idle, long Kernel, long User)? _previous;

    /// <summary>Percent busy since the previous call. The first call samples over one second.</summary>
    public async Task<double?> SampleAsync(CancellationToken ct)
    {
        bool hasPrevious;
        lock (_gate)
        {
            hasPrevious = _previous.HasValue;
        }

        if (!hasPrevious)
        {
            if (Read() is not { } first)
            {
                return null;
            }

            lock (_gate)
            {
                _previous = first;
            }

            await Task.Delay(TimeSpan.FromSeconds(1), ct);
        }

        if (Read() is not { } current)
        {
            return null;
        }

        lock (_gate)
        {
            var prev = _previous!.Value;
            _previous = current;

            var idle = current.Idle - prev.Idle;
            var total = (current.Kernel - prev.Kernel) + (current.User - prev.User); // kernel time includes idle
            if (total <= 0)
            {
                return null;
            }

            return Math.Round(Math.Clamp((total - idle) * 100.0 / total, 0, 100), 1);
        }
    }

    private static (long Idle, long Kernel, long User)? Read() =>
        GetSystemTimes(out var idle, out var kernel, out var user) ? (idle, kernel, user) : null;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetSystemTimes(out long idleTime, out long kernelTime, out long userTime);
}
