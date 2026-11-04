using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Services;

/// <summary>
/// Durable outbox backed by SQLite. Every telemetry event is written here first, with a
/// unique event id and a monotonically increasing sequence number, and is deleted only
/// after the central API acknowledges it. Also stores small agent state (read bookmarks).
/// </summary>
public sealed class LocalQueueService : IDisposable
{
    /// <summary>Version of the event envelope/payload format. Bump on breaking changes.</summary>
    public const int SchemaVersion = 1;

    private const int SqlParameterChunk = 500;

    private readonly DeviceIdentityService _identity;
    private readonly QueueOptions _options;
    private readonly ILogger<LocalQueueService> _logger;
    private readonly string _connectionString;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private volatile bool _initialized;

    public LocalQueueService(
        DeviceIdentityService identity,
        IOptions<QueueOptions> options,
        ILogger<LocalQueueService> logger)
    {
        _identity = identity;
        _options = options.Value;
        _logger = logger;
        DatabasePath = Path.Combine(identity.DataDirectory, "telemetry-queue.db");
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = true,
            DefaultTimeout = 30,
        }.ToString();
    }

    public string DatabasePath { get; }

    /// <summary>
    /// Writes an event to the queue and returns its sequence number.
    /// The payload's top-level properties are merged into the envelope.
    /// </summary>
    /// <param name="replacePending">Delete still-pending events of the same type first (used for heartbeats).</param>
    public async Task<long> EnqueueAsync(
        string eventType,
        object payload,
        EventPriority priority,
        CancellationToken ct = default,
        bool replacePending = false)
    {
        await EnsureInitializedAsync(ct);

        if (JsonSerializer.SerializeToNode(payload, payload.GetType(), JsonDefaults.Options) is not JsonObject body)
        {
            throw new ArgumentException("Payload must serialize to a JSON object.", nameof(payload));
        }

        var eventId = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow;

        await _writeLock.WaitAsync(ct);
        try
        {
            await using var conn = await OpenAsync(ct);
            await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);

            if (replacePending)
            {
                await using var del = Command(conn, tx, "DELETE FROM outbox WHERE event_type = $type", ("$type", eventType));
                await del.ExecuteNonQueryAsync(ct);
            }

            long sequence;
            await using (var seqCmd = Command(conn, tx, "UPDATE sequence_counter SET value = value + 1 WHERE id = 1 RETURNING value"))
            {
                sequence = Convert.ToInt64(await seqCmd.ExecuteScalarAsync(ct));
            }

            var envelope = new JsonObject
            {
                ["eventId"] = eventId,
                ["schemaVersion"] = SchemaVersion,
                ["sequenceNumber"] = sequence,
                ["eventType"] = eventType,
                ["priority"] = priority.ToString().ToLowerInvariant(),
                ["deviceId"] = _identity.DeviceId,
                ["storeId"] = _identity.StoreId,
                ["timestamp"] = now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
                ["agentVersion"] = _identity.AgentVersion,
            };

            foreach (var (key, value) in body.ToList())
            {
                if (envelope.ContainsKey(key))
                {
                    // Overwriting eventId/timestamp/etc. would break deduplication and acknowledgement.
                    throw new InvalidOperationException($"Payload for '{eventType}' uses reserved envelope field '{key}'.");
                }

                body.Remove(key);
                envelope[key] = value;
            }

            var json = envelope.ToJsonString(JsonDefaults.Options);

            await using (var insert = Command(conn, tx,
                """
                INSERT INTO outbox (seq, event_id, event_type, priority, created_unix, payload, size_bytes)
                VALUES ($seq, $id, $type, $priority, $created, $payload, $size)
                """,
                ("$seq", sequence),
                ("$id", eventId),
                ("$type", eventType),
                ("$priority", (int)priority),
                ("$created", now.ToUnixTimeSeconds()),
                ("$payload", json),
                ("$size", System.Text.Encoding.UTF8.GetByteCount(json))))
            {
                await insert.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
            return sequence;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>Highest priority first, then oldest first, bounded by count and bytes.</summary>
    public async Task<IReadOnlyList<QueuedEvent>> PeekBatchAsync(int maxEvents, int maxBytes, CancellationToken ct)
    {
        await EnsureInitializedAsync(ct);
        await using var conn = await OpenAsync(ct);
        await using var cmd = Command(conn, null,
            "SELECT seq, event_id, payload, size_bytes FROM outbox ORDER BY priority DESC, seq ASC LIMIT $limit",
            ("$limit", Math.Max(1, maxEvents)));

        var batch = new List<QueuedEvent>();
        var bytes = 0;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var size = reader.GetInt32(3);
            if (batch.Count > 0 && bytes + size > maxBytes)
            {
                break;
            }

            batch.Add(new QueuedEvent(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), size));
            bytes += size;
        }

        return batch;
    }

    /// <summary>Deletes events the server acknowledged (or permanently rejected).</summary>
    public async Task<int> RemoveAsync(IEnumerable<string> eventIds, CancellationToken ct)
    {
        var ids = eventIds.Distinct().ToList();
        if (ids.Count == 0)
        {
            return 0;
        }

        await EnsureInitializedAsync(ct);
        await _writeLock.WaitAsync(ct);
        try
        {
            await using var conn = await OpenAsync(ct);
            await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
            var removed = 0;
            foreach (var chunk in ids.Chunk(SqlParameterChunk))
            {
                var names = chunk.Select((_, i) => $"$p{i}").ToArray();
                await using var cmd = Command(conn, tx,
                    $"DELETE FROM outbox WHERE event_id IN ({string.Join(',', names)})",
                    chunk.Select((id, i) => (names[i], (object?)id)).ToArray());
                removed += await cmd.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
            return removed;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>
    /// Records a server rejection for these events. Events that reach
    /// <see cref="QueueOptions.MaxDeliveryAttempts"/> are discarded so one bad event cannot block the queue.
    /// </summary>
    public async Task<int> RecordRejectionAsync(IEnumerable<long> sequences, CancellationToken ct)
    {
        var seqs = sequences.ToList();
        if (seqs.Count == 0)
        {
            return 0;
        }

        await EnsureInitializedAsync(ct);
        await _writeLock.WaitAsync(ct);
        try
        {
            await using var conn = await OpenAsync(ct);
            await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            foreach (var chunk in seqs.Chunk(SqlParameterChunk))
            {
                var names = chunk.Select((_, i) => $"$p{i}").ToArray();
                var parameters = chunk.Select((s, i) => (names[i], (object?)s)).Append(("$now", now)).ToArray();
                await using var cmd = Command(conn, tx,
                    $"UPDATE outbox SET attempts = attempts + 1, last_attempt_unix = $now WHERE seq IN ({string.Join(',', names)})",
                    parameters);
                await cmd.ExecuteNonQueryAsync(ct);
            }

            int discarded;
            await using (var purge = Command(conn, tx, "DELETE FROM outbox WHERE attempts >= $max", ("$max", _options.MaxDeliveryAttempts)))
            {
                discarded = await purge.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
            if (discarded > 0)
            {
                _logger.LogWarning("Discarded {Count} event(s) rejected by the server {Max} times", discarded, _options.MaxDeliveryAttempts);
            }

            return discarded;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async Task<QueueStats> GetStatsAsync(CancellationToken ct)
    {
        await EnsureInitializedAsync(ct);
        await using var conn = await OpenAsync(ct);
        await using var cmd = Command(conn, null,
            """
            SELECT COUNT(*),
                   COALESCE(SUM(CASE WHEN priority >= 3 THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(size_bytes), 0),
                   MIN(created_unix)
            FROM outbox
            """);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        await reader.ReadAsync(ct);
        return new QueueStats(
            reader.GetInt64(0),
            reader.GetInt64(1),
            reader.GetInt64(2),
            reader.IsDBNull(3) ? null : DateTimeOffset.FromUnixTimeSeconds(reader.GetInt64(3)));
    }

    public async Task<string?> GetStateAsync(string key, CancellationToken ct)
    {
        await EnsureInitializedAsync(ct);
        await using var conn = await OpenAsync(ct);
        await using var cmd = Command(conn, null, "SELECT value FROM agent_state WHERE key = $key", ("$key", key));
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    public async Task SetStatesAsync(IReadOnlyDictionary<string, string> values, CancellationToken ct)
    {
        if (values.Count == 0)
        {
            return;
        }

        await EnsureInitializedAsync(ct);
        await _writeLock.WaitAsync(ct);
        try
        {
            await using var conn = await OpenAsync(ct);
            await using var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct);
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            foreach (var (key, value) in values)
            {
                await using var cmd = Command(conn, tx,
                    """
                    INSERT INTO agent_state (key, value, updated_unix) VALUES ($key, $value, $now)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_unix = excluded.updated_unix
                    """,
                    ("$key", key), ("$value", value), ("$now", now));
                await cmd.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>
    /// Applies retention so a long outage cannot fill the disk:
    /// expire old routine events, thin old metrics, then enforce the size cap
    /// by dropping the lowest-priority, oldest events first.
    /// </summary>
    public async Task<MaintenanceResult> RunMaintenanceAsync(CancellationToken ct)
    {
        await EnsureInitializedAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var maxBytes = (long)_options.MaxDatabaseSizeMB * 1024 * 1024;

        await _writeLock.WaitAsync(ct);
        try
        {
            await using var conn = await OpenAsync(ct);

            int expiredRoutine, expiredImportant, poison, downsampled, droppedForSize = 0;
            await using (var tx = (SqliteTransaction)await conn.BeginTransactionAsync(ct))
            {
                expiredRoutine = await ExecAsync(conn, tx,
                    "DELETE FROM outbox WHERE priority <= $normal AND created_unix < $cutoff",
                    ct,
                    ("$normal", (int)EventPriority.Normal),
                    ("$cutoff", now.AddHours(-_options.RoutineRetentionHours).ToUnixTimeSeconds()));

                expiredImportant = await ExecAsync(conn, tx,
                    "DELETE FROM outbox WHERE priority >= $high AND created_unix < $cutoff",
                    ct,
                    ("$high", (int)EventPriority.High),
                    ("$cutoff", now.AddDays(-_options.CriticalRetentionDays).ToUnixTimeSeconds()));

                poison = await ExecAsync(conn, tx,
                    "DELETE FROM outbox WHERE attempts >= $max",
                    ct,
                    ("$max", _options.MaxDeliveryAttempts));

                // Keep the first metrics sample per bucket for anything older than the threshold.
                downsampled = await ExecAsync(conn, tx,
                    """
                    DELETE FROM outbox
                    WHERE event_type = $type AND created_unix < $cutoff
                      AND seq NOT IN (
                          SELECT MIN(seq) FROM outbox
                          WHERE event_type = $type AND created_unix < $cutoff
                          GROUP BY created_unix / $bucket)
                    """,
                    ct,
                    ("$type", EventTypes.Metrics),
                    ("$cutoff", now.AddHours(-_options.DownsampleMetricsAfterHours).ToUnixTimeSeconds()),
                    ("$bucket", Math.Max(60, _options.DownsampleBucketMinutes * 60)));

                await tx.CommitAsync(ct);
            }

            // Size cap, measured on pages actually in use.
            while (await GetUsedBytesAsync(conn, ct) > maxBytes)
            {
                var deleted = await ExecAsync(conn, null,
                    "DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox ORDER BY priority ASC, seq ASC LIMIT 500)",
                    ct);
                if (deleted == 0)
                {
                    break;
                }

                droppedForSize += deleted;
            }

            await ExecAsync(conn, null, "PRAGMA incremental_vacuum;", ct);
            await ExecAsync(conn, null, "PRAGMA wal_checkpoint(TRUNCATE);", ct);

            var result = new MaintenanceResult(expiredRoutine, expiredImportant, poison, downsampled, droppedForSize);
            if (result.Total > 0)
            {
                _logger.LogInformation(
                    "Queue maintenance removed {Total} event(s): expiredRoutine={Routine} expiredImportant={Important} poison={Poison} downsampled={Downsampled} droppedForSize={Size}",
                    result.Total, expiredRoutine, expiredImportant, poison, downsampled, droppedForSize);
            }

            if (droppedForSize > 0)
            {
                _logger.LogWarning("Queue reached its {MaxMB} MB cap; dropped {Count} lowest-priority event(s)", _options.MaxDatabaseSizeMB, droppedForSize);
            }

            return result;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void Dispose()
    {
        _writeLock.Dispose();
        SqliteConnection.ClearAllPools();
    }

    private async Task EnsureInitializedAsync(CancellationToken ct)
    {
        if (_initialized)
        {
            return;
        }

        await _writeLock.WaitAsync(ct);
        try
        {
            if (_initialized)
            {
                return;
            }

            await using var conn = await OpenAsync(ct);

            // auto_vacuum must be set before the first table is created.
            await ExecAsync(conn, null, "PRAGMA auto_vacuum = INCREMENTAL;", ct);
            await ExecAsync(conn, null, "PRAGMA journal_mode = WAL;", ct);
            await ExecAsync(conn, null,
                """
                CREATE TABLE IF NOT EXISTS outbox (
                    seq               INTEGER PRIMARY KEY,
                    event_id          TEXT    NOT NULL UNIQUE,
                    event_type        TEXT    NOT NULL,
                    priority          INTEGER NOT NULL,
                    created_unix      INTEGER NOT NULL,
                    payload           TEXT    NOT NULL,
                    size_bytes        INTEGER NOT NULL,
                    attempts          INTEGER NOT NULL DEFAULT 0,
                    last_attempt_unix INTEGER NULL
                );
                CREATE INDEX IF NOT EXISTS ix_outbox_priority_seq ON outbox (priority DESC, seq ASC);
                CREATE INDEX IF NOT EXISTS ix_outbox_type_created ON outbox (event_type, created_unix);

                CREATE TABLE IF NOT EXISTS sequence_counter (
                    id    INTEGER PRIMARY KEY CHECK (id = 1),
                    value INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO sequence_counter (id, value) VALUES (1, 0);

                CREATE TABLE IF NOT EXISTS agent_state (
                    key          TEXT PRIMARY KEY,
                    value        TEXT NOT NULL,
                    updated_unix INTEGER NOT NULL
                );
                """,
                ct);

            _initialized = true;
            _logger.LogInformation("Local telemetry queue ready at {Path}", DatabasePath);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task<SqliteConnection> OpenAsync(CancellationToken ct)
    {
        var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        return conn;
    }

    private static async Task<long> GetUsedBytesAsync(SqliteConnection conn, CancellationToken ct)
    {
        await using var cmd = Command(conn, null,
            "SELECT (page_count - freelist_count) * page_size FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()");
        return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct));
    }

    private static async Task<int> ExecAsync(
        SqliteConnection conn,
        SqliteTransaction? tx,
        string sql,
        CancellationToken ct,
        params (string Name, object? Value)[] parameters)
    {
        await using var cmd = Command(conn, tx, sql, parameters);
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    private static SqliteCommand Command(
        SqliteConnection conn,
        SqliteTransaction? tx,
        string sql,
        params (string Name, object? Value)[] parameters)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = tx;
        foreach (var (name, value) in parameters)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        return cmd;
    }
}
