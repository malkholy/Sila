using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Plus.Api;

public sealed class SqlProcedureExecutor(IConfiguration configuration, IMemoryCache cache,
    IOptionsMonitor<GatewayOptions> options) : IProcedureExecutor
{
    public async Task<ApiEnvelope> ExecuteAsync(ExecRequest request, ExecutionContext context,
        CancellationToken cancellationToken)
    {
        var configured = configuration.GetConnectionString(context.Database.ConnectionStringName);
        if (string.IsNullOrWhiteSpace(configured))
            throw new GatewayException(503, "Database is not configured.");
        var connectionString = new SqlConnectionStringBuilder(configured)
        {
            Encrypt = SqlConnectionEncryptOption.Mandatory,
            // Preserve the server-configured TrustServerCertificate setting.
            PersistSecurityInfo = false,
            ConnectRetryCount = 0,
            ConnectTimeout = 10
        };
        await using var connection = new SqlConnection(connectionString.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        var metadata = await GetMetadata(connection, context, cancellationToken);
        await using var command = new SqlCommand(context.Procedure, connection)
        {
            CommandType = CommandType.StoredProcedure,
            CommandTimeout = options.CurrentValue.CommandTimeoutSeconds
        };
        ParameterBinder.Bind(command, metadata, request, context);
        var data = new Dictionary<string, List<Dictionary<string, object?>>>();
        var rowCount = 0;
        long resultBytes = 0;
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            var index = 0;
            do
            {
                if (reader.FieldCount == 0) continue;
                if (index >= 32) throw new GatewayException(502, "Result contains too many datasets.");
                var columns = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray();
                if (columns.Distinct(StringComparer.OrdinalIgnoreCase).Count() != columns.Length)
                    throw new GatewayException(502, "Result contains duplicate column names.");
                var rows = new List<Dictionary<string, object?>>();
                while (await reader.ReadAsync(cancellationToken))
                {
                    if (++rowCount > options.CurrentValue.MaxResultRows)
                        throw new GatewayException(502, "Result exceeds the row limit. Narrow the filters.");
                    var row = new Dictionary<string, object?>();
                    for (var field = 0; field < reader.FieldCount; field++)
                        row[columns[field]] = await reader.IsDBNullAsync(field, cancellationToken)
                            ? null : reader.GetValue(field);
                    resultBytes += JsonSerializer.SerializeToUtf8Bytes(row).Length;
                    if (resultBytes > options.CurrentValue.MaxResultBytes)
                        throw new GatewayException(502, "Result exceeds the size limit. Narrow the filters.");
                    rows.Add(row);
                }
                data[$"List{index++}"] = rows;
            } while (await reader.NextResultAsync(cancellationToken));
        }
        // SQL output values are available only after the reader closes.
        var outputs = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (SqlParameter parameter in command.Parameters)
            if (parameter.Direction == ParameterDirection.Output)
                outputs[parameter.ParameterName.TrimStart('@')] = parameter.Value == DBNull.Value ? null : parameter.Value;
        return ResultEnvelope.Create(data, outputs, context.Operation.StatusResultSet);
    }

    private async Task<IReadOnlyList<ParameterMetadata>> GetMetadata(SqlConnection connection,
        ExecutionContext context, CancellationToken cancellationToken)
    {
        var key = ("procedure-metadata", context.DatabaseKey, context.Database.ConnectionStringName,
            connection.DataSource, connection.Database, context.Procedure);
        if (cache.TryGetValue(key, out IReadOnlyList<ParameterMetadata>? existing) && existing is not null)
            return existing;
        // The name is a SQL value, never SQL text. Authorization precedes this lookup.
        const string sql = """
            SELECT p.name, t.name, p.max_length, p.precision, p.scale, p.is_output
            FROM sys.parameters AS p
            LEFT JOIN sys.types AS t ON t.user_type_id = p.system_type_id
            WHERE p.object_id = OBJECT_ID(@ProcedureName, 'P') AND p.parameter_id > 0
            ORDER BY p.parameter_id;
            """;
        await using var command = new SqlCommand(sql, connection)
        {
            CommandTimeout = options.CurrentValue.CommandTimeoutSeconds
        };
        command.Parameters.Add("@ProcedureName", SqlDbType.NVarChar, 257).Value = context.Procedure;
        var parameters = new List<ParameterMetadata>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            if (reader.IsDBNull(1))
                throw new GatewayException(503, "Procedure uses an unsupported parameter type.");
            var sqlType = reader.GetString(1);
            if (!Enum.TryParse<SqlDbType>(sqlType == "numeric" ? "Decimal" : sqlType, true, out var type)
                || type is SqlDbType.Structured or SqlDbType.Udt or SqlDbType.Variant
                    or SqlDbType.Text or SqlDbType.NText or SqlDbType.Image or SqlDbType.Xml or SqlDbType.Timestamp)
                throw new GatewayException(503, "Procedure uses an unsupported parameter type.");
            var size = (int)reader.GetInt16(2);
            if (size > 0 && type is SqlDbType.NVarChar or SqlDbType.NChar) size /= 2;
            parameters.Add(new(reader.GetString(0), type, size, reader.GetByte(3), reader.GetByte(4), reader.GetBoolean(5)));
        }
        if (parameters.Count == 0) throw new GatewayException(503, "Procedure metadata is unavailable.");
        cache.Set(key, (IReadOnlyList<ParameterMetadata>)parameters, TimeSpan.FromMinutes(10));
        return parameters;
    }
}
