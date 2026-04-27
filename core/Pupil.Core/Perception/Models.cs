namespace Pupil.Core;

internal readonly record struct RectI(int Left, int Top, int Right, int Bottom);
internal readonly record struct RectOut(int X, int Y, int W, int H);
internal sealed record RawNode(string Type, string Name, RectOut Rect, int Depth, int Desc);
internal sealed record OutputNode(string Type, string Name, RectOut Rect);

internal sealed class TreeNode(RawNode data)
{
    public RawNode Data { get; } = data;
    public List<TreeNode> Children { get; } = [];
}
