namespace Pupil.Core;

internal static class PostProcess
{
    internal static List<RawNode> Nms(List<RawNode> raw)
    {
        var sorted = raw
            .OrderBy(x => PerceptionConstants.InteractiveTypes.Contains(x.Type) ? 0 : 1)
            .ThenBy(x => x.Desc)
            .ToList();

        var results = new List<RawNode>();
        foreach (var el in sorted)
        {
            var keep = true;
            foreach (var existing in results)
            {
                var overlaps = el.Rect.X < existing.Rect.X + existing.Rect.W &&
                               el.Rect.X + el.Rect.W > existing.Rect.X &&
                               el.Rect.Y < existing.Rect.Y + existing.Rect.H &&
                               el.Rect.Y + el.Rect.H > existing.Rect.Y;
                if (overlaps && Geometry.Iou(el.Rect, existing.Rect) > PerceptionConstants.IouThreshold)
                {
                    keep = false;
                    break;
                }
            }
            if (keep)
            {
                results.Add(el);
            }
        }
        return results;
    }

    internal static List<RawNode> MergeTextNodes(List<RawNode> results)
    {
        var merged = new List<RawNode>();
        var i = 0;
        while (i < results.Count)
        {
            var el = results[i];
            if (el.Type != "TextControl")
            {
                merged.Add(el);
                i++;
                continue;
            }

            var x = el.Rect.X;
            var y = el.Rect.Y;
            var w = el.Rect.W;
            var h = el.Rect.H;
            var name = el.Name;
            var j = i + 1;
            while (j < results.Count)
            {
                var next = results[j];
                if (next.Type != "TextControl" || next.Rect.Y != y || next.Rect.H != h)
                {
                    break;
                }
                if (next.Rect.X - (x + w) > 0)
                {
                    break;
                }
                name += next.Name;
                w = next.Rect.X + next.Rect.W - x;
                j++;
            }
            merged.Add(el with { Name = name, Rect = new RectOut(x, y, w, h) });
            i = j;
        }
        return merged;
    }

    internal static List<RawNode> FilterNoise(List<RawNode> results, HashSet<string> windowTitles)
    {
        return results.Where(el =>
            el.Rect.W >= 5 &&
            el.Rect.H >= 5 &&
            !PerceptionConstants.NoiseTypes.Contains(el.Type) &&
            (el.Type == "TextControl" || !windowTitles.Contains(el.Name))).ToList();
    }

    internal static TreeNode BuildContainmentTree(List<RawNode> results, int sw, int sh)
    {
        var root = new TreeNode(new RawNode("_root", "_root", new RectOut(0, 0, sw, sh), 0, 999999));
        var nodes = new List<(TreeNode n, int x1, int y1, int x2, int y2, int area)>();
        foreach (var result in results)
        {
            var node = new TreeNode(result);
            var x1 = result.Rect.X;
            var y1 = result.Rect.Y;
            var x2 = x1 + result.Rect.W;
            var y2 = y1 + result.Rect.H;
            nodes.Add((node, x1, y1, x2, y2, result.Rect.W * result.Rect.H));
        }
        nodes.Sort((a, b) => a.area.CompareTo(b.area));

        foreach (var (node, nx1, ny1, nx2, ny2, nArea) in nodes)
        {
            var bestParent = root;
            var bestArea = sw * sh;
            foreach (var (candidate, cx1, cy1, cx2, cy2, cArea) in nodes)
            {
                if (ReferenceEquals(candidate, node))
                {
                    continue;
                }
                if (cArea <= nArea || cArea >= bestArea)
                {
                    continue;
                }
                if (cx1 > nx1 || cy1 > ny1 || cx2 < nx2 || cy2 < ny2)
                {
                    continue;
                }
                if (cx1 == nx1 && cy1 == ny1 && cx2 == nx2 && cy2 == ny2)
                {
                    continue;
                }
                bestParent = candidate;
                bestArea = cArea;
            }
            bestParent.Children.Add(node);
        }

        SortTree(root);
        return root;
    }

    internal static List<RawNode> ExtractLeaves(TreeNode root)
    {
        var output = new List<RawNode>();
        Dfs(root);
        return output;

        bool HasInteractiveDesc(TreeNode node)
        {
            foreach (var child in node.Children)
            {
                if (PerceptionConstants.InteractiveTypes.Contains(child.Data.Type))
                {
                    return true;
                }
                if (HasInteractiveDesc(child))
                {
                    return true;
                }
            }
            return false;
        }

        void Dfs(TreeNode node)
        {
            if (node.Data.Type != "_root")
            {
                if (PerceptionConstants.InteractiveTypes.Contains(node.Data.Type))
                {
                    if (!HasInteractiveDesc(node))
                    {
                        output.Add(node.Data);
                        return;
                    }
                }
                else if (node.Data.Desc == 0)
                {
                    output.Add(node.Data);
                }
            }
            foreach (var child in node.Children)
            {
                Dfs(child);
            }
        }
    }

    private static void SortTree(TreeNode node)
    {
        node.Children.Sort((a, b) =>
        {
            var y = a.Data.Rect.Y.CompareTo(b.Data.Rect.Y);
            return y != 0 ? y : a.Data.Rect.X.CompareTo(b.Data.Rect.X);
        });
        foreach (var child in node.Children)
        {
            SortTree(child);
        }
    }
}
