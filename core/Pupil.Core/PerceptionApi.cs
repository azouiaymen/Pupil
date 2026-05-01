using System.Runtime.Versioning;

namespace Pupil.Core;

[SupportedOSPlatform("windows")]
public static class PerceptionApi
{
    /// <summary>
    /// Capture currently visible UI nodes and return them as a JSON array.
    /// </summary>
    /// <param name="excludeHwnd">
    /// Optional window handle to exclude from collection (typically the overlay window).
    /// </param>
    /// <returns>
    /// A compact JSON payload containing normalized output nodes, or <c>[]</c> on failure.
    /// </returns>
    // Main DLL entrypoint: capture visible UI elements and return a compact JSON payload.
    public static string Perceive(int excludeHwnd = 0)
    {
        try
        {
            // Use the full virtual desktop so multi-monitor layouts (and monitors with
            // negative origins) are clipped against the same coordinate space UIA emits.
            var (vx, vy, vw, vh) = NativeMethods.VirtualScreenBounds();
            var virtualScreen = new RectI(vx, vy, vx + vw, vy + vh);
            // Collect raw nodes from top-most visible windows, excluding caller window if provided.
            var (raw, winTitles, _, _) = VisibleWindowsCollector.CollectRawVisibleWindows(virtualScreen, excludeHwnd);
            // Reduce duplicates, merge adjacent text fragments, and remove likely noise.
            var results = PostProcess.Nms(raw);
            results = PostProcess.MergeTextNodes(results);
            results = PostProcess.FilterNoise(results, winTitles);
            // Keep only meaningful terminal nodes for downstream consumers.
            var root = PostProcess.BuildContainmentTree(results, virtualScreen);
            var leaves = PostProcess.ExtractLeaves(root);
            var clean = leaves.Select(el => new OutputNode(el.Type, el.Name, el.Rect)).ToList();
            return JsonOutput.Serialize(clean);
        }
        catch (Exception e)
        {
            // API contract: never throw across interop boundary, return empty JSON payload instead.
            Console.WriteLine($"Perceive error: {e.Message}");
            return "[]";
        }
    }
}
