using System.Runtime.InteropServices;

namespace Pupil.Core;

// Minimal Win32 interop surface used for screen and top-level window enumeration.
internal static class NativeMethods
{
    /// <summary>
    /// Callback signature used by EnumWindows for top-level window enumeration.
    /// </summary>
    internal delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll")]
    internal static extern bool IsIconic(nint hWnd);

    [DllImport("user32.dll")]
    internal static extern bool EnumWindows(EnumWindowsProc callback, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool GetWindowRect(nint hWnd, out RECT rect);

    /// <summary>
    /// Get primary screen width/height through Win32 system metrics.
    /// </summary>
    // SM_CXSCREEN (0), SM_CYSCREEN (1).
    internal static (int sw, int sh) ScreenSize() => (GetSystemMetrics(0), GetSystemMetrics(1));

    /// <summary>
    /// Get the virtual desktop rectangle that spans every monitor.
    /// </summary>
    /// <remarks>
    /// UIA bounding rectangles, <c>GetWindowRect</c>, and <c>SetCursorPos</c> all live in
    /// virtual-screen space, so clipping and occlusion math must use the same origin
    /// instead of the primary monitor's (0,0)-anchored size from <see cref="ScreenSize"/>.
    /// </remarks>
    // SM_XVIRTUALSCREEN (76), SM_YVIRTUALSCREEN (77), SM_CXVIRTUALSCREEN (78), SM_CYVIRTUALSCREEN (79).
    internal static (int x, int y, int w, int h) VirtualScreenBounds()
        => (GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
}
