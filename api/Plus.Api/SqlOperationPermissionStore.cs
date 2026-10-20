using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;

namespace Plus.Api;

public interface IOperationPermissionStore
{
    Task<OperationOptions?> FindAsync(DatabaseOptions database, string procedure, string operation,
        CancellationToken cancellationToken);
}

// Security metadata only; never returned as a business dataset or cached.
public sealed class SqlOperationPermissionStore(IConfiguration configuration,
    IOptionsMonitor<GatewayOptions> options) : IOperationPermissionStore
{
    public async Task<OperationOptions?> FindAsync(DatabaseOptions database, string procedure, string operation,
        CancellationToken cancellationToken)
    {
        var configured = configuration.GetConnectionString(database.ConnectionStringName);
        if (string.IsNullOrWhiteSpace(configured))
            throw new GatewayException(503, "Database is not configured.");
        var connectionString = new SqlConnectionStringBuilder(configured)
        {
            Encrypt = SqlConnectionEncryptOption.Mandatory,
            PersistSecurityInfo = false, ConnectRetryCount = 0, ConnectTimeout = 10
        };
        await using var connection = new SqlConnection(connectionString.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        const string sql = """
            SELECT Enabled, AllowExternal, AllowedParametersJson, StatusResultSet
            FROM PLS.V1ApiOperationPermission
            WHERE ProcedureName = @Procedure AND OperationName = @Operation;
            """;
        await using var command = new SqlCommand(sql, connection)
        {
            CommandTimeout = options.CurrentValue.CommandTimeoutSeconds
        };
        command.Parameters.Add("@Procedure", SqlDbType.NVarChar, 257).Value = procedure;
        command.Parameters.Add("@Operation", SqlDbType.NVarChar, 100).Value = operation;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        string[] parameters;
        try
        {
            parameters = JsonSerializer.Deserialize<string[]>(reader.GetString(2))
                ?? throw new JsonException();
            if (parameters.Any(string.IsNullOrWhiteSpace)) throw new JsonException();
        }
        catch (JsonException)
        {
            throw new GatewayException(503, "Invalid operation permission configuration.");
        }
        return new OperationOptions
        {
            Enabled = reader.GetBoolean(0), AllowExternal = reader.GetBoolean(1),
            AllowedParameters = parameters,
            StatusResultSet = reader.IsDBNull(3) ? null : reader.GetInt32(3)
        };
    }
}
