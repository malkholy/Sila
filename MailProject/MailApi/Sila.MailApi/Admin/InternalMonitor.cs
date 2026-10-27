using Microsoft.Data.SqlClient;
using Sila.Mail.Monitor;

namespace Sila.MailApi.Admin;

// Internal role: the Mail Monitor's figures straight from InternalMail (the
// shared queries the Mail Connector API pushes out). Behind an interface for tests.
public interface IInternalMonitor
{
    Task<object> OverviewAsync(CancellationToken ct);
    Task<object> AccountsAsync(CancellationToken ct);
    Task<object> ErrorsAsync(CancellationToken ct);
    Task<object?> AccountAsync(int userId, CancellationToken ct);
}

public sealed class SqlInternalMonitor(IConfiguration configuration) : IInternalMonitor
{
    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var connection = new SqlConnection(configuration.GetConnectionString("Mail")
            ?? throw new InvalidOperationException("ConnectionStrings:Mail is not configured."));
        await connection.OpenAsync(ct);
        return connection;
    }

    public async Task<object> OverviewAsync(CancellationToken ct)
    {
        await using var c = await OpenAsync(ct);
        return await MonitorQueries.OverviewAsync(c, ct);
    }

    public async Task<object> AccountsAsync(CancellationToken ct)
    {
        await using var c = await OpenAsync(ct);
        return await MonitorQueries.AccountsAsync(c, ct);
    }

    public async Task<object> ErrorsAsync(CancellationToken ct)
    {
        await using var c = await OpenAsync(ct);
        return await MonitorQueries.ErrorsAsync(c, ct);
    }

    public async Task<object?> AccountAsync(int userId, CancellationToken ct)
    {
        await using var c = await OpenAsync(ct);
        return await MonitorQueries.AccountAsync(c, userId, ct);
    }
}
