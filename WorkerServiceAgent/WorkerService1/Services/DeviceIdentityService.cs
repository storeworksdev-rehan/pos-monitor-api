using System.Reflection;
using Microsoft.Extensions.Options;
using Microsoft.Win32;
using PosMonitoringAgent.Configuration;

namespace PosMonitoringAgent.Services;

/// <summary>Stable identity of this machine and agent, resolved once at startup.</summary>
public sealed class DeviceIdentityService
{
    public DeviceIdentityService(IOptions<AgentOptions> options, ILogger<DeviceIdentityService> logger)
    {
        var o = options.Value;
        StoreId = o.StoreId.Trim();
        DeviceId = string.IsNullOrWhiteSpace(o.DeviceId)
            ? $"POS-{StoreId}-{Environment.MachineName}".ToUpperInvariant()
            : o.DeviceId.Trim();
        MachineName = Environment.MachineName;
        StartedAt = DateTimeOffset.UtcNow;
        AgentVersion = ResolveAgentVersion();

        DataDirectory = ResolveDataDirectory(o.DataDirectory);
        Directory.CreateDirectory(DataDirectory);
        EnsureWritable(DataDirectory);
        InstallationId = LoadOrCreateInstallationId(DataDirectory);

        (OsName, OsEdition, OsBuild) = ResolveOs();

        logger.LogInformation(
            "Agent {Version} starting as device {DeviceId} (store {StoreId}, installation {InstallationId}); data in {DataDirectory}",
            AgentVersion, DeviceId, StoreId, InstallationId, DataDirectory);
    }

    public string DeviceId { get; }
    public string StoreId { get; }
    public string MachineName { get; }
    public string InstallationId { get; }
    public string AgentVersion { get; }
    public string DataDirectory { get; }
    public string OsName { get; }
    public string? OsEdition { get; }
    public string? OsBuild { get; }
    public DateTimeOffset StartedAt { get; }

    private static string ResolveAgentVersion()
    {
        var info = typeof(DeviceIdentityService).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        return string.IsNullOrEmpty(info) ? "0.0.0" : info.Split('+')[0];
    }

    /// <summary>
    /// Stops startup with a clear message when the queue cannot be written, instead of every worker
    /// failing with "attempt to write a readonly database". This happens when files created by the
    /// service (LocalSystem) or an elevated run are opened by a normal user.
    /// </summary>
    private static void EnsureWritable(string dataDirectory)
    {
        foreach (var name in new[] { "telemetry-queue.db", "telemetry-queue.db-wal", "telemetry-queue.db-shm", "installation-id" })
        {
            var file = Path.Combine(dataDirectory, name);
            if (!File.Exists(file))
            {
                continue;
            }

            try
            {
                using var _ = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
            }
            catch (UnauthorizedAccessException)
            {
                throw new InvalidOperationException(
                    $@"'{file}' is not writable by {Environment.UserDomainName}\{Environment.UserName}. " +
                    @"Run the agent as the Windows service (Installer\install.ps1), from an elevated prompt, " +
                    "or point Agent:DataDirectory at a folder this account can write.");
            }
        }
    }

    private static string ResolveDataDirectory(string configured)
    {
        var expanded = Environment.ExpandEnvironmentVariables(configured);
        return Path.GetFullPath(Path.IsPathRooted(expanded)
            ? expanded
            : Path.Combine(AppContext.BaseDirectory, expanded));
    }

    private static string LoadOrCreateInstallationId(string dataDirectory)
    {
        var path = Path.Combine(dataDirectory, "installation-id");
        if (File.Exists(path) && Guid.TryParse(File.ReadAllText(path).Trim(), out var existing))
        {
            return existing.ToString();
        }

        var id = Guid.NewGuid().ToString();
        File.WriteAllText(path, id);
        return id;
    }

    private static (string Name, string? Edition, string? Build) ResolveOs()
    {
        var v = Environment.OSVersion.Version;
        var name = v.Major == 10 ? (v.Build >= 22000 ? "Windows 11" : "Windows 10") : $"Windows {v.Major}.{v.Minor}";
        string? edition = null;
        var build = $"{v.Major}.{v.Minor}.{v.Build}";
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            edition = key?.GetValue("EditionID") as string;
            if (key?.GetValue("UBR") is int ubr)
            {
                build = $"{build}.{ubr}";
            }
        }
        catch (Exception)
        {
            // Registry details are optional.
        }

        return (name, edition, build);
    }
}
