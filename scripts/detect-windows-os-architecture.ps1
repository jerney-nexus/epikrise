$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;

public static class NativeWindowsArchitecture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SystemInfo
    {
        public ushort ProcessorArchitecture;
        public ushort Reserved;
        public uint PageSize;
        public System.IntPtr MinimumApplicationAddress;
        public System.IntPtr MaximumApplicationAddress;
        public System.IntPtr ActiveProcessorMask;
        public uint NumberOfProcessors;
        public uint ProcessorType;
        public uint AllocationGranularity;
        public ushort ProcessorLevel;
        public ushort ProcessorRevision;
    }

    [DllImport("kernel32.dll", EntryPoint = "GetNativeSystemInfo")]
    private static extern void GetNativeSystemInfoNative(out SystemInfo systemInfo);

    public static SystemInfo GetNativeSystemInfo()
    {
        SystemInfo systemInfo;
        GetNativeSystemInfoNative(out systemInfo);
        return systemInfo;
    }
}
"@

$systemInfo = [NativeWindowsArchitecture]::GetNativeSystemInfo()
switch ($systemInfo.ProcessorArchitecture) {
    9 { Write-Output "X64" }
    12 { Write-Output "Arm64" }
    default {
        throw "Unsupported native Windows processor architecture: $($systemInfo.ProcessorArchitecture)."
    }
}
