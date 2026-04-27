namespace Pupil.Core;

// Rectangle helpers used for clipping, occlusion subtraction, and overlap scoring.
internal static class Geometry
{
    internal static (int x, int y, int w, int h) ClipRectToRegions(int x, int y, int w, int h, List<RectI> regions)
    {
        // Keep the largest intersection so each node maps to a single visible fragment.
        RectI? best = null;
        var bestArea = 0;
        var nodeRect = new RectI(x, y, x + w, y + h);
        foreach (var region in regions)
        {
            var inter = RectIntersection(nodeRect, region);
            if (inter is null)
            {
                continue;
            }
            var area = RectArea(inter.Value);
            if (area > bestArea)
            {
                bestArea = area;
                best = inter;
            }
        }
        if (best is null)
        {
            return (x, y, 0, 0);
        }
        var b = best.Value;
        return (b.Left, b.Top, b.Right - b.Left, b.Bottom - b.Top);
    }

    internal static List<RectI> SubtractMany(RectI @base, List<RectI> cuts)
    {
        // Iteratively carve out occluded areas; output may contain multiple visible fragments.
        var fragments = new List<RectI> { @base };
        foreach (var cut in cuts)
        {
            var next = new List<RectI>();
            foreach (var frag in fragments)
            {
                next.AddRange(SubtractRect(frag, cut));
            }
            fragments = next;
            if (fragments.Count == 0)
            {
                break;
            }
        }
        return fragments;
    }

    internal static List<RectI> SubtractRect(RectI @base, RectI cut)
    {
        var inter = RectIntersection(@base, cut);
        if (inter is null)
        {
            return [@base];
        }

        var b = @base;
        var i = inter.Value;
        var outRects = new List<RectI>();
        // Split into up to four axis-aligned bands around the intersection.
        if (b.Top < i.Top)
        {
            outRects.Add(new RectI(b.Left, b.Top, b.Right, i.Top));
        }
        if (i.Bottom < b.Bottom)
        {
            outRects.Add(new RectI(b.Left, i.Bottom, b.Right, b.Bottom));
        }
        if (b.Left < i.Left)
        {
            outRects.Add(new RectI(b.Left, i.Top, i.Left, i.Bottom));
        }
        if (i.Right < b.Right)
        {
            outRects.Add(new RectI(i.Right, i.Top, b.Right, i.Bottom));
        }
        return outRects.Where(r => RectArea(r) > 0).ToList();
    }

    internal static RectI? RectIntersection(RectI a, RectI b)
    {
        var left = Math.Max(a.Left, b.Left);
        var top = Math.Max(a.Top, b.Top);
        var right = Math.Min(a.Right, b.Right);
        var bottom = Math.Min(a.Bottom, b.Bottom);
        return right <= left || bottom <= top ? null : new RectI(left, top, right, bottom);
    }

    internal static int RectArea(RectI rect) => Math.Max(0, rect.Right - rect.Left) * Math.Max(0, rect.Bottom - rect.Top);

    internal static double Iou(RectOut a, RectOut b)
    {
        // Intersection-over-union for de-duplicating near-identical bounding boxes.
        var iw = Math.Max(0, Math.Min(a.X + a.W, b.X + b.W) - Math.Max(a.X, b.X));
        var ih = Math.Max(0, Math.Min(a.Y + a.H, b.Y + b.H) - Math.Max(a.Y, b.Y));
        var inter = iw * ih;
        var union = (a.W * a.H) + (b.W * b.H) - inter;
        return union == 0 ? 0.0 : (double)inter / union;
    }
}
