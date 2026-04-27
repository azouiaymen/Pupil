using System.Runtime.Versioning;

namespace Pupil.Core;

[SupportedOSPlatform("windows")]
public static class PerceptionApi
{
    public static string Perceive(int excludeHwnd = 0)
    {
        try
        {
            var (sw, sh) = NativeMethods.ScreenSize();
            var (raw, winTitles, _, _) = VisibleWindowsCollector.CollectRawVisibleWindows(sw, sh, excludeHwnd);
            var results = PostProcess.Nms(raw);
            results = PostProcess.MergeTextNodes(results);
            results = PostProcess.FilterNoise(results, winTitles);
            var root = PostProcess.BuildContainmentTree(results, sw, sh);
            var leaves = PostProcess.ExtractLeaves(root);
            var clean = leaves.Select(el => new OutputNode(el.Type, el.Name, el.Rect)).ToList();
            return JsonOutput.Serialize(clean);
        }
        catch (Exception e)
        {
            Console.WriteLine($"Perceive error: {e.Message}");
            return "[]";
        }
    }
}
