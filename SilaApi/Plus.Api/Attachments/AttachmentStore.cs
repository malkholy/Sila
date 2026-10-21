using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;

namespace Plus.Api.Attachments;

// State = 0 on success, otherwise the SP's HTTP-style code (400/403/404/409).
public sealed record AttachmentResult(int State, string Message, List<Dictionary<string, object?>> Rows);

public interface IAttachmentStore
{
    Task<AttachmentResult> ExecuteAsync(DatabaseOptions database, string operation, string username,
        object lineData, CancellationToken cancellationToken);
}

// Pls.APIPlusAttachmentOperation: metadata + the page-permission decision for
// @User. Fixed procedure, never chosen by the caller.
public sealed class SqlAttachmentStore(IConfiguration config, IOptionsMonitor<GatewayOptions> options) : IAttachmentStore
{
    public async Task<AttachmentResult> ExecuteAsync(DatabaseOptions database, string operation, string username,
        object lineData, CancellationToken cancellationToken)
    {
        var configured = config.GetConnectionString(database.ConnectionStringName);
        if (string.IsNullOrWhiteSpace(configured)) throw new GatewayException(503, "Database is not configured.");
        var connectionString = new SqlConnectionStringBuilder(configured)
        {
            // Preserve the server-configured TrustServerCertificate setting.
            Encrypt = SqlConnectionEncryptOption.Mandatory,
            PersistSecurityInfo = false, ConnectRetryCount = 0, ConnectTimeout = 10
        };
        await using var connection = new SqlConnection(connectionString.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = new SqlCommand("Pls.APIPlusAttachmentOperation", connection)
        { CommandType = CommandType.StoredProcedure, CommandTimeout = options.CurrentValue.CommandTimeoutSeconds };
        command.Parameters.Add("@Operation", SqlDbType.VarChar, 100).Value = operation;
        command.Parameters.Add("@LineData", SqlDbType.NVarChar, -1).Value = JsonSerializer.Serialize(lineData);
        command.Parameters.Add("@User", SqlDbType.NVarChar, 100).Value = username;
        var state = command.Parameters.Add("@State", SqlDbType.Int);
        state.Direction = ParameterDirection.Output;
        var message = command.Parameters.Add("@Message", SqlDbType.NVarChar, 500);
        message.Direction = ParameterDirection.Output;

        var rows = new List<Dictionary<string, object?>>();
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                var row = new Dictionary<string, object?>();
                for (var i = 0; i < reader.FieldCount; i++)
                    row[reader.GetName(i)] = await reader.IsDBNullAsync(i, cancellationToken) ? null : reader.GetValue(i);
                rows.Add(row);
            }
        }
        var code = state.Value is int s ? s : 0;
        var text = message.Value as string ?? "";
        // Never pass raw SQL error text to the client.
        if (text.StartsWith("SQL Exception", StringComparison.OrdinalIgnoreCase)) text = "The operation was not completed.";
        return new(code, text, code == 0 ? rows : []);
    }
}
