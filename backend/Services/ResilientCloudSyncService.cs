using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
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
    private readonly HttpClient _httpClient;
    private readonly IConfigurationService _configService;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ResilientCloudSyncService> _logger;
    private readonly IErrorDialogService _errorDialogService;
    private readonly ISignalRService _signalRService;

    // Connection state management
    private string? _cloudUrl;
    private HubConnection? _hubConnection;
    private bool _isConnected = false;
    private readonly SemaphoreSlim _connectionLock = new(1, 1);
    
    // Connection retry logic with backoff
    private DateTime _lastConnectionAttempt = DateTime.MinValue;
    private readonly TimeSpan _connectionRetryDelay = TimeSpan.FromSeconds(30);
    
    // Batch sync configuration - use defaults, can be made configurable later if needed
    private readonly int _batchSize = 50;
    private readonly int _batchDelayMs = 500;
    private readonly TimeSpan _connectionTimeout = TimeSpan.FromSeconds(10); // Quick timeout - don't block Pull IOs
    
    // Offline queue management
    private readonly Queue<IoUpdateDto> _offlineQueue = new();
    private readonly object _queueLock = new();
    private Timer? _offlineProcessingTimer;
    private readonly TimeSpan _offlineProcessingInterval = TimeSpan.FromMinutes(1);

    // Connection status tracking
    public bool IsConnected => _isConnected && _hubConnection?.State == HubConnectionState.Connected;
    public event Action? ConnectionStateChanged;

    public ResilientCloudSyncService(
        HttpClient httpClient,
        IConfigurationService configService,
        IServiceProvider serviceProvider,
        ILogger<ResilientCloudSyncService> logger,
        IErrorDialogService errorDialogService,
        ISignalRService signalRService)
    {
        _httpClient = httpClient;
        _configService = configService;
        _serviceProvider = serviceProvider;
        _logger = logger;
        _errorDialogService = errorDialogService;
        _signalRService = signalRService;
        
        // Get fresh cloud URL from configuration service
        _cloudUrl = _configService.RemoteUrl;
        
        // Configure HttpClient for reasonable timeouts in industrial environments
        _httpClient.Timeout = TimeSpan.FromSeconds(90); // Allow time for large subsystem queries
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
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{cloudUrl}/api/sync/subsystem/{subsystemId}");
            AddApiKeyHeader(request);
            
            var response = await _httpClient.SendAsync(request);
            
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

    public async Task<bool> SyncTestHistoriesAsync(int subsystemId, List<TestHistoryDto> histories)
    {
        if (!histories.Any())
            return true;

        var cloudUrl = _configService.RemoteUrl;
        if (string.IsNullOrEmpty(cloudUrl))
        {
            _logger.LogWarning("Cloud URL not configured — cannot sync TestHistories");
            return false;
        }

        try
        {
            var batch = new TestHistorySyncBatchDto
            {
                SubsystemId = subsystemId,
                Histories = histories
            };

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{cloudUrl}/api/sync/test-histories");
            request.Content = JsonContent.Create(batch);
            AddApiKeyHeader(request);

            var response = await _httpClient.SendAsync(request, cts.Token);

            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Successfully synced {Count} TestHistory records to cloud", histories.Count);
                return true;
            }

            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                _logger.LogDebug("Cloud server does not support TestHistory sync endpoint yet (404). " +
                    "TestHistories are preserved locally and in database backups.");
                return false;
            }

            _logger.LogWarning("Failed to sync TestHistories to cloud: {StatusCode}", response.StatusCode);
            return false;
        }
        catch (TaskCanceledException)
        {
            _logger.LogDebug("TestHistory sync timed out — cloud endpoint may not be available yet");
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "TestHistory sync failed — cloud endpoint may not be available yet");
            return false;
        }
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
                await _hubConnection!.InvokeAsync("UpdateIO", update);
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
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{cloudUrl}/api/sync/update");
            request.Content = JsonContent.Create(batch);
            AddApiKeyHeader(request);
            
            var response = await _httpClient.SendAsync(request, cts.Token);
            
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
                
                await _hubConnection!.InvokeAsync("SyncMultipleIOs", updates);
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
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{cloudUrl}/api/sync/update");
            request.Content = JsonContent.Create(batch);
            AddApiKeyHeader(request);
            
            var response = await _httpClient.SendAsync(request, cts.Token);
            
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

        // Simple HTTP health check - SignalR is optional (cloud app uses SSE instead)
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var response = await _httpClient.GetAsync($"{cloudUrl}/api/sync/health", cts.Token);

            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Cloud HTTP health check passed for {CloudUrl}", cloudUrl);
                // Don't try SignalR here - it causes lock contention during Pull IOs
                // SignalR will be established lazily when needed for real-time sync
                return true;
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
        if (_hubConnection?.State == HubConnectionState.Connected)
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
            if (_hubConnection?.State == HubConnectionState.Connected)
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

            if (_hubConnection == null)
            {
                // Build SignalR URL with API key as query parameter
                var apiPassword = _configService.ApiPassword;
                var hubUrl = string.IsNullOrEmpty(apiPassword) 
                    ? $"{_cloudUrl}/syncHub"
                    : $"{_cloudUrl}/syncHub?apiKey={Uri.EscapeDataString(apiPassword)}";
                
                _logger.LogInformation("Creating SignalR connection to {HubUrl} with API key: {HasApiKey}", 
                    $"{_cloudUrl}/syncHub", !string.IsNullOrEmpty(apiPassword) ? "PROVIDED" : "MISSING");
                
                _hubConnection = new HubConnectionBuilder()
                    .WithUrl(hubUrl)
                    .WithAutomaticReconnect(new[] { 
                        TimeSpan.Zero,              // Immediate retry
                        TimeSpan.FromSeconds(2),    // Quick retry for brief interruptions
                        TimeSpan.FromSeconds(5),    // Short delay
                        TimeSpan.FromSeconds(15),   // Increased for network issues
                        TimeSpan.FromSeconds(30),   // Longer delay for persistent issues
                        TimeSpan.FromMinutes(1),    // Even longer for major outages
                        TimeSpan.FromMinutes(2)     // Max delay before giving up automatic retries
                    })
                    .Build();

                _hubConnection.Reconnecting += (error) =>
                {
                    _isConnected = false;
                    ConnectionStateChanged?.Invoke();
                    _logger.LogWarning(error, "SignalR connection lost, attempting to reconnect...");
                    _ = _signalRService.BroadcastError("cloud", "Cloud sync connection lost — reconnecting", "warning");
                    return Task.CompletedTask;
                };

                _hubConnection.Reconnected += (connectionId) =>
                {
                    _isConnected = true;
                    ConnectionStateChanged?.Invoke();
                    _logger.LogInformation("SignalR reconnected, scheduling pending syncs...");
                    _ = _signalRService.BroadcastError("cloud", "Cloud sync reconnected", "info");
                    // Delay sync attempt to ensure stable connection
                    _ = Task.Run(async () =>
                    {
                        await Task.Delay(5000); // Wait 5 seconds for connection to stabilize
                        _logger.LogInformation("Starting pending sync after reconnection delay");
                        var syncedCount = await SyncPendingUpdatesAsync();
                        _logger.LogInformation("Completed pending sync after reconnection: {Count} items synced", syncedCount);
                    });
                    return Task.CompletedTask;
                };

                _hubConnection.Closed += (error) =>
                {
                    _isConnected = false;
                    ConnectionStateChanged?.Invoke();
                    _logger.LogWarning(error, "SignalR connection closed");
                    return Task.CompletedTask;
                };
            }

            if (_hubConnection.State == HubConnectionState.Disconnected)
            {
                // Use cancellation token for quick timeout when offline
                using var cts = new CancellationTokenSource(_connectionTimeout);
                await _hubConnection.StartAsync(cts.Token);
                
                // Only set connected if we actually reach this point without exception
                _isConnected = true;
                ConnectionStateChanged?.Invoke();
                _logger.LogInformation("SignalR connection established to {CloudUrl}", _cloudUrl);
                return true;
            }

            // Connection exists but not in disconnected state - should not happen
            _logger.LogWarning("SignalR connection in unexpected state: {State}", _hubConnection.State);
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
            // Dispose existing connection
            if (_hubConnection != null)
            {
                _logger.LogInformation("Disposing existing SignalR connection...");
                _isConnected = false;
                ConnectionStateChanged?.Invoke();
                
                await _hubConnection.DisposeAsync();
                _hubConnection = null;
                _logger.LogInformation("SignalR connection disposed");
            }
            
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
        if (_hubConnection != null)
        {
            await _hubConnection.DisposeAsync();
        }
        _connectionLock?.Dispose();
    }

    public async Task<bool> TriggerFreshSyncAsync(bool skipPlcInitialization = false)
    {
        _logger.LogInformation("Pulling fresh IOs from cloud (skipPlcInit={Skip})...", skipPlcInitialization);

        try
        {
            var cloudUrl = _configService.RemoteUrl;
            if (string.IsNullOrEmpty(cloudUrl))
            {
                _logger.LogWarning("Remote URL not configured - cannot pull IOs");
                return false;
            }
            _cloudUrl = cloudUrl;

            // Just fetch the data — no SignalR, no pending sync, no health check
            var subsystemId = int.Parse(_configService.SubsystemId);
            _logger.LogInformation("Fetching IOs for subsystem {SubsystemId} from {CloudUrl}...", subsystemId, cloudUrl);

            var cloudIos = await GetSubsystemIosAsync(subsystemId);

            if (!cloudIos.Any())
            {
                _logger.LogWarning("No IOs retrieved from cloud for subsystem {SubsystemId}", subsystemId);
                return false;
            }

            _logger.LogInformation("Retrieved {Count} IOs from cloud, saving to local database...", cloudIos.Count);

            // Save to local database
            using var scope = _serviceProvider.CreateScope();
            var ioRepository = scope.ServiceProvider.GetRequiredService<IIoRepository>();
            var success = await SyncCloudIosToLocal(cloudIos, ioRepository, subsystemId);

            if (success)
            {
                // Refresh in-memory tag list
                var plcCommService = _serviceProvider.GetService<IPlcCommunicationService>();
                if (plcCommService != null)
                {
                    if (skipPlcInitialization)
                    {
                        await plcCommService.RefreshTagListFromDatabaseAsync();
                    }
                    else
                    {
                        await plcCommService.ReloadDataAfterCloudSyncAsync();
                    }

                    _logger.LogInformation("Pull complete - {TagCount} IOs now available", plcCommService.TagList.Count);
                }

                return true;
            }

            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error pulling IOs from cloud");
            _ = _signalRService.BroadcastError("cloud", $"Pull IOs failed: {ex.Message}", "error");
            return false;
        }
    }

    private async Task<bool> SyncCloudIosToLocal(List<Io> cloudIos, IIoRepository ioRepository, int subsystemId)
    {
        try
        {
            _logger.LogInformation("Starting fresh sync of {Count} cloud IOs to local database for subsystem {SubsystemId}", cloudIos.Count, subsystemId);

            // Bulk delete all existing IOs using raw SQL (TestHistories are in a separate table, unaffected)
            await ClearAllLocalData(ioRepository);

            // Build list of IOs to insert in bulk
            var iosToAdd = cloudIos
                .Where(cloudIo => !string.IsNullOrEmpty(cloudIo.Name) && cloudIo.Id > 0)
                .Select(cloudIo => new Io
                {
                    Id = cloudIo.Id,
                    SubsystemId = subsystemId,
                    Name = cloudIo.Name,
                    Description = cloudIo.Description,
                    Order = cloudIo.Order,
                    Result = cloudIo.Result,
                    Timestamp = cloudIo.Timestamp,
                    Comments = cloudIo.Comments,
                    Version = cloudIo.Version,
                    TagType = cloudIo.TagType
                })
                .ToList();

            // Bulk insert using raw SQL for speed (EF AddRange with explicit IDs is slow on SQLite)
            using var scope = _serviceProvider.CreateScope();
            var contextFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<Models.TagsContext>>();
            using var db = await contextFactory.CreateDbContextAsync();

            foreach (var io in iosToAdd)
            {
                db.Database.ExecuteSql(
                    $"INSERT INTO Ios (Id, SubsystemId, Name, Description, [Order], Result, Timestamp, Comments, Version, TagType) VALUES ({io.Id}, {io.SubsystemId}, {io.Name}, {io.Description ?? ""}, {io.Order}, {io.Result}, {io.Timestamp}, {io.Comments}, {io.Version}, {io.TagType})");
            }

            var addedCount = iosToAdd.Count;

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
            _logger.LogInformation("Clearing local IO data (preserving TestHistories audit trail)...");

            // Use raw SQL for instant bulk delete — TestHistories are in a separate table, unaffected
            using var scope = _serviceProvider.CreateScope();
            var contextFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<Models.TagsContext>>();
            using var db = await contextFactory.CreateDbContextAsync();

            var pendingCount = await db.Database.ExecuteSqlRawAsync("DELETE FROM PendingSyncs");
            var ioCount = await db.Database.ExecuteSqlRawAsync("DELETE FROM Ios");

            _logger.LogInformation("Cleared {IoCount} IOs and {PendingCount} pending syncs (TestHistories preserved)", ioCount, pendingCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error clearing existing local data");
        }
    }

    private void AddApiKeyHeader(HttpRequestMessage request)
    {
        var apiPassword = _configService.ApiPassword;
        if (!string.IsNullOrEmpty(apiPassword))
        {
            request.Headers.Add("X-API-Key", apiPassword);
        }
    }

    private bool HandleAuthenticationError(HttpResponseMessage response)
    {
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            _logger.LogError("Authentication failed - invalid API password");
            _errorDialogService.ShowAuthenticationError();
            _ = _signalRService.BroadcastError("cloud", "Cloud authentication failed — check API password", "error");
            return true;
        }
        return false;
    }
} 