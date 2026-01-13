using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Background service that handles PLC initialization.
/// Currently disabled on startup - initialization is triggered via UI configuration.
/// </summary>
public class PlcInitializationHostedService : BackgroundService
{
    private readonly ILogger<PlcInitializationHostedService> _logger;

    public PlcInitializationHostedService(
        IPlcInitializationService plcInitializationService,
        IStartupCoordinationService startupCoordination,
        ILogger<PlcInitializationHostedService> logger)
    {
        _logger = logger;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Skip automatic PLC initialization on startup
        // User configures connection via UI, which triggers initialization
        _logger.LogInformation("PLC initialization skipped on startup. Configure via UI.");
        return Task.CompletedTask;
    }
}
