using Microsoft.Extensions.Options;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Models;
using PosMonitoringAgent.Services;

namespace PosMonitoringAgent.Workers;

/// <summary>
/// Answers on-demand requests from the central API (currently: browse/read files under the
/// locked FileAccess root). The agent long-polls the server, so stores need no inbound port:
/// a request typed in the dashboard reaches the POS within about a second.
/// </summary>
public sealed class RemoteCommandWorker(
    ILogger<RemoteCommandWorker> logger,
    IOptions<FileAccessOptions> fileOptions,
    IOptions<TelemetryApiOptions> apiOptions,
    TelemetryApiClient api,
    FileAccessService files) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!fileOptions.Value.Enabled)
        {
            logger.LogInformation("Remote file access is disabled (FileAccess:Enabled=false)");
            return;
        }

        if (!api.IsConfigured)
        {
            logger.LogInformation("Remote file access is idle: TelemetryApi:BaseUrl is not configured");
            return;
        }

        // The wait must finish well inside the HTTP timeout.
        var wait = Math.Clamp(fileOptions.Value.PollWaitSeconds, 1, Math.Max(1, apiOptions.Value.TimeoutSeconds - 5));
        logger.LogInformation("Remote file access ready for {Root}", files.Root);

        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var commands = await api.PollCommandsAsync(wait, stoppingToken);
                if (failures > 0)
                {
                    logger.LogInformation("Remote command channel reconnected");
                }

                failures = 0;
                foreach (var command in commands)
                {
                    var result = Execute(command);
                    await api.PostCommandResultAsync(command.Id, result, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                failures++;
                var delay = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Min(failures, 6))) + Random.Shared.NextDouble() * 2);
                if (failures == 1)
                {
                    logger.LogWarning("Remote command channel unavailable: {Error}. Retrying in the background.", ex.Message);
                }

                try
                {
                    await Task.Delay(delay, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    private RemoteCommandResult Execute(RemoteCommand command)
    {
        var result = command.Op switch
        {
            "files.browse" => files.Browse(command.Args),
            _ => RemoteCommandResult.Failure("unsupported", $"Unknown request '{command.Op}'."),
        };

        // Audit trail of every remote access on the POS itself.
        logger.LogInformation(
            "Remote {Op} '{Path}' -> {Outcome}",
            command.Op,
            command.Args?.Path ?? files.Root,
            result.Ok ? "ok" : result.Error?.Code);
        return result;
    }
}
