using System.Runtime.InteropServices;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Collectors;

public sealed partial class MemoryCollector
{
    public MemoryMetrics? Collect()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        if (!GlobalMemoryStatusEx(ref status))
        {
            return null;
        }

        const ulong mb = 1024 * 1024;
        var total = (long)(status.TotalPhys / mb);
        var used = (long)((status.TotalPhys - status.AvailPhys) / mb);
        return new MemoryMetrics(total, used, (int)status.MemoryLoad);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);
}
