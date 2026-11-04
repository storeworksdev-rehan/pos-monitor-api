using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Collectors;

/// <summary>
/// Health of the POS process: running, version, uptime and resource use.
/// Each configured name is matched against process names first, then against Windows service names,
/// so a POS that runs as a background service (including one hosted by nssm) is found too.
/// </summary>
public sealed partial class ProcessCollector(IOptions<PosApplicationOptions> options, ILogger<ProcessCollector> logger)
{
    private readonly PosApplicationOptions _options = options.Value;
    private readonly Dictionary<int, (TimeSpan Cpu, long Timestamp)> _cpuSamples = new();
    private readonly Dictionary<int, string?> _versionCache = new();

    public ApplicationHealth Collect()
    {
        var names = _options.ProcessNames
            .Select(n => Path.GetFileNameWithoutExtension(n.Trim()))
            .Where(n => n.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var processes = names.SelectMany(GetProcesses).ToList();
        if (processes.Count == 0)
        {
            processes = names.SelectMany(GetServiceProcesses).ToList();
        }

        try
        {
            if (processes.Count == 0)
            {
                _cpuSamples.Clear();
                _versionCache.Clear();
                return new ApplicationHealth
                {
                    Name = _options.Name,
                    Version = ReadFileVersion(_options.ExecutablePath),
                    ProcessRunning = false,
                    InstanceCount = 0,
                };
            }

            // Report the longest-running instance as the primary one.
            var primary = processes.OrderBy(p => TryGet(() => p.StartTime) ?? DateTime.MaxValue).First();
            var pid = primary.Id;
            var startTime = TryGet(() => primary.StartTime);
            var hasWindow = TryGet(() => primary.MainWindowHandle) is { } handle && handle != IntPtr.Zero;

            var livePids = processes.Select(p => p.Id).ToHashSet();
            foreach (var stale in _cpuSamples.Keys.Where(k => !livePids.Contains(k)).ToList())
            {
                _cpuSamples.Remove(stale);
                _versionCache.Remove(stale);
            }

            return new ApplicationHealth
            {
                Name = _options.Name,
                Version = GetVersion(primary),
                ProcessRunning = true,
                InstanceCount = processes.Count,
                ProcessId = pid,
                UptimeSeconds = startTime is { } st ? (long)(DateTime.Now - st).TotalSeconds : null,
                CpuUsage = SampleCpu(primary),
                WorkingSetMB = TryGet(() => primary.WorkingSet64 / (1024 * 1024)),
                HandleCount = TryGet(() => primary.HandleCount),
                ThreadCount = TryGet(() => primary.Threads.Count),
                Responding = hasWindow ? TryGet(() => primary.Responding) : null,
            };
        }
        finally
        {
            foreach (var p in processes)
            {
                p.Dispose();
            }
        }
    }

    private IEnumerable<Process> GetProcesses(string name)
    {
        try
        {
            return Process.GetProcessesByName(name);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            logger.LogDebug(ex, "Cannot enumerate processes named {Name}", name);
            return [];
        }
    }

    /// <summary>The process behind a running Windows service whose name or display name matches.</summary>
    private IEnumerable<Process> GetServiceProcesses(string name)
    {
        ServiceController[] services;
        try
        {
            services = ServiceController.GetServices();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            logger.LogDebug(ex, "Cannot enumerate Windows services");
            return [];
        }

        var result = new List<Process>();
        foreach (var service in services)
        {
            using (service)
            {
                if (!service.ServiceName.Equals(name, StringComparison.OrdinalIgnoreCase) &&
                    !service.DisplayName.Equals(name, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    if (service.Status == ServiceControllerStatus.Running && GetServiceProcessId(service.ServiceName) is { } pid)
                    {
                        result.Add(Process.GetProcessById(pid));
                    }
                }
                catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or ArgumentException)
                {
                    logger.LogDebug(ex, "Cannot read the status of service {Name}", service.ServiceName);
                }
            }
        }

        return result;
    }

    /// <summary>
    /// Process id of a running service. Opens it with query rights only: ServiceController.ServiceHandle
    /// asks for full access, which fails unless the agent runs as an administrator.
    /// </summary>
    private static int? GetServiceProcessId(string serviceName)
    {
        var manager = OpenSCManagerW(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var service = OpenServiceW(manager, serviceName, ServiceQueryStatus);
            if (service == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                return QueryServiceStatusEx(service, ScStatusProcessInfo, out var status, Marshal.SizeOf<ServiceStatusProcess>(), out _) &&
                       status.ProcessId != 0
                    ? (int)status.ProcessId
                    : null;
            }
            finally
            {
                CloseServiceHandle(service);
            }
        }
        finally
        {
            CloseServiceHandle(manager);
        }
    }

    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const int ScStatusProcessInfo = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        public uint ServiceType;
        public uint CurrentState;
        public uint ControlsAccepted;
        public uint Win32ExitCode;
        public uint ServiceSpecificExitCode;
        public uint CheckPoint;
        public uint WaitHint;
        public uint ProcessId;
        public uint ServiceFlags;
    }

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr OpenSCManagerW(string? machineName, string? databaseName, uint desiredAccess);

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr OpenServiceW(IntPtr manager, string serviceName, uint desiredAccess);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool QueryServiceStatusEx(
        IntPtr service, int infoLevel, out ServiceStatusProcess buffer, int bufferSize, out int bytesNeeded);

    [LibraryImport("advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseServiceHandle(IntPtr handle);

    private double? SampleCpu(Process process)
    {
        var cpu = TryGet(() => process.TotalProcessorTime);
        if (cpu is null)
        {
            return null;
        }

        var now = Stopwatch.GetTimestamp();
        double? usage = null;
        if (_cpuSamples.TryGetValue(process.Id, out var prev))
        {
            var wall = Stopwatch.GetElapsedTime(prev.Timestamp, now).TotalMilliseconds;
            if (wall > 0)
            {
                usage = Math.Round(
                    Math.Clamp((cpu.Value - prev.Cpu).TotalMilliseconds * 100 / (wall * Environment.ProcessorCount), 0, 100), 1);
            }
        }

        _cpuSamples[process.Id] = (cpu.Value, now);
        return usage;
    }

    private string? GetVersion(Process process)
    {
        if (_versionCache.TryGetValue(process.Id, out var cached))
        {
            return cached;
        }

        // MainModule fails when the agent and the POS differ in bitness; fall back to the configured path.
        var version = TryGetText(() => Normalize(process.MainModule?.FileVersionInfo)) ?? ReadFileVersion(_options.ExecutablePath);
        _versionCache[process.Id] = version;
        return version;
    }

    private static string? ReadFileVersion(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        var expanded = Environment.ExpandEnvironmentVariables(path);
        return File.Exists(expanded) ? TryGetText(() => Normalize(FileVersionInfo.GetVersionInfo(expanded))) : null;
    }

    private static string? Normalize(FileVersionInfo? info)
    {
        var v = info?.ProductVersion ?? info?.FileVersion;
        return string.IsNullOrWhiteSpace(v) ? null : v.Split('+')[0].Trim();
    }

    // Process properties throw if the process exits mid-read or access is denied; treat that as "unknown".
    private static T? TryGet<T>(Func<T> getter) where T : struct
    {
        try
        {
            return getter();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException)
        {
            return null;
        }
    }

    private static string? TryGetText(Func<string?> getter)
    {
        try
        {
            return getter();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException or FileNotFoundException)
        {
            return null;
        }
    }
}
