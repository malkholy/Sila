using System.Data;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;

namespace Plus.Api.Auth;

public sealed class SqlAuthStore(IConfiguration config, IOptionsMonitor<GatewayOptions> options) : IAuthStore
{
    public async Task<AuthIdentity?> ExecuteAsync(AuthCommand request, CancellationToken cancellationToken)
    {
        if (!options.CurrentValue.Databases.TryGetValue(request.Database, out var db) || !db.Enabled || !db.LocalLoginEnabled)
            throw new GatewayException(403, "Database access denied.");
        var configured = config.GetConnectionString(db.ConnectionStringName);
        if (string.IsNullOrWhiteSpace(configured)) throw new GatewayException(503, "Database is not configured.");
        var connectionString = new SqlConnectionStringBuilder(configured)
        {
            // Preserve the server-configured TrustServerCertificate setting.
            Encrypt = SqlConnectionEncryptOption.Mandatory,
            PersistSecurityInfo = false, ConnectRetryCount = 0, ConnectTimeout = 10
        };
        await using var connection = new SqlConnection(connectionString.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        // Fixed adapter, never chosen by the caller or exposed through /exec.
        await using var command = new SqlCommand("PLS.APIPlusAuthSessionOperation", connection)
        { CommandType = CommandType.StoredProcedure, CommandTimeout = 30 };
        command.Parameters.Add("@Operation", SqlDbType.VarChar, 30).Value = request.Operation;
        command.Parameters.Add("@ClientIP", SqlDbType.VarChar, 45).Value = request.ClientIp;
        command.Parameters.Add("@Username", SqlDbType.NVarChar, 100).Value = (object?)request.Username ?? DBNull.Value;
        command.Parameters.Add("@Password", SqlDbType.NVarChar, 100).Value = (object?)request.Password ?? DBNull.Value;
        command.Parameters.Add("@NewPassword", SqlDbType.NVarChar, 100).Value = (object?)request.NewPassword ?? DBNull.Value;
        command.Parameters.Add("@SessionId", SqlDbType.UniqueIdentifier).Value = (object?)request.SessionId ?? DBNull.Value;
        command.Parameters.Add("@RefreshHash", SqlDbType.Binary, 32).Value = (object?)request.RefreshHash ?? DBNull.Value;
        command.Parameters.Add("@NewRefreshHash", SqlDbType.Binary, 32).Value = (object?)request.NewRefreshHash ?? DBNull.Value;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        // The right password, but the account must change it first (the SP checks the password before saying so).
        if (reader.FieldCount == 1 && reader.GetName(0) == "Refusal" && reader.GetString(0) == "PasswordChangeRequired")
            throw new GatewayException(403, "This account must change its password first. Ask the administrator to reset it.");
        return new(reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
            reader.GetBoolean(4), DateTime.SpecifyKind(reader.GetDateTime(5), DateTimeKind.Utc));
    }
}
