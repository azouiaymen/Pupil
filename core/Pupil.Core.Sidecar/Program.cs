using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using Pupil.Core;

namespace Pupil.Core.Sidecar;

/// <summary>
/// JSON-stdio sidecar wrapping <see cref="PerceptionApi"/>.
///
/// Protocol (newline-delimited JSON, one envelope per line):
///   request  : {"id":"...","method":"perceive"|"shutdown"|"ping","params":{...}}
///   response : {"id":"...","result":<value>}
///   error    : {"id":"...","error":{"code":"...","message":"..."}}
///
/// stdin -> requests, stdout -> responses, stderr -> diagnostics.
/// The process exits 0 on shutdown method, 1 on fatal stdin EOF without shutdown.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class Program
{
    private const string ProtocolVersion = "1";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static int Main(string[] args)
    {
        WriteEvent("ready", new Dictionary<string, object?>
        {
            ["protocolVersion"] = ProtocolVersion,
            ["pid"] = Environment.ProcessId,
        });

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            JsonNode? envelope;
            try
            {
                envelope = JsonNode.Parse(line);
            }
            catch (Exception ex)
            {
                WriteError(null, "invalid_json", ex.Message);
                continue;
            }

            if (envelope is not JsonObject obj)
            {
                WriteError(null, "invalid_envelope", "Envelope must be a JSON object.");
                continue;
            }

            var requestId = obj["id"]?.GetValue<string>();
            var method = obj["method"]?.GetValue<string>();
            var paramsNode = obj["params"] as JsonObject;

            if (string.IsNullOrWhiteSpace(method))
            {
                WriteError(requestId, "missing_method", "Envelope must include a method.");
                continue;
            }

            try
            {
                switch (method)
                {
                    case "perceive":
                        HandlePerceive(requestId, paramsNode);
                        break;
                    case "ping":
                        WriteResponse(requestId, JsonValue.Create("pong"));
                        break;
                    case "shutdown":
                        WriteResponse(requestId, JsonValue.Create(true));
                        return 0;
                    default:
                        WriteError(requestId, "unknown_method", $"Unsupported method: {method}");
                        break;
                }
            }
            catch (Exception ex)
            {
                WriteError(requestId, "handler_failed", ex.Message);
            }
        }

        // stdin closed without shutdown: parent likely died.
        return 1;
    }

    private static void HandlePerceive(string? requestId, JsonObject? paramsNode)
    {
        var excludeHwnd = 0;
        if (paramsNode is not null && paramsNode.TryGetPropertyValue("excludeHwnd", out var hwndNode) && hwndNode is not null)
        {
            excludeHwnd = hwndNode.GetValue<int>();
        }

        var json = PerceptionApi.Perceive(excludeHwnd);
        // PerceptionApi already returns a serialized JSON array; pass it through as raw JSON.
        var resultNode = JsonNode.Parse(string.IsNullOrEmpty(json) ? "[]" : json);
        WriteResponse(requestId, resultNode);
    }

    private static void WriteResponse(string? requestId, JsonNode? result)
    {
        var envelope = new JsonObject
        {
            ["id"] = requestId,
            ["result"] = result?.DeepClone(),
        };
        WriteLine(envelope);
    }

    private static void WriteError(string? requestId, string code, string message)
    {
        var envelope = new JsonObject
        {
            ["id"] = requestId,
            ["error"] = new JsonObject
            {
                ["code"] = code,
                ["message"] = message,
            },
        };
        WriteLine(envelope);
    }

    private static void WriteEvent(string name, object payload)
    {
        var envelope = new JsonObject
        {
            ["event"] = name,
            ["payload"] = JsonSerializer.SerializeToNode(payload, JsonOptions),
        };
        WriteLine(envelope);
    }

    private static void WriteLine(JsonObject envelope)
    {
        // One JSON object per line; Console.Out is line-buffered which is fine for a sidecar.
        Console.Out.WriteLine(envelope.ToJsonString(JsonOptions));
        Console.Out.Flush();
    }
}
