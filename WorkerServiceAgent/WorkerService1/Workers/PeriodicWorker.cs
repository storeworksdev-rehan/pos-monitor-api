namespace PosMonitoringAgent.Workers;

/// <summary>
/// Runs <see cref="RunOnceAsync"/> on a fixed interval. A failed cycle is logged and the
/// next cycle still runs, so one bad collector can never stop the service.
/// </summary>
public abstract class PeriodicWorker(ILogger logger) : BackgroundService
{
    protected ILogger Logger { get; } = logger;

    protected abstract TimeSpan Interval { get; }

    /// <summary>Small random delay so all workers do not hit the disk at the same instant.</summary>
    protected virtual TimeSpan InitialDelay => TimeSpan.FromMilliseconds(Random.Shared.Next(500, 5000));

    protected abstract Task RunOnceAsync(CancellationToken ct);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = Interval < TimeSpan.FromSeconds(5) ? TimeSpan.FromSeconds(5) : Interval;
        Logger.LogInformation("{Worker} started, interval {Interval}", GetType().Name, interval);

        try
        {
            await Task.Delay(InitialDelay, stoppingToken);
            using var timer = new PeriodicTimer(interval);
            do
            {
                try
                {
                    await RunOnceAsync(stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Logger.LogError(ex, "{Worker} cycle failed", GetType().Name);
                }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal shutdown.
        }
    }
}
