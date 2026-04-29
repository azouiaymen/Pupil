namespace Pupil.Core;

// Enumerates visible desktop windows and collects cached UIA nodes from regions that are still visible on screen.
internal static class VisibleWindowsCollector
{
    /// <summary>
    /// Collect raw UIA nodes from top-most windows that still have meaningful visible area.
    /// </summary>
    /// <remarks>
    /// The collector approximates occlusion by subtracting already-kept front windows from
    /// each subsequent window before traversing its cached UIA subtree.
    /// </remarks>
    internal static (List<RawNode> raw, HashSet<string> windowTitles, int considered, int scanned) CollectRawVisibleWindows(
        int sw,
        int sh,
        nint excludeHwnd = 0,
        int maxWindows = PerceptionConstants.MaxWindows,
        double minVisibleRatio = PerceptionConstants.MinVisibleRatio)
    {
        // Build one cache request reused for every selected top-level window.
        var (automation, cacheRequest) = UiaCache.BuildCacheRequest();
        var hwnds = EnumerateVisibleWindowsZOrder(sw, sh, excludeHwnd);
        // Estimate what portion of each window is still visible after front windows occlude it.
        var selected = ComputeVisibleWindowRegions(hwnds, sw, sh, maxWindows, minVisibleRatio);

        var raw = new List<RawNode>();
        var titles = new HashSet<string>();
        var scanned = 0;

        foreach (var (hwnd, visibleRegions, _) in selected)
        {
            try
            {
                // Build cache-backed root so child traversal avoids uncached live UIA queries.
                var root = automation.ElementFromHandleBuildCache(hwnd, cacheRequest);
                scanned++;
                UiaCache.WalkCached(root, raw, visibleRegions);
                // Keep top-level titles to suppress duplicated non-text noise later in post-processing.
                var title = root.CachedName ?? string.Empty;
                if (!string.IsNullOrWhiteSpace(title))
                {
                    titles.Add(title);
                }
            }
            catch
            {
                // Ignore one failing window and continue.
            }
        }

        return (raw, titles, hwnds.Count, scanned);
    }

    /// <summary>
    /// Enumerate visible non-minimized top-level windows in front-to-back z-order.
    /// </summary>
    private static List<nint> EnumerateVisibleWindowsZOrder(int sw, int sh, nint excludeHwnd)
    {
        var windows = new List<nint>();
        NativeMethods.EnumWindows((hwnd, _) =>
        {
            // Explicitly skip caller-provided overlay/tool window to avoid self-capture.
            if (excludeHwnd != 0 && hwnd == excludeHwnd)
            {
                return true;
            }
            if (!NativeMethods.IsWindowVisible(hwnd))
            {
                return true;
            }
            if (NativeMethods.IsIconic(hwnd))
            {
                return true;
            }
            // Keep only windows with a non-empty intersection with the current screen.
            var rect = WindowRect(hwnd, sw, sh);
            if (rect is null || Geometry.RectArea(rect.Value) == 0)
            {
                return true;
            }

            windows.Add(hwnd);
            return true;
        }, 0);
        return windows;
    }

    /// <summary>
    /// Read and clip a window rectangle against current screen bounds.
    /// </summary>
    private static RectI? WindowRect(nint hwnd, int sw, int sh)
    {
        if (!NativeMethods.GetWindowRect(hwnd, out var rect))
        {
            return null;
        }

        return Geometry.RectIntersection(
            new RectI(rect.Left, rect.Top, rect.Right, rect.Bottom),
            new RectI(0, 0, sw, sh));
    }

    /// <summary>
    /// Estimate visible regions for each window after subtracting front-window occlusion.
    /// </summary>
    private static List<(nint hwnd, List<RectI> visibleRegions, RectI rect)> ComputeVisibleWindowRegions(
        List<nint> hwndsFrontToBack,
        int sw,
        int sh,
        int maxWindows,
        double minVisibleRatio)
    {
        // Accumulates already-kept front windows that can occlude windows behind them.
        var occluders = new List<RectI>();
        var kept = new List<(nint hwnd, List<RectI> visibleRegions, RectI rect)>();
        foreach (var hwnd in hwndsFrontToBack)
        {
            var rect = WindowRect(hwnd, sw, sh);
            if (rect is null)
            {
                continue;
            }
            // Subtract all known occluders to approximate the actually visible pieces of this window.
            var visibleRegions = Geometry.SubtractMany(rect.Value, occluders);
            var visibleArea = visibleRegions.Sum(Geometry.RectArea);
            var totalArea = Geometry.RectArea(rect.Value);
            if (totalArea <= 0)
            {
                continue;
            }
            // Use visible-ratio threshold to skip windows mostly hidden behind foreground layers.
            var ratio = (double)visibleArea / totalArea;
            if (visibleArea <= 0 || ratio < minVisibleRatio)
            {
                // Even skipped windows are added as occluders so deeper windows are not over-counted.
                occluders.Add(rect.Value);
                continue;
            }
            kept.Add((hwnd, visibleRegions, rect.Value));
            occluders.Add(rect.Value);
            if (kept.Count >= maxWindows)
            {
                break;
            }
        }
        return kept;
    }
}
