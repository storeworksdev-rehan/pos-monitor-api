using System.Diagnostics;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Collectors;

/// <summary>
/// Checks the local POS database: can we connect, how fast, and (optionally) aggregate
/// transaction health such as counts and last-transaction time. Never reads row contents.
/// </summary>
public sealed class SqlHealthCollector(IOptions<SqlHealthOptions> options, ILogger<SqlHealthCollector> logger)
{
    private readonly SqlHealthOptions _options = options.Value;
    private bool _warnedAboutTextColumns;

    public bool IsEnabled => _options.Enabled && !string.IsNullOrWhiteSpace(_options.ConnectionString);

    public async Task<SqlHealthResult> CheckAsync(CancellationToken ct)
    {
        if (!IsEnabled)
        {
            return new SqlHealthResult(null, null, null, null);
        }

        SqlConnectionStringBuilder builder;
        try
        {
            builder = new SqlConnectionStringBuilder(_options.ConnectionString)
            {
                ConnectTimeout = _options.ConnectTimeoutSeconds,
                ApplicationName = "PosMonitoringAgent",
                // A pooled connection could hide a server that just went down.
                Pooling = false,
            };
        }
        catch (ArgumentException ex)
        {
            logger.LogError("SqlHealth:ConnectionString is invalid: {Error}", ex.Message);
            return new SqlHealthResult(false, null, -1, null);
        }

        var sw = Stopwatch.StartNew();
        try
        {
            await using var conn = new SqlConnection(builder.ConnectionString);
            await conn.OpenAsync(ct);
            await using (var ping = new SqlCommand("SELECT 1", conn) { CommandTimeout = _options.QueryTimeoutSeconds })
            {
                await ping.ExecuteScalarAsync(ct);
            }

            sw.Stop();
            var transactionHealth = await QueryTransactionHealthAsync(conn, ct);
            return new SqlHealthResult(true, sw.ElapsedMilliseconds, null, transactionHealth);
        }
        catch (SqlException ex)
        {
            logger.LogDebug("SQL health check failed with error {Number}", ex.Number);
            return new SqlHealthResult(false, null, ex.Number, null);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogDebug(ex, "SQL health check failed");
            return new SqlHealthResult(false, null, -1, null);
        }
    }

    private async Task<IReadOnlyDictionary<string, object?>?> QueryTransactionHealthAsync(SqlConnection conn, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_options.TransactionHealthQuery))
        {
            return null;
        }

        try
        {
            await using var cmd = new SqlCommand(_options.TransactionHealthQuery, conn) { CommandTimeout = _options.QueryTimeoutSeconds };
            await using var reader = await cmd.ExecuteReaderAsync(System.Data.CommandBehavior.SingleRow, ct);
            if (!await reader.ReadAsync(ct))
            {
                return null;
            }

            var result = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < reader.FieldCount; i++)
            {
                var name = reader.GetName(i);
                var value = reader.IsDBNull(i) ? null : reader.GetValue(i);
                switch (value)
                {
                    case null:
                        result[name] = null;
                        break;
                    case byte or short or int or long or decimal or double or float or bool:
                        result[name] = value;
                        break;
                    case DateTime dt:
                        result[name] = DateTime.SpecifyKind(dt, DateTimeKind.Unspecified).ToString("yyyy-MM-dd'T'HH:mm:ss");
                        break;
                    case DateTimeOffset dto:
                        result[name] = dto.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
                        break;
                    default:
                        // Text and binary columns could contain customer or payment data; never forward them.
                        if (!_warnedAboutTextColumns)
                        {
                            logger.LogWarning("TransactionHealthQuery column {Column} is not numeric/date/bool and was ignored", name);
                            _warnedAboutTextColumns = true;
                        }

                        break;
                }
            }

            return result;
        }
        catch (SqlException ex)
        {
            logger.LogWarning("TransactionHealthQuery failed with SQL error {Number}", ex.Number);
            return null;
        }
    }
}
