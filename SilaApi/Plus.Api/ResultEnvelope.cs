using System.Globalization;

namespace Plus.Api;

public static class ResultEnvelope
{
    public static ApiEnvelope Create(Dictionary<string, List<Dictionary<string, object?>>> data,
        Dictionary<string, object?> outputs, int? statusResultSet)
    {
        if (!TryState(outputs.GetValueOrDefault("State"), out var state))
            throw new GatewayException(502, "Procedure returned no valid execution status.");
        // The legacy router's CATCH emits precisely State + Message, sometimes
        // without updating its output State. Recognize that shape conservatively.
        foreach (var rows in data.Values)
        {
            if (rows.Count != 1 || rows[0].Count != 2) continue;
            var status = new Dictionary<string, object?>(rows[0], StringComparer.OrdinalIgnoreCase);
            if (status.ContainsKey("Message") && TryState(status.GetValueOrDefault("State"), out var errorState)
                && errorState != 0) state = errorState;
        }
        if (statusResultSet is not null)
        {
            if (!data.TryGetValue($"List{statusResultSet}", out var rows) || rows.Count != 1
                || !TryState(rows[0].GetValueOrDefault("State"), out var rowState))
                throw new GatewayException(502, "Procedure returned an invalid status result set.");
            if (rowState != 0) state = rowState;
        }
        // Legacy SQL catches often put ERROR_MESSAGE() in Message. Do not expose it.
        // Lists stay in the same order on success; failure payloads are never returned.
        return state == 0
            ? new(true, 0, "", data, outputs)
            : new(false, state, BusinessMessage(outputs) ?? "The operation was not completed.", [], []);
    }

    // A procedure's own validation message ("Admin only", "Username is required")
    // is shown to the user: it is the @Message OUTPUT the procedure set together
    // with a non-zero @State OUTPUT. CATCH blocks only SELECT a status row and
    // leave the output State at 0, so their ERROR_MESSAGE() text never reaches
    // here; a "SQL Exception" message is refused regardless.
    private static string? BusinessMessage(Dictionary<string, object?> outputs)
    {
        if (!TryState(outputs.GetValueOrDefault("State"), out var outputState) || outputState == 0) return null;
        var message = Convert.ToString(outputs.GetValueOrDefault("Message"), CultureInfo.InvariantCulture)?.Trim();
        if (string.IsNullOrEmpty(message) || message.Length > 300
            || message.StartsWith("SQL Exception", StringComparison.OrdinalIgnoreCase)) return null;
        return message;
    }

    private static bool TryState(object? value, out int state)
    {
        state = 0;
        return value is not null && value != DBNull.Value
            && int.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out state);
    }
}
