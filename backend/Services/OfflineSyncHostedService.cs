using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Repositories.Interfaces;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Background service that periodically attempts to sync offline queue
/// </summary>
public class OfflineSyncHostedService : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<OfflineSyncHostedService> _logger;
    private readonly TimeSpan _checkIntervalWhenEmpty = TimeSpan.FromMinutes(1); // Check every minute when queue is empty
    private readonly TimeSpan _checkIntervalWhenPending = TimeSpan.FromSeconds(15); // Check every 15 seconds when items are pending
    private readonly TimeSpan _initialDelay = TimeSpan.FromSeconds(30); // Wait 30s on startup

    public OfflineSyncHostedService(
        IServiceProvider serviceProvider,
        ILogger<OfflineSyncHostedService> logger)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Offline sync service starting...");
        
        // Initial delay to let the app fully start
        await Task.Delay(_initialDelay, stoppingToken);
        
        while (!stoppingToken.IsCancellationRequested)
        {
            var delayTime = _checkIntervalWhenEmpty;
            
            try
            {
                var hasPendingItems = await ProcessPendingSyncs();
                
                // Use shorter interval if we have pending items
                if (hasPendingItems)
                {
                    delayTime = _checkIntervalWhenPending;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error processing pending syncs");
            }
            
            await Task.Delay(delayTime, stoppingToken);
        }
    }

    private async Task<bool> ProcessPendingSyncs()
    {
        using var scope = _serviceProvider.CreateScope();
        
        // Check if we have pending syncs
        var pendingSyncRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        var pendingCount = await pendingSyncRepo.GetPendingSyncCountAsync();
        
        if (pendingCount == 0)
        {
            return false;
        }
        
        _logger.LogInformation("Found {Count} items in offline sync queue", pendingCount);
        
        // Check if cloud is available
        var cloudSyncService = scope.ServiceProvider.GetRequiredService<ICloudSyncService>();
        var wasOffline = !await cloudSyncService.IsCloudAvailable();
        
        if (wasOffline)
        {
            _logger.LogInformation("Cloud not available, will retry later");
            return true; // Still have pending items
        }
        
        // Process the queue
        if (cloudSyncService is ResilientCloudSyncService resilientService)
        {
            _logger.LogInformation("Cloud is available, processing offline queue of {Count} items", pendingCount);
            var syncedCount = await resilientService.SyncPendingUpdatesAsync();
            _logger.LogInformation("Successfully synced {Count} items from offline queue", syncedCount);
            
            var remainingCount = await pendingSyncRepo.GetPendingSyncCountAsync();
            if (remainingCount > 0)
            {
                _logger.LogWarning("Still have {Count} items in offline queue after sync attempt", remainingCount);
                // Process again immediately if we still have items
                return true; // Still have pending items
            }
        }
        
        return false; // No pending items
    }
} 