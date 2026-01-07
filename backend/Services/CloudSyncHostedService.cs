using Microsoft.Extensions.Hosting;
using IO_Checkout_Tool.Services.Interfaces;
using Microsoft.Extensions.Options;
using IO_Checkout_Tool.Models.Configuration;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;
using Shared.Library.Repositories.Interfaces;
using Shared.Library.DTOs;
using Microsoft.Data.Sqlite;

namespace IO_Checkout_Tool.Services;

public class CloudSyncHostedService : IHostedService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly IConfigurationService _configService;
    private readonly IStartupCoordinationService _startupCoordination;
    private readonly ILogger<CloudSyncHostedService> _logger;

    public CloudSyncHostedService(
        IServiceProvider serviceProvider,
        IConfigurationService configService,
        IStartupCoordinationService startupCoordination,
        ILogger<CloudSyncHostedService> logger)
    {
        _serviceProvider = serviceProvider;
        _configService = configService;
        _startupCoordination = startupCoordination;
        _logger = logger;
    }

    /// <summary>
    /// Executes a database operation with retry logic for SQLite busy errors
    /// </summary>
    private async Task<T> ExecuteWithRetryAsync<T>(Func<Task<T>> operation, string operationName, int maxRetries = 3)
    {
        for (int attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                return await operation();
            }
            catch (SqliteException ex) when (ex.SqliteErrorCode == 5 && attempt < maxRetries) // SQLITE_BUSY
            {
                var delay = TimeSpan.FromMilliseconds(100 * Math.Pow(2, attempt - 1)); // Exponential backoff
                _logger.LogWarning("Database busy on attempt {Attempt} for {Operation}, retrying in {Delay}ms", 
                    attempt, operationName, delay.TotalMilliseconds);
                await Task.Delay(delay);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed {Operation} on attempt {Attempt}", operationName, attempt);
                if (attempt == maxRetries)
                    throw;
            }
        }
        throw new InvalidOperationException($"Failed to execute {operationName} after {maxRetries} attempts");
    }

    /// <summary>
    /// Executes a database operation with retry logic for SQLite busy errors (void return)
    /// </summary>
    private async Task ExecuteWithRetryAsync(Func<Task> operation, string operationName, int maxRetries = 3)
    {
        await ExecuteWithRetryAsync(async () =>
        {
            await operation();
            return true;
        }, operationName, maxRetries);
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("CloudSyncHostedService starting...");
        
        try
        {
            // Get fresh configuration values that update when config changes
            if (string.IsNullOrEmpty(_configService.RemoteUrl))
            {
                _logger.LogInformation("Cloud sync disabled - no remote URL configured");
                // No cloud sync needed, let PlcInitializationHostedService handle initialization
                return;
            }

            _logger.LogInformation("Starting cloud sync for subsystem {SubsystemId} from {RemoteUrl}", 
                _configService.SubsystemId, _configService.RemoteUrl);

            using var scope = _serviceProvider.CreateScope();
            var cloudSyncService = scope.ServiceProvider.GetRequiredService<ICloudSyncService>();
            var ioRepository = scope.ServiceProvider.GetRequiredService<IIoRepository>();

            // Check if cloud is available
            _logger.LogInformation("Checking cloud availability...");
            var isAvailable = await cloudSyncService.IsCloudAvailable();
            if (!isAvailable)
            {
                _logger.LogError("Cloud service is not available at {RemoteUrl}. Cannot sync required subsystem data.", 
                    _configService.RemoteUrl);
                
                // Show error to user - do NOT proceed with PLC initialization
                await ShowCloudUnavailableError();
                _startupCoordination.SignalStartupFailed();
                return;
            }

            _logger.LogInformation("Cloud service is available, starting pre-nuclear sync for startup...");

            // STEP 1: Pre-Nuclear Sync - Check for pending changes from previous session
            var pendingSyncRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingCount = await pendingSyncRepo.GetPendingSyncCountAsync();
            
            if (pendingCount > 0)
            {
                _logger.LogInformation("Found {Count} pending changes from previous session, attempting to preserve them before startup sync", pendingCount);
                
                // Try to sync pending changes using version control logic
                try
                {
                    if (cloudSyncService is ResilientCloudSyncService resilientService)
                    {
                        var syncedCount = await resilientService.SyncPendingUpdatesWithVersionControl();
                        _logger.LogInformation("Startup pre-sync completed: {Count} changes synced, remaining rejected due to version conflicts", syncedCount);
                    }
                    else
                    {
                        // Fallback for other sync service implementations
                        _logger.LogWarning("CloudSyncService is not ResilientCloudSyncService - attempting basic pending sync");
                        await AttemptBasicPendingSync(pendingSyncRepo, cloudSyncService);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to sync pending changes from previous session - proceeding with startup sync (some work may be lost)");
                }
                
                // Double-check cloud is still available after pre-sync attempts
                if (!await cloudSyncService.IsCloudAvailable())
                {
                    _logger.LogWarning("Cloud became unavailable during startup pre-sync - starting in offline mode to preserve remaining local work");
                    _startupCoordination.SignalStartupFailed();
                    return;
                }
            }
            else
            {
                _logger.LogInformation("No pending changes from previous session found, proceeding directly to startup sync");
            }

            // STEP 2: Nuclear Sync - Get fresh authoritative cloud data
            _logger.LogInformation("Startup nuclear sync: Fetching fresh IOs from cloud...");
            
            // Get IOs from cloud using fresh configuration
            var subsystemId = int.Parse(_configService.SubsystemId);
            var cloudIos = await cloudSyncService.GetSubsystemIosAsync(subsystemId);
            if (cloudIos.Any())
            {
                _logger.LogInformation("Retrieved {Count} IOs from cloud", cloudIos.Count);
                
                // Sync cloud IOs to local database
                await SyncCloudIosToLocal(cloudIos, ioRepository);
                
                // Notify PlcInitializationService to initialize PLC with correct data
                try
                {
                    // Small delay to ensure services are ready
                    await Task.Delay(500);
                    
                    var plcInitService = _serviceProvider.GetService<IPlcInitializationService>();
                    if (plcInitService != null)
                    {
                        _logger.LogInformation("Triggering PLC initialization after cloud sync completion");
                        var initSuccess = await plcInitService.InitializePlcAfterCloudSync();
                        if (initSuccess)
                        {
                            _logger.LogInformation("PLC initialization completed successfully after cloud sync");
                            _startupCoordination.SignalStartupComplete();
                        }
                        else
                        {
                            _logger.LogWarning("PLC initialization failed after cloud sync");
                            _startupCoordination.SignalStartupFailed();
                        }
                    }
                    else
                    {
                        // Fallback to old method if PlcInitializationService is not available
                        var plcCommService = _serviceProvider.GetService<IPlcCommunicationService>();
                        if (plcCommService != null)
                        {
                            _logger.LogInformation("Fallback: Notifying PlcCommunicationService to reload data after cloud sync");
                            await plcCommService.ReloadDataAsync();
                            _startupCoordination.SignalStartupComplete();
                        }
                        else
                        {
                            _startupCoordination.SignalStartupFailed();
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to initialize PLC after cloud sync");
                    _startupCoordination.SignalStartupFailed(ex);
                }
            }
            else
            {
                _logger.LogWarning("No IOs retrieved from cloud for subsystem {SubsystemId}", _configService.SubsystemId);
                _startupCoordination.SignalStartupFailed();
            }
            
            _logger.LogInformation("CloudSyncHostedService completed startup");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during cloud sync startup");
            _startupCoordination.SignalStartupFailed(ex);
        }
    }

    private async Task SyncCloudIosToLocal(List<Io> cloudIos, IIoRepository ioRepository)
    {
        _logger.LogInformation("Starting sync of {Count} cloud IOs to local database", cloudIos.Count);
        
        // Get fresh subsystem ID from configuration service
        var subsystemId = int.Parse(_configService.SubsystemId);
        
        // First, clear out all data from other subsystems since local tool can only test one subsystem at a time
        await ClearOtherSubsystemsData(subsystemId);
        
        var localIos = await ioRepository.GetBySubsystemIdAsync(subsystemId);
        var localIoDict = localIos.ToDictionary(io => io.Id, io => io);
        
        _logger.LogInformation("Found {Count} existing local IOs for subsystem {SubsystemId}", 
            localIos.Count, subsystemId);

        var addedCount = 0;
        var updatedCount = 0;
        var deletedCount = 0;
        
        // Create a set of cloud IO IDs for easy lookup
                        var cloudIoIds = new HashSet<int>(cloudIos.Where(io => io.Id > 0).Select(io => io.Id));

        // First, handle adds and updates
        foreach (var cloudIo in cloudIos)
        {
                            if (string.IsNullOrEmpty(cloudIo.Name) || cloudIo.Id <= 0) continue;

                            if (localIoDict.TryGetValue(cloudIo.Id, out var localIo))
            {
                // Update existing IO with ALL authoritative cloud data (cloud-authoritative system)
                localIo.Name = cloudIo.Name;
                localIo.Description = cloudIo.Description;
                localIo.Order = cloudIo.Order;
                localIo.Result = cloudIo.Result; // Cloud data is authoritative
                localIo.Timestamp = cloudIo.Timestamp; // Cloud data is authoritative
                localIo.Comments = cloudIo.Comments; // Cloud data is authoritative
                localIo.Version = cloudIo.Version; // Cloud data is authoritative
                await ExecuteWithRetryAsync(
                    () => ioRepository.UpdateAsync(localIo),
                    $"Update IO {cloudIo.Id}");
                updatedCount++;
                _logger.LogDebug("Updated IO: {Name} (ID: {Id}) with authoritative cloud data - Result: {Result}, Version: {Version}", 
                    cloudIo.Name, cloudIo.Id, cloudIo.Result ?? "null", cloudIo.Version);
                
                // Remove from dictionary to track what's left for deletion
                                    localIoDict.Remove(cloudIo.Id);
            }
            else
            {
                // Add new IO from cloud with ALL authoritative cloud data
                var newIo = new Io
                {
                    Id = cloudIo.Id,  // Preserve the cloud's ID
                    SubsystemId = subsystemId,
                    Name = cloudIo.Name,
                    Description = cloudIo.Description,
                    Order = cloudIo.Order,
                    Result = cloudIo.Result, // Preserve authoritative cloud result
                    Timestamp = cloudIo.Timestamp, // Preserve authoritative cloud timestamp
                    Comments = cloudIo.Comments, // Preserve authoritative cloud comments
                    Version = cloudIo.Version // Preserve authoritative cloud version
                    // State should not be initialized here - only by PLC reads
                };
                await ExecuteWithRetryAsync(
                    () => ioRepository.AddWithSpecificIdAsync(newIo),
                    $"Add IO {cloudIo.Id}");
                addedCount++;
                _logger.LogDebug("Added IO: {Name} (ID: {Id}) with cloud data - Result: {Result}, Version: {Version}", 
                    cloudIo.Name, cloudIo.Id, cloudIo.Result ?? "null", cloudIo.Version);
            }
        }
        
        // Now handle deletions - anything left in localIoDict doesn't exist in cloud
        if (localIoDict.Any())
        {
            _logger.LogInformation("Found {Count} IOs that exist locally but not in cloud, removing them", localIoDict.Count);
            
            foreach (var ioToDelete in localIoDict.Values)
            {
                try
                {
                    _logger.LogInformation("Deleting IO: {Name} (ID: {Id}) - no longer exists in cloud", 
                        ioToDelete.Name, ioToDelete.Id);
                    
                    if (ioToDelete.Id <= 0) continue;
                    
                    // Create a new scope for each deletion to avoid transaction conflicts
                    using var deleteScope = _serviceProvider.CreateScope();
                    var deleteIoRepo = deleteScope.ServiceProvider.GetRequiredService<IIoRepository>();
                    var deleteHistoryRepo = deleteScope.ServiceProvider.GetRequiredService<ITestHistoryRepository>();
                    var deletePendingRepo = deleteScope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
                    
                    try
                    {
                        // Delete related test history first
                        await ExecuteWithRetryAsync(
                            () => deleteHistoryRepo.DeleteByIoIdAsync(ioToDelete.Id),
                            $"Delete test history for IO {ioToDelete.Id}");
                        _logger.LogDebug("Deleted test history for IO {Id}", ioToDelete.Id);
                        
                        // Remove any pending syncs for this IO
                        await ExecuteWithRetryAsync(async () =>
                        {
                            var pendingSyncs = await deletePendingRepo.GetAllPendingSyncsAsync();
                            var syncsToRemove = pendingSyncs.Where(ps => ps.IoId == ioToDelete.Id)
                                .Select(ps => ps.Id).ToList();
                            
                            if (syncsToRemove.Any())
                            {
                                await deletePendingRepo.RemovePendingSyncsAsync(syncsToRemove);
                                _logger.LogDebug("Removed {Count} pending syncs for IO {Id}", syncsToRemove.Count, ioToDelete.Id);
                            }
                        }, $"Delete pending syncs for IO {ioToDelete.Id}");
                        
                        // Delete the IO itself
                        await ExecuteWithRetryAsync(
                            () => deleteIoRepo.DeleteAsync(ioToDelete.Id),
                            $"Delete IO {ioToDelete.Id}");
                        deletedCount++;
                        
                        _logger.LogDebug("Successfully deleted IO {Id} ({Name})", ioToDelete.Id, ioToDelete.Name);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Failed to delete IO {Id} ({Name})", ioToDelete.Id, ioToDelete.Name);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to delete IO {Id} ({Name})", ioToDelete.Id, ioToDelete.Name);
                }
            }
        }

        _logger.LogInformation("Completed syncing IOs from cloud to local database. Added: {AddedCount}, Updated: {UpdatedCount}, Deleted: {DeletedCount}", 
            addedCount, updatedCount, deletedCount);
    }

    /// <summary>
    /// Clears all data from subsystems other than the current one, since local tool can only test one subsystem at a time
    /// </summary>
    private async Task ClearOtherSubsystemsData(int currentSubsystemId)
    {
        _logger.LogInformation("Clearing data from other subsystems (keeping only subsystem {CurrentSubsystemId})", currentSubsystemId);
        
        using var scope = _serviceProvider.CreateScope();
        var ioRepository = scope.ServiceProvider.GetRequiredService<IIoRepository>();
        var historyRepository = scope.ServiceProvider.GetRequiredService<ITestHistoryRepository>();
        var pendingSyncRepository = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        
        try
        {
            // Get all IOs that don't belong to the current subsystem
            var allIos = await ioRepository.GetAllAsync();
            var otherSubsystemIos = allIos.Where(io => io.SubsystemId != currentSubsystemId).ToList();
            
            if (!otherSubsystemIos.Any())
            {
                _logger.LogInformation("No data from other subsystems found to clear");
                return;
            }
            
            _logger.LogInformation("Found {Count} IOs from other subsystems to clear", otherSubsystemIos.Count);
            
            var clearedSubsystems = new HashSet<int>();
            
            foreach (var ioToDelete in otherSubsystemIos)
            {
                if (ioToDelete.Id <= 0) continue;
                
                clearedSubsystems.Add(ioToDelete.SubsystemId);
                
                try
                {
                    // Delete related test history first
                    await ExecuteWithRetryAsync(
                        () => historyRepository.DeleteByIoIdAsync(ioToDelete.Id),
                        $"Delete test history for IO {ioToDelete.Id} from subsystem {ioToDelete.SubsystemId}");
                    
                    // Remove any pending syncs for this IO
                    await ExecuteWithRetryAsync(async () =>
                    {
                        var pendingSyncs = await pendingSyncRepository.GetAllPendingSyncsAsync();
                        var syncsToRemove = pendingSyncs.Where(ps => ps.IoId == ioToDelete.Id)
                            .Select(ps => ps.Id).ToList();
                        
                        if (syncsToRemove.Any())
                        {
                            await pendingSyncRepository.RemovePendingSyncsAsync(syncsToRemove);
                        }
                    }, $"Delete pending syncs for IO {ioToDelete.Id} from subsystem {ioToDelete.SubsystemId}");
                    
                    // Delete the IO itself
                    await ExecuteWithRetryAsync(
                        () => ioRepository.DeleteAsync(ioToDelete.Id),
                        $"Delete IO {ioToDelete.Id} from subsystem {ioToDelete.SubsystemId}");
                    
                    _logger.LogDebug("Deleted IO {Id} ({Name}) from subsystem {SubsystemId}", 
                        ioToDelete.Id, ioToDelete.Name, ioToDelete.SubsystemId);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to delete IO {Id} ({Name}) from subsystem {SubsystemId}", 
                        ioToDelete.Id, ioToDelete.Name, ioToDelete.SubsystemId);
                }
            }
            
            _logger.LogInformation("Cleared data from {Count} other subsystems: [{SubsystemIds}]", 
                clearedSubsystems.Count, string.Join(", ", clearedSubsystems.OrderBy(x => x)));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error occurred while clearing other subsystems data");
        }
    }

    /// <summary>
    /// Fallback method to attempt basic pending sync when not using ResilientCloudSyncService
    /// </summary>
    private async Task AttemptBasicPendingSync(IPendingSyncRepository pendingSyncRepo, ICloudSyncService cloudSyncService)
    {
        try
        {
            var pendingSyncs = await pendingSyncRepo.GetAllPendingSyncsAsync();
            if (!pendingSyncs.Any()) return;
            
            _logger.LogInformation("Attempting basic pending sync for {Count} items", pendingSyncs.Count);
            
            var successfulIds = new List<int>();
            
            // Sort by CreatedAt to maintain chronological order
            var sortedSyncs = pendingSyncs.OrderBy(p => p.CreatedAt).ToList();
            
            foreach (var pending in sortedSyncs)
            {
                try
                {
                    // Convert to DTO
                    var update = new IoUpdateDto
                    {
                        Id = pending.IoId,
                        TestedBy = pending.InspectorName,
                        Result = pending.TestResult,
                        Comments = pending.Comments,
                        State = pending.State,
                        Version = pending.Version,
                        Timestamp = pending.Timestamp?.ToString("yyyy-MM-dd HH:mm:ss")
                    };
                    
                    // Try to sync
                    var success = await cloudSyncService.SyncIoUpdateAsync(update);
                    
                    if (success)
                    {
                        successfulIds.Add(pending.Id);
                        _logger.LogDebug("Successfully synced pending IO {IoId} during startup", pending.IoId);
                    }
                    else
                    {
                        // Could be version conflict or network issue - keep in queue for now
                        _logger.LogWarning("Failed to sync pending IO {IoId} during startup - keeping in queue", pending.IoId);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Exception syncing pending IO {IoId} during startup", pending.IoId);
                }
                
                // Small delay to avoid overwhelming the server
                await Task.Delay(100);
            }
            
            // Remove successfully synced items
            if (successfulIds.Any())
            {
                await pendingSyncRepo.RemovePendingSyncsAsync(successfulIds);
                _logger.LogInformation("Basic startup pre-sync: Successfully synced and removed {Count} items from queue", successfulIds.Count);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during basic pending sync fallback");
        }
    }

    /// <summary>
    /// Show error when cloud is unavailable and subsystem sync is required
    /// </summary>
    private async Task ShowCloudUnavailableError()
    {
        _logger.LogError("Cloud sync is required but cloud is unavailable. Application cannot proceed safely.");
        
        try
        {
            // Small delay to ensure services are ready
            await Task.Delay(500);
            
            // CRITICAL: Clear the loading state so the UI doesn't show infinite spinner
            var plcCommunicationService = _serviceProvider.GetService<IPlcCommunicationService>();
            if (plcCommunicationService != null)
            {
                // Force initialization to complete with no data since we can't get the correct subsystem data
                await plcCommunicationService.InitializeAsync();
                _logger.LogInformation("Cleared PLC loading state after cloud sync failure");
            }
            
            var errorDialogService = _serviceProvider.GetService<IErrorDialogService>();
            if (errorDialogService != null)
            {
                var configService = _serviceProvider.GetService<IConfigurationService>();
                var subsystemId = configService?.SubsystemId ?? "unknown";
                
                errorDialogService.ShowError(
                    "Cloud Server Required", 
                    $"<p><strong>Cannot connect to cloud server to sync subsystem data.</strong></p>" +
                    $"<br/>" +
                    $"<div style='background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 4px; padding: 12px; margin: 8px 0;'>" +
                    $"<p style='margin: 0 0 8px 0; color: #856404;'><strong>⚠️ Configuration Mismatch</strong></p>" +
                    $"<p style='margin: 0; color: #856404;'>Requires: <strong>Subsystem {subsystemId}</strong><br/>" +
                    $"Local database contains different subsystem data</p>" +
                    $"</div>" +
                    $"<p><strong>For safety, the application cannot proceed without the correct I/O definitions.</strong></p>" +
                    $"<br/>" +
                    $"<div style='background-color: #d1ecf1; border: 1px solid #bee5eb; border-radius: 4px; padding: 12px;'>" +
                    $"<p style='margin: 0 0 8px 0; color: #0c5460;'><strong>🔧 Recovery Options</strong></p>" +
                    $"<ul style='margin: 0; padding-left: 16px; color: #0c5460;'>" +
                    $"<li>Check your network connection</li>" +
                    $"<li>Verify cloud server is accessible</li>" +
                    $"<li><strong>Click the cloud sync button</strong> when connectivity is restored</li>" +
                    $"<li><strong>Edit configuration</strong> to trigger a fresh sync</li>" +
                    $"</ul>" +
                    $"<p style='margin: 8px 0 0 0; color: #0c5460; font-style: italic;'>The application will automatically retry connection every 30 seconds.</p>" +
                    $"</div>"
                );
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error showing cloud unavailable error dialog");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }
} 