namespace Pupil.Core;

// Integer rectangle used for intersection/subtraction in screen coordinates.
internal readonly record struct RectI(int Left, int Top, int Right, int Bottom);
// Output rectangle shape expected by external consumers (x/y/width/height).
internal readonly record struct RectOut(int X, int Y, int W, int H);
// Internal node representation enriched with traversal depth and descendant count.
internal sealed record RawNode(string Type, string Name, RectOut Rect, int Depth, int Desc);
// Public-facing node returned from the API.
internal sealed record OutputNode(string Type, string Name, RectOut Rect);

// Simple containment tree used to derive meaningful leaves from overlapping nodes.
internal sealed class TreeNode(RawNode data)
{
    public RawNode Data { get; } = data;
    public List<TreeNode> Children { get; } = [];
}
