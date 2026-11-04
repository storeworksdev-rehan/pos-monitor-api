using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Collectors;

public sealed class DiskCollector(ILogger<DiskCollector> logger)
{
    private static readonly string SystemRoot = Path.GetPathRoot(Environment.SystemDirectory) ?? @"C:\";

    public IReadOnlyList<DiskMetrics> Collect()
    {
        const double gb = 1024d * 1024 * 1024;
        var disks = new List<DiskMetrics>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (drive.DriveType != DriveType.Fixed || !drive.IsReady || drive.TotalSize == 0)
                {
                    continue;
                }

                disks.Add(new DiskMetrics(
                    drive.Name,
                    Math.Round(drive.TotalSize / gb, 1),
                    Math.Round(drive.AvailableFreeSpace / gb, 1),
                    Math.Round(drive.AvailableFreeSpace * 100d / drive.TotalSize, 1),
                    string.Equals(drive.Name, SystemRoot, StringComparison.OrdinalIgnoreCase)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.LogDebug(ex, "Skipping drive {Drive}", drive.Name);
            }
        }

        return disks;
    }
}
