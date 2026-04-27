using System.Text.Json;
using System.Text.Json.Serialization;

namespace Pupil.Core;

// Centralizes JSON serialization options for stable API output.
internal static class JsonOutput
{
    private static readonly JsonSerializerOptions Options = new()
    {
        // Python callers consume camelCase keys.
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        // Keep explicit null/default values so downstream schema stays predictable.
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    internal static string Serialize(List<OutputNode> nodes) => JsonSerializer.Serialize(nodes, Options);
}
