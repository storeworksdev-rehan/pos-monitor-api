using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;

namespace PosMonitoringAgent.Services;

/// <summary>
/// Talks to the central telemetry API.
///
/// Contract: POST {BaseUrl}/{BatchPath} with
/// <c>{ "deviceId", "storeId", "sentAt", "events": [ ...envelopes ] }</c>.
/// The server must reply 2xx with <c>{ "acknowledgedEventIds": [...], "rejectedEventIds": [...] }</c>.
/// Only acknowledged (or permanently rejected) events are removed from the local queue.
/// The server should deduplicate on eventId, since a lost response causes a resend.
/// </summary>
public sealed class TelemetryApiClient
{
    public const string HttpClientName = "telemetry-api";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly TelemetryApiOptions _options;
    private readonly DeviceIdentityService _identity;
    private readonly ILogger<TelemetryApiClient> _logger;

    public TelemetryApiClient(
        IHttpClientFactory httpClientFactory,
        IOptions<TelemetryApiOptions> options,
        DeviceIdentityService identity,
        ILogger<TelemetryApiClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options.Value;
        _identity = identity;
        _logger = logger;
    }

    public bool IsConfigured => Uri.TryCreate(_options.BaseUrl, UriKind.Absolute, out _);

    public async Task<UploadResult> SendBatchAsync(IReadOnlyList<QueuedEvent> batch, CancellationToken ct)
    {
        var body = BuildBatchBody(batch);
        using var request = new HttpRequestMessage(HttpMethod.Post, _options.BatchPath)
        {
            Content = CreateContent(body),
        };

        HttpResponseMessage response;
        try
        {
            response = await CreateClient().SendAsync(request, ct);
        }
        catch (HttpRequestException ex)
        {
            return UploadResult.Transient(ex.Message);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return UploadResult.Transient("Request timed out");
        }

        using (response)
        {
            var status = (int)response.StatusCode;
            if (response.IsSuccessStatusCode)
            {
                BatchAcknowledgement? ack = null;
                try
                {
                    ack = await response.Content.ReadFromJsonAsync<BatchAcknowledgement>(JsonDefaults.Options, ct);
                }
                catch (JsonException)
                {
                    // Handled below.
                }

                if (ack?.AcknowledgedEventIds is null)
                {
                    // Without an explicit acknowledgement we cannot know what was stored, so keep everything.
                    return UploadResult.Transient("Server returned success without an acknowledgement body", status);
                }

                return new UploadResult(
                    UploadOutcome.Success,
                    ack.AcknowledgedEventIds,
                    ack.RejectedEventIds ?? [],
                    StatusCode: status);
            }

            var retryAfter = GetRetryAfter(response);
            if (response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests || status >= 500)
            {
                return UploadResult.Transient($"HTTP {status}", status, retryAfter);
            }

            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                // A configuration problem, not a data problem: keep the data and retry later.
                _logger.LogError("Telemetry API rejected the agent credentials (HTTP {Status}); check TelemetryApi:ApiKey", status);
                return UploadResult.Transient($"HTTP {status}", status, retryAfter);
            }

            var detail = await SafeReadAsync(response, ct);
            return UploadResult.BatchRejected(status, detail);
        }
    }

    /// <summary>Lightweight reachability check used for connectivity metrics.</summary>
    public async Task<(bool Connected, long? ResponseTimeMs)> PingAsync(CancellationToken ct)
    {
        if (!IsConfigured)
        {
            return (false, null);
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(10));
        var sw = Stopwatch.StartNew();
        try
        {
            using var response = await CreateClient().GetAsync(_options.HealthPath, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            sw.Stop();
            return (response.IsSuccessStatusCode, sw.ElapsedMilliseconds);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return (false, null);
        }
    }

    /// <summary>
    /// Long-polls the server for on-demand requests (e.g. file browsing) for this device.
    /// Returns an empty list when nothing arrived within <paramref name="waitSeconds"/>.
    /// </summary>
    public async Task<IReadOnlyList<RemoteCommand>> PollCommandsAsync(int waitSeconds, CancellationToken ct)
    {
        using var response = await CreateClient().GetAsync($"api/agent/commands?wait={waitSeconds}", ct);
        if (response.StatusCode == HttpStatusCode.NoContent)
        {
            return [];
        }

        response.EnsureSuccessStatusCode();
        var batch = await response.Content.ReadFromJsonAsync<RemoteCommandBatch>(JsonDefaults.Options, ct);
        return batch?.Commands ?? [];
    }

    public async Task PostCommandResultAsync(string commandId, RemoteCommandResult result, CancellationToken ct)
    {
        using var content = CreateContent(JsonSerializer.Serialize(result, JsonDefaults.Options));
        using var response = await CreateClient().PostAsync($"api/agent/commands/{Uri.EscapeDataString(commandId)}/result", content, ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            // The requester already gave up (timeout); nothing to do.
            _logger.LogDebug("Result for request {Id} arrived after it expired", commandId);
            return;
        }

        response.EnsureSuccessStatusCode();
    }

    private HttpClient CreateClient() => _httpClientFactory.CreateClient(HttpClientName);

    private string BuildBatchBody(IReadOnlyList<QueuedEvent> batch)
    {
        var sb = new StringBuilder(batch.Sum(e => e.SizeBytes) + 256);
        sb.Append("{\"deviceId\":").Append(JsonSerializer.Serialize(_identity.DeviceId))
          .Append(",\"storeId\":").Append(JsonSerializer.Serialize(_identity.StoreId))
          .Append(",\"sentAt\":\"").Append(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"))
          .Append("\",\"events\":[");
        for (var i = 0; i < batch.Count; i++)
        {
            if (i > 0)
            {
                sb.Append(',');
            }

            // Stored events are already valid JSON objects.
            sb.Append(batch[i].Json);
        }

        return sb.Append("]}").ToString();
    }

    private HttpContent CreateContent(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        if (!_options.EnableGzip)
        {
            var plain = new ByteArrayContent(bytes);
            plain.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
            return plain;
        }

        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true))
        {
            gzip.Write(bytes);
        }

        var content = new ByteArrayContent(buffer.ToArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        content.Headers.ContentEncoding.Add("gzip");
        return content;
    }

    private static TimeSpan? GetRetryAfter(HttpResponseMessage response)
    {
        var retry = response.Headers.RetryAfter;
        if (retry?.Delta is { } delta)
        {
            return delta;
        }

        if (retry?.Date is { } date)
        {
            var wait = date - DateTimeOffset.UtcNow;
            return wait > TimeSpan.Zero ? wait : null;
        }

        return null;
    }

    private static async Task<string?> SafeReadAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            return text.Length > 500 ? text[..500] : text;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
