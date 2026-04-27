using System.Text.Json;
using System.Text.Json.Serialization;

namespace Pupil.Core;

internal static class JsonOutput
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    internal static string Serialize(List<OutputNode> nodes) => JsonSerializer.Serialize(nodes, Options);
}
