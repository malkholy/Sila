using System.Text.Json;

namespace Plus.Api;

public sealed record ExecRequest(string Database, string Proc, string Operation,
    JsonElement LineData = default, Dictionary<string, JsonElement>? ExtraParams = null);

public sealed record ApiEnvelope(bool Ok, int State, string Message,
    Dictionary<string, List<Dictionary<string, object?>>> Data,
    Dictionary<string, object?> Outputs, string? TraceId = null)
{
    public static ApiEnvelope Error(string message, string? traceId = null) =>
        new(false, 1, message, [], [], traceId);
}

public sealed class GatewayException(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

public sealed record ExecutionContext(DatabaseOptions Database, string DatabaseKey,
    string Procedure, OperationOptions Operation, string Username, string ClientIp, string AccessZone);

public interface IProcedureExecutor
{
    Task<ApiEnvelope> ExecuteAsync(ExecRequest request, ExecutionContext context, CancellationToken cancellationToken);
}
