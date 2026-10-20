using System.Data;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace Plus.Api;

public sealed record ParameterMetadata(string Name, SqlDbType Type, int Size, byte Precision,
    byte Scale, bool IsOutput);

public static class ParameterBinder
{
    public static void Bind(SqlCommand command, IReadOnlyList<ParameterMetadata> metadata,
        ExecRequest request, ExecutionContext context)
    {
        if (!metadata.Any(x => x.Name.Equals("@User", StringComparison.OrdinalIgnoreCase) && !x.IsOutput)
            || !metadata.Any(x => x.Name.Equals("@Operation", StringComparison.OrdinalIgnoreCase) && !x.IsOutput)
            || !metadata.Any(x => x.Name.Equals("@State", StringComparison.OrdinalIgnoreCase)
                && x.IsOutput && x.Type == SqlDbType.Int))
            throw new GatewayException(503, "Procedure does not implement the gateway contract.");

        var supplied = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in request.ExtraParams ?? []) supplied.Add(pair.Key, pair.Value);
        supplied["Operation"] = JsonSerializer.SerializeToElement(request.Operation);
        supplied["User"] = JsonSerializer.SerializeToElement(context.Username);
        foreach (var (name, value) in new[] { ("IP", context.ClientIp), ("ClientIP", context.ClientIp),
            ("AccessZone", context.AccessZone), ("DbKey", context.DatabaseKey) })
            if (metadata.Any(x => x.Name.Equals("@" + name, StringComparison.OrdinalIgnoreCase)))
                supplied[name] = JsonSerializer.SerializeToElement(value);
        if (request.LineData.ValueKind != JsonValueKind.Undefined)
            supplied["LineData"] = request.LineData;

        foreach (var key in supplied.Keys)
            if (!metadata.Any(x => x.Name.Equals("@" + key, StringComparison.OrdinalIgnoreCase) && !x.IsOutput))
                throw new GatewayException(400, "A parameter is not supported by this procedure.");

        foreach (var item in metadata)
        {
            var name = item.Name.TrimStart('@');
            var exists = supplied.TryGetValue(name, out var value);
            // Omission preserves SQL defaults; explicit JSON null binds SQL NULL.
            if (!exists && !item.IsOutput) continue;
            var parameter = new SqlParameter(item.Name, item.Type)
            {
                Size = item.Size, Precision = item.Precision, Scale = item.Scale,
                Direction = item.IsOutput ? ParameterDirection.Output : ParameterDirection.Input
            };
            if (!item.IsOutput) parameter.Value = ConvertValue(item, value);
            command.Parameters.Add(parameter);
        }
    }

    public static object ConvertValue(ParameterMetadata item, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Null) return DBNull.Value;
        try
        {
            object result = item.Type switch
            {
                SqlDbType.NVarChar or SqlDbType.NChar or SqlDbType.VarChar or SqlDbType.Char =>
                    value.ValueKind is JsonValueKind.Object or JsonValueKind.Array
                        ? value.GetRawText() : value.GetString()!,
                SqlDbType.Int => value.GetInt32(),
                SqlDbType.BigInt => value.GetInt64(),
                SqlDbType.SmallInt => value.GetInt16(),
                SqlDbType.TinyInt => value.GetByte(),
                SqlDbType.Bit => value.GetBoolean(),
                SqlDbType.Decimal or SqlDbType.Money or SqlDbType.SmallMoney => value.GetDecimal(),
                SqlDbType.Float => value.GetDouble(),
                SqlDbType.Real => value.GetSingle(),
                SqlDbType.UniqueIdentifier => value.GetGuid(),
                SqlDbType.Date => DateTime.ParseExact(value.GetString()!, "yyyy-MM-dd", CultureInfo.InvariantCulture),
                SqlDbType.DateTime or SqlDbType.DateTime2 or SqlDbType.SmallDateTime => value.GetDateTime(),
                SqlDbType.DateTimeOffset => value.GetDateTimeOffset(),
                SqlDbType.Time => TimeSpan.ParseExact(value.GetString()!, "c", CultureInfo.InvariantCulture),
                SqlDbType.Binary or SqlDbType.VarBinary => value.GetBytesFromBase64(),
                _ => throw new GatewayException(503, "Procedure uses an unsupported parameter type.")
            };
            if (item.Size > 0 && ((result is string s && s.Length > item.Size)
                || (result is byte[] b && b.Length > item.Size))) throw new FormatException();
            if (result is decimal number)
            {
                var scale = item.Type is SqlDbType.Money or SqlDbType.SmallMoney ? 4 : item.Scale;
                if (decimal.Round(number, Math.Min(scale, (byte)28)) != number) throw new FormatException();
                if (item.Type == SqlDbType.Decimal && item.Precision > 0)
                {
                    var integerDigits = decimal.Truncate(Math.Abs(number)).ToString(CultureInfo.InvariantCulture).Length;
                    if (Math.Abs(number) >= 1 && integerDigits > item.Precision - item.Scale) throw new FormatException();
                }
                if (item.Type == SqlDbType.Money && (number < -922337203685477.5808m || number > 922337203685477.5807m)) throw new FormatException();
                if (item.Type == SqlDbType.SmallMoney && (number < -214748.3648m || number > 214748.3647m)) throw new FormatException();
            }
            return result;
        }
        catch (Exception error) when (error is FormatException or InvalidOperationException or OverflowException or ArgumentException)
        {
            throw new GatewayException(400, $"Invalid value for parameter {item.Name}.");
        }
    }
}
