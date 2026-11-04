using System.Diagnostics;
using System.Net.NetworkInformation;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Collectors;

/// <summary>Link state and throughput across active, non-loopback interfaces.</summary>
public sealed class NetworkCollector(ILogger<NetworkCollector> logger)
{
    private readonly object _gate = new();
    private (long Sent, long Received, long Timestamp)? _previous;

    public NetworkMetrics Collect()
    {
        long sent = 0, received = 0;
        var active = 0;
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up ||
                nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
            {
                continue;
            }

            try
            {
                var stats = nic.GetIPStatistics();
                sent += stats.BytesSent;
                received += stats.BytesReceived;
                active++;
            }
            catch (NetworkInformationException ex)
            {
                logger.LogDebug(ex, "Cannot read statistics for {Interface}", nic.Name);
            }
        }

        var now = Stopwatch.GetTimestamp();
        long? sentRate = null, receivedRate = null;
        lock (_gate)
        {
            if (_previous is { } prev)
            {
                var seconds = Stopwatch.GetElapsedTime(prev.Timestamp, now).TotalSeconds;
                // Counters reset when interfaces change; skip the sample rather than report garbage.
                if (seconds > 0 && sent >= prev.Sent && received >= prev.Received)
                {
                    sentRate = (long)((sent - prev.Sent) / seconds);
                    receivedRate = (long)((received - prev.Received) / seconds);
                }
            }

            _previous = (sent, received, now);
        }

        return new NetworkMetrics(NetworkInterface.GetIsNetworkAvailable(), active, sentRate, receivedRate);
    }
}
