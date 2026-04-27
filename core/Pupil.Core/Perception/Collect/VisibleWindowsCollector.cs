namespace Pupil.Core;

internal static class VisibleWindowsCollector
{
    internal static (List<RawNode> raw, HashSet<string> windowTitles, int considered, int scanned) CollectRawVisibleWindows(
        int sw,
        int sh,
        nint excludeHwnd = 0,
        int maxWindows = 6,
        double minVisibleRatio = 0.02)
    {
        var (automation, cacheRequest) = UiaCache.BuildCacheRequest();
        var hwnds = EnumerateVisibleWindowsZOrder(sw, sh, excludeHwnd);
        var selected = ComputeVisibleWindowRegions(hwnds, sw, sh, maxWindows, minVisibleRatio);

        var raw = new List<RawNode>();
        var titles = new HashSet<string>();
        var scanned = 0;

        foreach (var (hwnd, visibleRegions, _) in selected)
        {
            try
            {
                var root = automation.ElementFromHandleBuildCache(hwnd, cacheRequest);
                scanned++;
                UiaCache.WalkCached(root, raw, visibleRegions);
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

    private static List<nint> EnumerateVisibleWindowsZOrder(int sw, int sh, nint excludeHwnd)
    {
        var windows = new List<nint>();
        NativeMethods.EnumWindows((hwnd, _) =>
        {
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

    private static List<(nint hwnd, List<RectI> visibleRegions, RectI rect)> ComputeVisibleWindowRegions(
        List<nint> hwndsFrontToBack,
        int sw,
        int sh,
        int maxWindows,
        double minVisibleRatio)
    {
        var occluders = new List<RectI>();
        var kept = new List<(nint hwnd, List<RectI> visibleRegions, RectI rect)>();
        foreach (var hwnd in hwndsFrontToBack)
        {
            var rect = WindowRect(hwnd, sw, sh);
            if (rect is null)
            {
                continue;
            }
            var visibleRegions = Geometry.SubtractMany(rect.Value, occluders);
            var visibleArea = visibleRegions.Sum(Geometry.RectArea);
            var totalArea = Geometry.RectArea(rect.Value);
            if (totalArea <= 0)
            {
                continue;
            }
            var ratio = (double)visibleArea / totalArea;
            if (visibleArea <= 0 || ratio < minVisibleRatio)
            {
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
