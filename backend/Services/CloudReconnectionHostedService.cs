using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Background service that periodically attempts to reconnect to the cloud
/// without affecting local app performance
/// </summary>
public class CloudReconnectionHostedService : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<CloudReconnectionHostedService> _logger;
    private readonly TimeSpan _reconnectionInterval = TimeSpan.FromSeconds(30); // Try every 30 seconds
    private readonly TimeSpan _initialDelay = TimeSpan.FromSeconds(45); // Wait 45s on startup

    public CloudReconnectionHostedService(
        IServiceProvider serviceProvider,
        ILogger<CloudReconnectionHostedService> logger)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Cloud reconnection service starting...");
        
        // Initial delay to let the app fully start
        await Task.Delay(_initialDelay, stoppingToken);
        
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await AttemptCloudReconnection();
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Error during cloud reconnection attempt");
            }
            
            await Task.Delay(_reconnectionInterval, stoppingToken);
        }
        
        _logger.LogInformation("Cloud reconnection service stopped");
    }

    private async Task AttemptCloudReconnection()
    {
        using var scope = _serviceProvider.CreateScope();
        var cloudSyncService = scope.ServiceProvider.GetRequiredService<ICloudSyncService>();
        
        // Quick check if already connected
        if (cloudSyncService.IsConnected)
        {
            return; // Already connected, no need to do anything
        }
        
        _logger.LogDebug("Attempting background cloud reconnection...");
        
        // Attempt connection check (this will trigger reconnection if possible)
        var isAvailable = await cloudSyncService.IsCloudAvailable();
        
        if (isAvailable)
        {
            _logger.LogInformation("Cloud connection restored via background reconnection");
        }
        else
        {
            _logger.LogDebug("Background cloud reconnection attempt failed - will retry");
        }
    }
} 