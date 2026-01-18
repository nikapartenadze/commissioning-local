using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Options;
using IO_Checkout_Tool.Models.Configuration;
using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Models.Entities;
using Shared.Library.Repositories.Interfaces;
using Shared.Library.DTOs;
using System.Net.Http.Json;
using System.Linq;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using System.Threading;
using System.Threading.Tasks;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Enhanced cloud sync service that combines real-time SignalR updates 
/// with offline queue for maximum reliability
/// </summary>
public class ResilientCloudSyncService : ICloudSyncService, IAsyncDisposable
{
    private readonly IHttpCloudClient _httpClient;
    private readonly ISignalRCloudClient _signalRClient;
    private readonly IConfigurationService _configService;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ResilientCloudSyncService> _logger;
    private readonly IErrorDialogService _errorDialogService;

    // Connection state management
    private string? _cloudUrl;
    private bool _isConnected = false;
    private bool _wasConnected = false; // Track previous state for reconnection detection
    private readonly SemaphoreSlim _connectionLock = new(1, 1);
    
    // Connection retry logic with backoff
    private DateTime _lastConnectionAttempt = DateTime.MinValue;
    private readonly TimeSpan _connectionRetryDelay = TimeSpan.FromSeconds(30);
    
    // Batch sync configuration - use defaults, can be made configurable later if needed
    private readonly int _batchSize = 50;
    private readonly int _batchDelayMs = 500;
    private readonly TimeSpan _connectionTimeout = TimeSpan.FromSeconds(30); // Increased for industrial/field environments
    
    // Offline queue management
    private readonly Queue<IoUpdateDto> _offlineQueue = new();
    private readonly object _queueLock = new();
    private Timer? _offlineProcessingTimer;
    private readonly TimeSpan _offlineProcessingInterval = TimeSpan.FromMinutes(1);

    // Connection status tracking
    public bool IsConnected => _isConnected && _signalRClient.IsConnected;
    public event Action? ConnectionStateChanged;

    public ResilientCloudSyncService(
        IHttpCloudClient httpClient,
        ISignalRCloudClient signalRClient,
        IConfigurationService configService,
        IServiceProvider serviceProvider,
        ILogger<ResilientCloudSyncService> logger,
        IErrorDialogService errorDialogService)
    {
        _httpClient = httpClient;
        _signalRClient = signalRClient;
        _configService = configService;
        _serviceProvider = serviceProvider;
        _logger = logger;
        _errorDialogService = errorDialogService;
        
        // Get fresh cloud URL from configuration service
        _cloudUrl = _configService.RemoteUrl;
        
        // Configure HttpClient for reasonable timeouts in industrial environments
        _httpClient.Timeout = TimeSpan.FromSeconds(30); // Increased from 5 seconds

        // Subscribe to SignalR connection state changes
        _signalRClient.ConnectionStateChanged += OnSignalRConnectionStateChanged;
    }

    private void OnSignalRConnectionStateChanged()
    {
        var wasConnected = _wasConnected;
        _wasConnected = _isConnected = _signalRClient.IsConnected;
        
        // If we transitioned from disconnected to connected, trigger pending sync
        if (!wasConnected && _isConnected)
        {
            _logger.LogInformation("SignalR reconnected, scheduling pending syncs...");
            // Delay sync attempt to ensure stable connection
            _ = Task.Run(async () =>
            {
                await Task.Delay(5000); // Wait 5 seconds for connection to stabilize
                _logger.LogInformation("Starting pending sync after reconnection delay");
                var syncedCount = await SyncPendingUpdatesAsync();
                _logger.LogInformation("Completed pending sync after reconnection: {Count} items synced", syncedCount);
            });
        }
        
        ConnectionStateChanged?.Invoke();
    }

    // Existing methods remain the same...
    public async Task<List<Io>> GetSubsystemIosAsync(int subsystemId)
    {
        // Get fresh cloud URL from configuration service
        var cloudUrl = _configService.RemoteUrl;
        if (string.IsNullOrEmpty(cloudUrl))
        {
            _logger.LogWarning("Cloud URL not configured");
            return new List<Io>();
        }

        try
        {
            // Add API key header if configured
            var headers = new Dictionary<string, string>();
            var apiPassword = _configService.ApiPassword;
            if (!string.IsNullOrEmpty(apiPassword))
            {
                headers["X-API-Key"] = apiPassword;
            }
            
            var response = await _httpClient.GetAsync($"{cloudUrl}/api/sync/subsystem/{subsystemId}", headers);
            
            // Check for authentication errors
            if (HandleAuthenticationError(response))
            {
                return new List<Io>();
            }
            
            if (response.IsSuccessStatusCode)
            {
                var syncResponse = await response.Content.ReadFromJsonAsync<SyncResponseDto>();
                return syncResponse?.Ios ?? new List<Io>();
            }
            
            _logger.LogError("Failed to get IOs from cloud: {StatusCode}", response.StatusCode);
            return new List<Io>();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting IOs from cloud");
            return new List<Io>();
        }
    }

    public async Task<bool> SyncIoUpdateAsync(IoUpdateDto update)
    {
        // If we know we're offline, queue immediately without blocking
        if (!_isConnected && DateTime.UtcNow - _lastConnectionAttempt < _connectionRetryDelay)
        {
            await AddToOfflineQueue(update);
            _logger.LogDebug("Queued IO {Id} for offline sync (connection unavailable)", update.Id);
            return false;
        }
        
        // Try real-time sync first
        var syncedInRealTime = await TryRealtimeSync(update);
        
        if (!syncedInRealTime)
        {
            // If real-time sync fails, add to offline queue
            await AddToOfflineQueue(update);
            _logger.LogInformation("Added IO {Id} to offline queue for later sync", update.Id);
        }
        
        return syncedInRealTime;
    }

    public async Task<bool> SyncIoUpdatesAsync(List<IoUpdateDto> updates)
    {
        // For small batches, try batch sync first
        if (updates.Count > 1 && updates.Count <= _batchSize)
        {
            if (await TryRealtimeBatchSync(updates))
            {
                _logger.LogInformation("Successfully batch synced {Count} updates", updates.Count);
                return true;
            }
            _logger.LogWarning("Batch sync failed, falling back to individual processing");
        }
        
        // Fall back to individual processing
        var successCount = 0;
        var failedUpdates = new List<IoUpdateDto>();

        // Try to sync each update
        foreach (var update in updates)
        {
            if (await TryRealtimeSync(update))
            {
                successCount++;
            }
            else
            {
                failedUpdates.Add(update);
            }
        }

        // Add failed updates to offline queue
        if (failedUpdates.Any())
        {
            foreach (var update in failedUpdates)
            {
                await AddToOfflineQueue(update);
            }
            _logger.LogInformation("Added {Count} failed updates to offline queue", failedUpdates.Count);
        }

        return successCount == updates.Count;
    }

    private async Task<bool> TryRealtimeSync(IoUpdateDto update)
    {
        _logger.LogInformation("=== TryRealtimeSync starting for IO {Id} ===", update.Id);
        
        // Quick check if we're offline - don't attempt connection
        if (!_isConnected && DateTime.UtcNow - _lastConnectionAttempt < _connectionRetryDelay)
        {
            _logger.LogDebug("Skipping SignalR sync for IO {Id} - offline", update.Id);
            return false;
        }
        
        // First try SignalR
        if (await EnsureConnectionAsync())
        {
            try
            {
                _logger.LogInformation("SignalR connection available, attempting to send update...");
                
                _logger.LogInformation("Invoking UpdateIO on hub with: Id={Id}, Result={Result}, State={State}", 
                    update.Id, update.Result, update.State);
                await _signalRClient.InvokeAsync("UpdateIO", update);
                _logger.LogInformation("Successfully synced IO {Id} via SignalR", update.Id);
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "SignalR sync failed for IO {Id}", update.Id);
            }
        }
        else
        {
            _logger.LogWarning("SignalR connection not available for IO {Id}", update.Id);
        }

        // Fallback to HTTP (also with quick timeout)
        _logger.LogInformation("Falling back to HTTP for IO {Id}", update.Id);
        try
        {
            // Get fresh cloud URL for HTTP fallback
            var cloudUrl = _configService.RemoteUrl;
            if (string.IsNullOrEmpty(cloudUrl))
            {
                _logger.LogWarning("Cloud URL not configured for HTTP fallback");
                return false;
            }
            
            var batch = new IoSyncBatchDto { Updates = new List<IoUpdateDto> { update } };
            
            // Use cancellation token for HTTP timeout too
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            
            // Add API key header if configured
            var headers = new Dictionary<string, string>();
            var apiPassword = _configService.ApiPassword;
            if (!string.IsNullOrEmpty(apiPassword))
            {
                headers["X-API-Key"] = apiPassword;
            }
            
            var response = await _httpClient.PostAsync($"{cloudUrl}/api/sync/update", JsonContent.Create(batch), headers, cts.Token);
            
            // Check for authentication errors
            if (HandleAuthenticationError(response))
            {
                return false;
            }
            
            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Successfully synced IO {Id} via HTTP", update.Id);
                return true;
            }
            
            _logger.LogError("HTTP sync failed for IO {Id}: {StatusCode}", update.Id, response.StatusCode);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "HTTP sync failed for IO {Id}", update.Id);
        }

        return false;
    }

    private async Task AddToOfflineQueue(IoUpdateDto update)
    {
        using var scope = _serviceProvider.CreateScope();
        var pendingSyncRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        
        // Don't check for existing syncs - preserve all state changes
        // This ensures complete test history is synced to the cloud
        
        var pendingSync = new PendingSync
        {
            IoId = update.Id,
            InspectorName = update.TestedBy,
            TestResult = update.Result,
            Comments = update.Comments,
            State = update.State,
            Version = update.Version,
            Timestamp = DateTime.TryParse(update.Timestamp, out var ts) ? ts : (DateTime?)null,
            CreatedAt = DateTime.UtcNow,
            RetryCount = 0
        };
        
        await pendingSyncRepo.AddPendingSyncAsync(pendingSync);
        _logger.LogInformation("Added IO {Id} state change to offline queue with version {Version}", update.Id, update.Version);
    }

    /// <summary>
    /// Sync pending updates with version conflict handling for pre-nuclear sync
    /// </summary>
    public async Task<int> SyncPendingUpdatesWithVersionControl()
    {
        using var scope = _serviceProvider.CreateScope();
        var pendingSyncRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        var ioRepository = scope.ServiceProvider.GetRequiredService<IIoRepository>();
        
        var pendingSyncs = await pendingSyncRepo.GetAllPendingSyncsAsync();
        if (!pendingSyncs.Any())
        {
            return 0;
        }

        _logger.LogInformation("Pre-nuclear sync: Found {Count} pending syncs", pendingSyncs.Count);
        
        // Sort by CreatedAt to maintain chronological order of state changes
        pendingSyncs = pendingSyncs.OrderBy(p => p.CreatedAt).ToList();
        
        var totalSynced = 0;
        var rejectedIds = new List<int>();
        var successfulIds = new List<int>();
        
        // Check each pending sync for version conflicts before attempting sync
        foreach (var pending in pendingSyncs)
        {
            try
            {
                // Get current local IO to check version
                var localIo = await ioRepository.GetByIdAsync(pending.IoId);
                if (localIo == null)
                {
                    _logger.LogWarning("Local IO {IoId} not found for pending sync {PendingId}", pending.IoId, pending.Id);
                    rejectedIds.Add(pending.Id);
                    continue;
                }

                // Check version conflict rules
                if (pending.Version < localIo.Version)
                {
                    // Admin modified data - reject permanently
                    _logger.LogWarning("Version conflict detected for IO {IoId}: pending version {PendingVersion} < local version {LocalVersion}. Admin intervention detected - rejecting permanently.", 
                        pending.IoId, pending.Version, localIo.Version);
                    rejectedIds.Add(pending.Id);
                    continue;
                }
                else if (pending.Version > localIo.Version)
                {
                    // Anomaly - reject for safety
                    _logger.LogWarning("Version anomaly detected for IO {IoId}: pending version {PendingVersion} > local version {LocalVersion}. Rejecting for safety.", 
                        pending.IoId, pending.Version, localIo.Version);
                    rejectedIds.Add(pending.Id);
                    continue;
                }
                // If pending.Version == localIo.Version, proceed with sync

                // Convert to DTO for sync
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

                // Try to sync this update
                if (await TryRealtimeSync(update))
                {
                    successfulIds.Add(pending.Id);
                    totalSynced++;
                    _logger.LogDebug("Successfully synced pending IO {IoId} in pre-nuclear sync", pending.IoId);
                }
                else
                {
                    // Keep in queue for later retry
                    await pendingSyncRepo.UpdateRetryCountAsync(pending.Id, "Pre-nuclear sync failed - will retry later");
                    _logger.LogDebug("Failed to sync pending IO {IoId} in pre-nuclear sync - keeping in queue", pending.IoId);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Exception processing pending sync {PendingId} for IO {IoId}", pending.Id, pending.IoId);
                await pendingSyncRepo.UpdateRetryCountAsync(pending.Id, ex.Message);
            }
        }
        
        // Remove rejected items (version conflicts) from queue permanently
        if (rejectedIds.Any())
        {
            await pendingSyncRepo.RemovePendingSyncsAsync(rejectedIds);
            _logger.LogInformation("Pre-nuclear sync: Permanently rejected {Count} changes due to version conflicts (admin precedence)", rejectedIds.Count);
        }
        
        // Remove successfully synced items from queue
        if (successfulIds.Any())
        {
            await pendingSyncRepo.RemovePendingSyncsAsync(successfulIds);
            _logger.LogInformation("Pre-nuclear sync: Successfully synced and removed {Count} changes from queue", successfulIds.Count);
        }
        
        return totalSynced;
    }

    /// <summary>
    /// Called by background service to sync any queued updates
    /// </summary>
    public async Task<int> SyncPendingUpdatesAsync()
    {
        using var scope = _serviceProvider.CreateScope();
        var pendingSyncRepo = scope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        
        var pendingSyncs = await pendingSyncRepo.GetAllPendingSyncsAsync();
        if (!pendingSyncs.Any())
        {
            return 0;
        }

        _logger.LogInformation("Found {Count} pending syncs in offline queue", pendingSyncs.Count);
        
        // Sort by CreatedAt to maintain chronological order of state changes
        pendingSyncs = pendingSyncs.OrderBy(p => p.CreatedAt).ToList();
        
        var totalSynced = 0;
        var successfulIds = new List<int>();
        
        // Process in batches
        for (int i = 0; i < pendingSyncs.Count; i += _batchSize)
        {
            var batch = pendingSyncs.Skip(i).Take(_batchSize).ToList();
            _logger.LogInformation("Processing batch of {Count} pending syncs (batch {BatchNum}/{TotalBatches})", 
                batch.Count, (i / _batchSize) + 1, (pendingSyncs.Count + _batchSize - 1) / _batchSize);
            
            // Try batch sync first
            var batchSuccessIds = await TryBatchSync(batch, pendingSyncRepo);
            
            if (batchSuccessIds.Any())
            {
                successfulIds.AddRange(batchSuccessIds);
                totalSynced += batchSuccessIds.Count;
                _logger.LogInformation("Successfully synced {Count} items in batch", batchSuccessIds.Count);
            }
            
            // Small delay between batches to avoid overwhelming the server
            if (i + _batchSize < pendingSyncs.Count)
            {
                await Task.Delay(_batchDelayMs);
            }
        }
        
        // Remove all successfully synced items from queue
        if (successfulIds.Any())
        {
            await pendingSyncRepo.RemovePendingSyncsAsync(successfulIds);
            _logger.LogInformation("Removed {Count} successfully synced items from queue", successfulIds.Count);
        }
        
        return totalSynced;
    }
    
    private async Task<List<int>> TryBatchSync(List<PendingSync> batch, IPendingSyncRepository pendingSyncRepo)
    {
        // Convert batch to DTOs
        var updates = batch.Select(pending => new IoUpdateDto
        {
            Id = pending.IoId,
            TestedBy = pending.InspectorName,
            Result = pending.TestResult,
            Comments = pending.Comments,
            State = pending.State,
            Version = pending.Version,
            Timestamp = pending.Timestamp?.ToString("yyyy-MM-dd HH:mm:ss")
        }).ToList();
        
        // Try batch sync via SignalR or HTTP
        var batchSyncSuccess = await TryRealtimeBatchSync(updates);
        
        if (batchSyncSuccess)
        {
            // All items in batch succeeded
            return batch.Select(p => p.Id).ToList();
        }
        
        // Batch sync failed, fall back to individual sync
        _logger.LogWarning("Batch sync failed, falling back to individual sync for {Count} items", batch.Count);
        
        var successfulIds = new List<int>();
        foreach (var pending in batch)
        {
            var update = updates.First(u => u.Id == pending.IoId);
            
            try
            {
                if (await TryRealtimeSync(update))
                {
                    successfulIds.Add(pending.Id);
                    _logger.LogDebug("Successfully synced pending IO {IoId} individually", pending.IoId);
                }
                else
                {
                    await pendingSyncRepo.UpdateRetryCountAsync(pending.Id, "Individual sync failed after batch failure");
                    _logger.LogWarning("Failed to sync pending IO {IoId} individually", pending.IoId);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Exception syncing pending IO {IoId} individually", pending.IoId);
                await pendingSyncRepo.UpdateRetryCountAsync(pending.Id, ex.Message);
            }
            
            // Small delay between individual syncs
            await Task.Delay(100);
        }
        
        return successfulIds;
    }
    
    private async Task<bool> TryRealtimeBatchSync(List<IoUpdateDto> updates)
    {
        _logger.LogInformation("Attempting batch sync for {Count} updates", updates.Count);
        
        // Quick check if we're offline
        if (!_isConnected && DateTime.UtcNow - _lastConnectionAttempt < _connectionRetryDelay)
        {
            _logger.LogDebug("Skipping batch sync - offline");
            return false;
        }
        
        // First try SignalR
        if (await EnsureConnectionAsync())
        {
            try
            {
                _logger.LogInformation("SignalR connection available, attempting batch send...");
                
                await _signalRClient.InvokeAsync("SyncMultipleIOs", updates);
                _logger.LogInformation("Successfully batch synced {Count} IOs via SignalR", updates.Count);
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "SignalR batch sync failed");
            }
        }
        
        // Fallback to HTTP batch
        _logger.LogInformation("Falling back to HTTP batch sync");
        try
        {
            // Get fresh cloud URL for HTTP batch fallback
            var cloudUrl = _configService.RemoteUrl;
            if (string.IsNullOrEmpty(cloudUrl))
            {
                _logger.LogWarning("Cloud URL not configured for HTTP batch fallback");
                return false;
            }
            
            var batch = new IoSyncBatchDto { Updates = updates };
            
            // Use cancellation token for HTTP timeout
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20)); // Longer timeout for batch
            
            // Add API key header if configured
            var headers = new Dictionary<string, string>();
            var apiPassword = _configService.ApiPassword;
            if (!string.IsNullOrEmpty(apiPassword))
            {
                headers["X-API-Key"] = apiPassword;
            }
            
            var response = await _httpClient.PostAsync($"{cloudUrl}/api/sync/update", JsonContent.Create(batch), headers, cts.Token);
            
            // Check for authentication errors
            if (HandleAuthenticationError(response))
            {
                return false;
            }
            
            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Successfully batch synced {Count} IOs via HTTP", updates.Count);
                return true;
            }
            
            _logger.LogError("HTTP batch sync failed: {StatusCode}", response.StatusCode);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "HTTP batch sync failed");
        }
        
        return false;
    }

    public async Task<bool> IsCloudAvailable()
    {
        // Get fresh cloud URL from configuration service
        var cloudUrl = _configService.RemoteUrl;
        if (string.IsNullOrEmpty(cloudUrl))
        {
            return false;
        }

        // First try a simple HTTP health check - this is more reliable for determining basic availability
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var response = await _httpClient.GetAsync($"{cloudUrl}/api/sync/health", cts.Token);
            
            if (response.IsSuccessStatusCode)
            {
                // If HTTP health check passes, try SignalR connection
                return await EnsureConnectionAsync();
            }
            
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Cloud health check failed for {CloudUrl}", cloudUrl);
            return false;
        }
    }

    private async Task<bool> EnsureConnectionAsync()
    {
        // Get fresh cloud URL from configuration service
        var cloudUrl = _configService.RemoteUrl;
        if (string.IsNullOrEmpty(cloudUrl))
        {
            _isConnected = false;
            return false;
        }
        
        // Update cached cloud URL if it changed
        _cloudUrl = cloudUrl;

        // Quick check if already connected
        if (_signalRClient.IsConnected)
        {
            if (!_isConnected)
            {
                _isConnected = true;
                ConnectionStateChanged?.Invoke();
            }
            return true;
        }

        // Don't retry too frequently
        if (!_isConnected && DateTime.UtcNow - _lastConnectionAttempt < _connectionRetryDelay)
        {
            return false;
        }

        await _connectionLock.WaitAsync();
        try
        {
            _lastConnectionAttempt = DateTime.UtcNow;
            
            // Double-check after acquiring lock
            if (_signalRClient.IsConnected)
            {
                if (!_isConnected)
                {
                    _isConnected = true;
                    ConnectionStateChanged?.Invoke();
                }
                return true;
            }

            // Ensure we start with disconnected state
            if (_isConnected)
            {
                _isConnected = false;
                ConnectionStateChanged?.Invoke();
            }

            // Use cancellation token for quick timeout when offline
            using var cts = new CancellationTokenSource(_connectionTimeout);
            var apiPassword = _configService.ApiPassword;
            var connected = await _signalRClient.ConnectAsync(cloudUrl, apiPassword, cts.Token);
            
            if (connected)
            {
                _isConnected = true;
                ConnectionStateChanged?.Invoke();
                _logger.LogInformation("SignalR connection established to {CloudUrl}", _cloudUrl);
                return true;
            }

            return false;
        }
        catch (Exception ex)
        {
            _isConnected = false;
            ConnectionStateChanged?.Invoke();
            _logger.LogDebug(ex, "Failed to establish SignalR connection to {CloudUrl}", _cloudUrl);
            return false;
        }
        finally
        {
            _connectionLock.Release();
        }
    }

    public async Task ForceReconnectAsync()
    {
        _logger.LogInformation("Forcing SignalR reconnection for configuration change...");
        
        await _connectionLock.WaitAsync();
        try
        {
            // Disconnect existing connection
            _logger.LogInformation("Disconnecting existing SignalR connection...");
            _isConnected = false;
            ConnectionStateChanged?.Invoke();
            await _signalRClient.DisconnectAsync();
            
            // Reset connection state
            _lastConnectionAttempt = DateTime.MinValue;
            _logger.LogInformation("SignalR connection state reset - will reconnect with new configuration on next use");
        }
        finally
        {
            _connectionLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _signalRClient.DisposeAsync();
        _connectionLock?.Dispose();
    }

    public async Task<bool> TriggerFreshSyncAsync()
    {
        _logger.LogInformation("Triggering fresh sync from remote database with pre-nuclear sync pattern...");
        
        try
        {
            if (string.IsNullOrEmpty(_cloudUrl))
            {
                _logger.LogWarning("Cloud URL not configured - cannot sync");
                return false;
            }

            // Get fresh configuration values from configuration service
            var cloudUrl = _configService.RemoteUrl;
            if (string.IsNullOrEmpty(cloudUrl))
            {
                _logger.LogWarning("Remote URL not configured - cannot sync");
                return false;
            }
            
            // Update cached cloud URL
            _cloudUrl = cloudUrl;

            // Check if cloud is available
            _logger.LogInformation("Checking cloud availability at {CloudUrl}...", _cloudUrl);
            var isAvailable = await IsCloudAvailable();
            if (!isAvailable)
            {
                _logger.LogWarning("Cloud service is not available at {RemoteUrl}", _cloudUrl);
                return false;
            }

            _logger.LogInformation("Cloud service is available, starting pre-nuclear sync...");

            // STEP 1: Pre-Nuclear Sync - Attempt to sync all pending local changes first
            _logger.LogInformation("Pre-nuclear sync: Attempting to sync pending local changes...");
            
            // Check if we have pending changes and ensure we can actually sync them
            using var preSyncScope = _serviceProvider.CreateScope();
            var pendingSyncRepo = preSyncScope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
            var pendingCount = await pendingSyncRepo.GetPendingSyncCountAsync();
            
            if (pendingCount > 0)
            {
                _logger.LogInformation("Found {Count} pending changes, attempting to preserve them before nuclear sync", pendingCount);
                
                // Try to sync pending changes - abort nuclear sync if this fails due to connectivity
                try
                {
                    var pendingSyncCount = await SyncPendingUpdatesWithVersionControl();
                    _logger.LogInformation("Pre-nuclear sync completed: {Count} changes synced, remaining rejected due to version conflicts", pendingSyncCount);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Pre-nuclear sync failed due to connectivity issues - aborting nuclear sync to preserve local work");
                    return false;
                }
                
                // Double-check cloud is still available after pre-sync attempts
                if (!await IsCloudAvailable())
                {
                    _logger.LogWarning("Cloud became unavailable during pre-nuclear sync - aborting nuclear sync to preserve remaining local work");
                    return false;
                }
            }
            else
            {
                _logger.LogInformation("No pending changes to preserve, proceeding directly to nuclear sync");
            }

            // STEP 2: Nuclear Sync - Pull fresh authoritative data from cloud
            _logger.LogInformation("Nuclear sync: Fetching fresh IOs from cloud...");
            var subsystemId = int.Parse(_configService.SubsystemId);
            _logger.LogInformation("Using subsystem ID {SubsystemId} from fresh configuration", subsystemId);
            
            var cloudIos = await GetSubsystemIosAsync(subsystemId);
            
            if (!cloudIos.Any())
            {
                _logger.LogWarning("No IOs retrieved from cloud for subsystem {SubsystemId}", subsystemId);
                return false;
            }

            _logger.LogInformation("Retrieved {Count} IOs from cloud, syncing to local database...", cloudIos.Count);

            // Sync cloud IOs to local database
            using var scope = _serviceProvider.CreateScope();
            var ioRepository = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            var success = await SyncCloudIosToLocal(cloudIos, ioRepository, subsystemId);
            
            if (success)
            {
                // Notify PlcCommunicationService to reload data with new tag definitions
                var plcCommService = _serviceProvider.GetService<IPlcCommunicationService>();
                if (plcCommService != null)
                {
                    _logger.LogInformation("Notifying PlcCommunicationService to reload data after fresh cloud sync");
                    await plcCommService.ReloadDataAfterCloudSyncAsync();
                    
                    // Log the final result
                    var finalTagCount = plcCommService.TagList.Count;
                    _logger.LogInformation("PlcCommunicationService reload completed - {TagCount} IOs now available for UI", finalTagCount);
                }
                
                _logger.LogInformation("Fresh sync from remote database completed successfully with pre-nuclear sync pattern");
                return true;
            }
            
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during fresh cloud sync");
            return false;
        }
    }

    private async Task<bool> SyncCloudIosToLocal(List<Io> cloudIos, IIoRepository ioRepository, int subsystemId)
    {
        try
        {
            _logger.LogInformation("Starting fresh sync of {Count} cloud IOs to local database for subsystem {SubsystemId}", cloudIos.Count, subsystemId);
            
            // Clear all existing data since tool only works with one subsystem at a time
            await ClearAllLocalData(ioRepository);
            
            var addedCount = 0;
            
            // Add all IOs from cloud for the new subsystem with ALL authoritative data preserved
            foreach (var cloudIo in cloudIos)
            {
                if (string.IsNullOrEmpty(cloudIo.Name) || cloudIo.Id <= 0) continue;

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
                await ioRepository.AddWithSpecificIdAsync(newIo);
                addedCount++;
                _logger.LogDebug("Added IO: {Name} (ID: {Id}) with cloud data - Result: {Result}, Version: {Version}", 
                    cloudIo.Name, cloudIo.Id, cloudIo.Result ?? "null", cloudIo.Version);
            }

            _logger.LogInformation("Completed fresh sync to local database. Added: {AddedCount} IOs for subsystem {SubsystemId}", 
                addedCount, subsystemId);
            
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during fresh sync of cloud IOs to local database");
            return false;
        }
    }

    private async Task ClearAllLocalData(IIoRepository ioRepository)
    {
        try
        {
            _logger.LogInformation("Clearing all existing local data...");
            
            var allLocalIos = await ioRepository.GetAllAsync();
            
            if (!allLocalIos.Any())
            {
                _logger.LogInformation("No existing local data to clear");
                return;
            }
            
            _logger.LogInformation("Found {Count} existing IOs to clear", allLocalIos.Count);
            
            foreach (var ioToDelete in allLocalIos)
            {
                if (ioToDelete.Id <= 0) continue;
                
                try
                {
                    await DeleteIoWithRelatedData(ioToDelete.Id);
                    _logger.LogDebug("Cleared IO: {Name} (ID: {Id})", ioToDelete.Name, ioToDelete.Id);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to clear IO {Id} ({Name})", ioToDelete.Id, ioToDelete.Name);
                }
            }
            
            _logger.LogInformation("Completed clearing all existing local data");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error clearing existing local data");
        }
    }

    private async Task DeleteIoWithRelatedData(int ioId)
    {
        // Use a new scope for each deletion to avoid transaction conflicts
        using var deleteScope = _serviceProvider.CreateScope();
        var deleteIoRepo = deleteScope.ServiceProvider.GetRequiredService<IIoRepository>();
        var deleteHistoryRepo = deleteScope.ServiceProvider.GetRequiredService<ITestHistoryRepository>();
        var deletePendingRepo = deleteScope.ServiceProvider.GetRequiredService<IPendingSyncRepository>();
        
        // Delete related test history first
        await deleteHistoryRepo.DeleteByIoIdAsync(ioId);
        
        // Remove any pending syncs for this IO
        var pendingSyncs = await deletePendingRepo.GetAllPendingSyncsAsync();
        var syncsToRemove = pendingSyncs.Where(ps => ps.IoId == ioId)
            .Select(ps => ps.Id).ToList();
        
        if (syncsToRemove.Any())
        {
            await deletePendingRepo.RemovePendingSyncsAsync(syncsToRemove);
        }
        
        // Delete the IO itself
        await deleteIoRepo.DeleteAsync(ioId);
    }

    private bool HandleAuthenticationError(HttpResponseMessage response)
    {
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            _logger.LogError("Authentication failed - invalid API password");
            _errorDialogService.ShowAuthenticationError();
            return true;
        }
        return false;
    }
} 