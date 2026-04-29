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
            var (sw, sh) = NativeMethods.ScreenSize();
            // Collect raw nodes from top-most visible windows, excluding caller window if provided.
            var (raw, winTitles, _, _) = VisibleWindowsCollector.CollectRawVisibleWindows(sw, sh, excludeHwnd);
            // Reduce duplicates, merge adjacent text fragments, and remove likely noise.
            var results = PostProcess.Nms(raw);
            results = PostProcess.MergeTextNodes(results);
            results = PostProcess.FilterNoise(results, winTitles);
            // Keep only meaningful terminal nodes for downstream consumers.
            var root = PostProcess.BuildContainmentTree(results, sw, sh);
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
