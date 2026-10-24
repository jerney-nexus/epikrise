$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;

public static class NativeWindowsArchitecture
{
    [DllImport("kernel32.dll")]
    private static extern System.IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWow64Process2(
        System.IntPtr process,
        out ushort processMachine,
        out ushort nativeMachine);

    public static ushort GetNativeMachine()
    {
        ushort processMachine;
        ushort nativeMachine;
        if (!IsWow64Process2(
            GetCurrentProcess(),
            out processMachine,
            out nativeMachine))
        {
            throw new System.ComponentModel.Win32Exception(
                Marshal.GetLastWin32Error());
        }

        return nativeMachine == 0 ? processMachine : nativeMachine;
    }
}
"@

$nativeMachine = [NativeWindowsArchitecture]::GetNativeMachine()
switch ($nativeMachine) {
    0x8664 { Write-Output "X64" }
    0xAA64 { Write-Output "Arm64" }
    default {
        throw "Unsupported native Windows machine type: 0x$($nativeMachine.ToString('X4'))."
    }
}
