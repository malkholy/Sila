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
            : new(false, state, "The operation was not completed.", [], []);
    }

    private static bool TryState(object? value, out int state)
    {
        state = 0;
        return value is not null && value != DBNull.Value
            && int.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out state);
    }
}
