using System.Net;
using Microsoft.Extensions.Options;
using PosMonitoringAgent.Collectors;
using PosMonitoringAgent.Configuration;
using PosMonitoringAgent.Services;
using PosMonitoringAgent.Workers;

const string ServiceName = "PosMonitoringAgent";

var builder = Host.CreateApplicationBuilder(args);

// Per-machine settings (store id, API key, ...) live outside the install folder so upgrades never overwrite them.
var machineSettings = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), ServiceName, "agentsettings.json");
builder.Configuration.AddJsonFile(machineSettings, optional: true, reloadOnChange: false);
builder.Configuration.AddEnvironmentVariables("POSAGENT_");
builder.Configuration.AddCommandLine(args);

builder.Services.AddWindowsService(o => o.ServiceName = ServiceName);

// Options
builder.Services.AddOptions<AgentOptions>()
    .Bind(builder.Configuration.GetSection(AgentOptions.SectionName))
    .Validate(o => !string.IsNullOrWhiteSpace(o.StoreId), "Agent:StoreId is required.")
    .Validate(o => o.Intervals.SystemMetricsSeconds >= 5 && o.Intervals.ApplicationHealthSeconds >= 5 &&
                   o.Intervals.ConnectivitySeconds >= 5 && o.Intervals.HeartbeatSeconds >= 5 &&
                   o.Intervals.LogCollectionSeconds >= 5 && o.Intervals.UploadSeconds >= 5,
              "Agent:Intervals values must be at least 5 seconds.")
    .ValidateOnStart();
builder.Services.AddOptions<TelemetryApiOptions>()
    .Bind(builder.Configuration.GetSection(TelemetryApiOptions.SectionName))
    .Validate(o => string.IsNullOrWhiteSpace(o.BaseUrl) || Uri.TryCreate(o.BaseUrl, UriKind.Absolute, out _),
              "TelemetryApi:BaseUrl must be an absolute URL.")
    .Validate(o => o.MaxBatchEvents > 0 && o.MaxBatchBytes > 0, "TelemetryApi batch limits must be positive.")
    .ValidateOnStart();
builder.Services.AddOptions<QueueOptions>()
    .Bind(builder.Configuration.GetSection(QueueOptions.SectionName))
    .Validate(o => o.MaxDatabaseSizeMB >= 10, "LocalQueue:MaxDatabaseSizeMB must be at least 10.")
    .ValidateOnStart();
builder.Services.AddOptions<PosApplicationOptions>().Bind(builder.Configuration.GetSection(PosApplicationOptions.SectionName));
builder.Services.AddOptions<SqlHealthOptions>().Bind(builder.Configuration.GetSection(SqlHealthOptions.SectionName));
builder.Services.AddOptions<EventLogOptions>().Bind(builder.Configuration.GetSection(EventLogOptions.SectionName));
builder.Services.AddOptions<FileAccessOptions>().Bind(builder.Configuration.GetSection(FileAccessOptions.SectionName));

// Core services
builder.Services.AddSingleton<DeviceIdentityService>();
builder.Services.AddSingleton<LocalQueueService>();
builder.Services.AddSingleton<TelemetryApiClient>();
builder.Services.AddSingleton<HealthSnapshotStore>();
builder.Services.AddSingleton<UploadStatus>();
builder.Services.AddSingleton<UploadTrigger>();
builder.Services.AddSingleton<FileAccessService>();

builder.Services.AddHttpClient(TelemetryApiClient.HttpClientName, (sp, client) =>
    {
        var api = sp.GetRequiredService<IOptions<TelemetryApiOptions>>().Value;
        var identity = sp.GetRequiredService<DeviceIdentityService>();
        if (Uri.TryCreate(api.BaseUrl, UriKind.Absolute, out var baseUri))
        {
            // Trailing slash so relative paths like "api/telemetry/batch" append instead of replacing the last segment.
            client.BaseAddress = new Uri(baseUri.AbsoluteUri.TrimEnd('/') + "/");
        }

        client.Timeout = TimeSpan.FromSeconds(Math.Max(5, api.TimeoutSeconds));
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"{ServiceName}/{identity.AgentVersion}");
        client.DefaultRequestHeaders.Add("X-Device-Id", identity.DeviceId);
        if (!string.IsNullOrWhiteSpace(api.ApiKey))
        {
            client.DefaultRequestHeaders.Add("X-Api-Key", api.ApiKey);
        }
    })
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        ConnectTimeout = TimeSpan.FromSeconds(15),
    });

// Collectors
builder.Services.AddSingleton<CpuCollector>();
builder.Services.AddSingleton<MemoryCollector>();
builder.Services.AddSingleton<DiskCollector>();
builder.Services.AddSingleton<NetworkCollector>();
builder.Services.AddSingleton<ProcessCollector>();
builder.Services.AddSingleton<SqlHealthCollector>();
builder.Services.AddSingleton<WindowsEventCollector>();
builder.Services.AddSingleton<PosLogFileCollector>();

// Workers
builder.Services.AddHostedService<HeartbeatWorker>();
builder.Services.AddHostedService<ApplicationHealthWorker>();
builder.Services.AddHostedService<SystemMetricsWorker>();
builder.Services.AddHostedService<LogCollectionWorker>();
builder.Services.AddHostedService<TelemetryUploadWorker>();
builder.Services.AddHostedService<RemoteCommandWorker>();

var host = builder.Build();
host.Run();
