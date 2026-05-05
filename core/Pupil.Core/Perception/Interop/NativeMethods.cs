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

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(nint hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern nint GetWindowLongPtr64(nint hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLayeredWindowAttributes(nint hWnd, out uint pcrKey, out byte pbAlpha, out uint pdwFlags);

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_LAYERED = 0x00080000;
    private const uint LWA_ALPHA = 0x00000002;

    /// <summary>
    /// Read a window long value, dispatching to the 32- or 64-bit variant based on pointer size.
    /// </summary>
    private static nint GetWindowLongPtrSafe(nint hWnd, int nIndex)
        => nint.Size == 8 ? GetWindowLongPtr64(hWnd, nIndex) : GetWindowLong32(hWnd, nIndex);

    /// <summary>
    /// Decide whether a top-level window should be considered visually transparent for occlusion purposes.
    /// </summary>
    /// <remarks>
    /// Windows that opt into per-pixel alpha via <c>UpdateLayeredWindow</c> make
    /// <c>GetLayeredWindowAttributes</c> fail; those are treated as transparent because typical
    /// recorder/capture overlays use that path and would otherwise blind UIA collection.
    /// </remarks>
    internal static bool IsWindowTransparent(nint hWnd, byte alphaThreshold = PerceptionConstants.LayeredAlphaTransparentThreshold)
    {
        var exStyle = (long)GetWindowLongPtrSafe(hWnd, GWL_EXSTYLE);
        if ((exStyle & WS_EX_LAYERED) == 0)
        {
            return false;
        }

        if (GetLayeredWindowAttributes(hWnd, out _, out var bAlpha, out var flags))
        {
            return (flags & LWA_ALPHA) != 0 && bAlpha < alphaThreshold;
        }

        // GetLayeredWindowAttributes fails for windows updated via UpdateLayeredWindow
        // (per-pixel alpha). Treat as transparent so screen-recorder overlays don't occlude
        // the desktop in our occlusion model.
        return true;
    }

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
