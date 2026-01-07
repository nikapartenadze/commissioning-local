using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.PlcTags;
using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;
using Shared.Library.DTOs;

namespace IO_Checkout_Tool.Services;

public class PlcCommunicationService : IPlcCommunicationService, IDisposable
{
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly IPlcTagFactoryService _tagFactory;
    private readonly ITagReaderService _tagReader;
    private readonly ITagWriterService _tagWriter;
    private readonly IPlcConnectionService _connectionService;
    private readonly ISignalRService _signalRService;
    private readonly ILogger<PlcCommunicationService> _logger;
    
    private List<NativeTag> _tags = [];
    private bool _disableTesting = true;
    private bool _loading = true;
    private bool _isPlcConnected = false;
    private Timer? _reconnectionTimer;
    private bool _needsReinitialization = false;
    
    // Memory cache for state values - persists during app session only
    private readonly Dictionary<string, string> _stateCache = new();
    
    public List<Io> TagList { get; private set; } = [];
    public bool DisableTesting => _disableTesting;
    public bool Loading => _loading;
    public bool IsPlcConnected => _isPlcConnected;
    
    public event Action<Io>? NotifyIo;
    public event Action? NotifyState;
    public event Action? PlcConnectionChanged;
    
    public PlcCommunicationService(
        IDbContextFactory<TagsContext> contextFactory,
        IPlcTagFactoryService tagFactory,
        ITagReaderService tagReader,
        ITagWriterService tagWriter,
        IPlcConnectionService connectionService,
        ISignalRService signalRService,
        ILogger<PlcCommunicationService> logger)
    {
        _contextFactory = contextFactory;
        _tagFactory = tagFactory;
        _tagReader = tagReader;
        _tagWriter = tagWriter;
        _connectionService = connectionService;
        _signalRService = signalRService;
        _logger = logger;
        
        _tagReader.TagValueChanged += OnTagValueChanged;
        _tagReader.StateChanged += OnStateChanged;
        _tagReader.ConnectionStatusChanged += OnConnectionStatusChanged;
    }
    
    public async Task<bool> InitializeAsync()
    {
        // Always load database data first
        await LoadDatabaseDataAsync();
        
        // Test network connectivity before attempting tag initialization
        if (_tags.Any())
        {
            _logger.LogInformation("Testing network connectivity before initializing {TagCount} tags", _tags.Count);
            var networkConnected = await _connectionService.TestNetworkConnectivityAsync(showErrorDialog: true);
            
            if (!networkConnected)
            {
                _logger.LogError("Network connectivity test failed - aborting tag initialization to prevent timeout errors");
                _loading = false;
                SetPlcConnectionStatus(false);
                NotifyState?.Invoke();
                return false;
            }
            
            _logger.LogInformation("Network connectivity confirmed - proceeding with tag initialization");
            var initSuccess = await InitializeTagReading();
            return initSuccess;
        }
        else
        {
            // No tags to initialize
            _loading = false;
            NotifyState?.Invoke(); // Notify UI to refresh
            return false;
        }
    }
    

    
    private void SetPlcConnectionStatus(bool isConnected)
    {
        if (_isPlcConnected != isConnected)
        {
            _isPlcConnected = isConnected;
            PlcConnectionChanged?.Invoke();
        }
    }
    
    public void UpdatePlcConnectionStatus(bool isConnected)
    {
        SetPlcConnectionStatus(isConnected);
    }
    
    public void InitializeOutputTag(Io tag)
    {
        _tagWriter.InitializeOutputTag(tag);
    }
    
    public void ToggleBit()
    {
        _tagWriter.ToggleBit();
    }
    
    public async Task ReloadDataAsync()
    {
        // Reload data from database
        await LoadDatabaseDataAsync();
        
        // If we have tags now, try to initialize PLC connection
        if (_tags.Any() && _disableTesting)
        {
            // Try to establish PLC connection with all tags
            var initSuccess = await InitializeTagReading();
            if (!initSuccess)
            {
                _logger.LogError("Failed to initialize tag reading during data reload");
            }
        }
        
        // Notify UI to refresh
        _loading = false;
        NotifyState?.Invoke();
    }
    
    public async Task PauseForCloudSyncAsync()
    {
        _logger.LogInformation("Pausing PLC operations for cloud sync...");
        _loading = true;
        _disableTesting = true;
        
        // Reset TagReaderService to stop all PLC communication
        await _tagReader.ResetForReconnectionAsync(isConfigurationChange: false);
        
        NotifyState?.Invoke();
        _logger.LogInformation("PLC operations paused for cloud sync");
    }

    public async Task ResumeAfterCloudSyncAsync()
    {
        _logger.LogInformation("Resuming PLC operations after cloud sync...");
        
        try
        {
            // Reload data from database (gets new tag definitions from cloud sync)
            await LoadDatabaseDataAsync();
            
            // Force reinitialization with new tag definitions
            if (_tags.Any())
            {
                _logger.LogInformation("Testing new tag definitions from cloud sync with error detection enabled");
                var initSuccess = await InitializeTagReading();
                if (!initSuccess)
                {
                    _logger.LogError("Failed to initialize tag reading with new definitions after cloud sync");
                    await Task.Delay(800);
                }
                else
                {
                    await Task.Delay(200);
                }
            }
        }
        finally
        {
            _loading = false;
            NotifyState?.Invoke();
            _logger.LogInformation("PLC operations resumed after cloud sync");
        }
    }

    public async Task ReloadDataAfterCloudSyncAsync()
    {
        _logger.LogInformation("Reloading data after cloud sync - will test new tag definitions");
        
        try
        {
            // Set loading state to pause PLC operations
            _loading = true;
            _disableTesting = true;
            NotifyState?.Invoke();
            
            // Reload data from database (gets new tag definitions from cloud sync)
            await LoadDatabaseDataAsync();
            
            // Force reinitialization even if testing is already enabled to test new tag definitions
            if (_tags.Any())
            {
                // Test network connectivity before trying new tag definitions
                _logger.LogInformation("Testing network connectivity before initializing {TagCount} new tag definitions from cloud sync", _tags.Count);
                var networkConnected = await _connectionService.TestNetworkConnectivityAsync(showErrorDialog: true);
                
                if (!networkConnected)
                {
                    _logger.LogError("Network connectivity test failed - aborting tag initialization after cloud sync");
                }
                else
                {
                    // Try to establish PLC connection with new tags
                    _logger.LogInformation("Network connectivity confirmed - testing new tag definitions from cloud sync with error detection enabled");
                    var initSuccess = await InitializeTagReading(); // This will show error dialog if new tags fail
                    if (!initSuccess)
                    {
                        _logger.LogError("Failed to initialize tag reading with new definitions after cloud sync");
                        // Give extra time for error dialogs to appear when initialization fails
                        await Task.Delay(800);
                    }
                    else
                    {
                        // Small delay for successful initialization to ensure UI is updated
                        await Task.Delay(200);
                    }
                }
            }
        }
        finally
        {
            // Always clear loading state and notify UI, even if there were errors
            _loading = false;
            NotifyState?.Invoke();
        }
    }
    
    public async Task ReinitializePlcConnectionAsync()
    {
        _logger.LogInformation("Starting PLC connection reinitialization with new configuration...");
        
        try
        {
            _loading = true;
            _disableTesting = true;
            SetPlcConnectionStatus(false);
            
            // Notify UI that we're reinitializing
            NotifyState?.Invoke();
            
            // 1. Reset TagReaderService to dispose all old PLC connections
            _logger.LogInformation("Resetting TagReaderService to dispose old PLC connections...");
            await _tagReader.ResetForReconnectionAsync(isConfigurationChange: true);
            
            // 2. Wait a moment for cleanup to complete
            await Task.Delay(500);
            
            // 3. Recreate all tags with new IP/Path from configuration
            _logger.LogInformation("Recreating {TagCount} tags with new IP/Path configuration", TagList.Count);
            if (TagList.Any())
            {
                _tags = _tagFactory.CreateReadTags(TagList);
                _logger.LogInformation("Created {CreatedCount} new tags with updated configuration", _tags.Count);
            }
            
            // 4. Test network connectivity before initializing with new configuration
            if (_tags.Any())
            {
                _logger.LogInformation("Testing network connectivity with new configuration before initializing {TagCount} tags", _tags.Count);
                var networkConnected = await _connectionService.TestNetworkConnectivityAsync(showErrorDialog: true);
                
                if (!networkConnected)
                {
                    _logger.LogError("Network connectivity test failed with new configuration - aborting tag initialization");
                    _loading = false;
                    SetPlcConnectionStatus(false);
                    NotifyState?.Invoke();
                    return;
                }
                
                _logger.LogInformation("Network connectivity confirmed with new configuration - proceeding with tag initialization");
                // Skip error detection during subsystem switch since cloud sync will reload correct data
                var initSuccess = await InitializeTagReadingDuringSubsystemSwitch();
                
                if (initSuccess)
                {
                    _logger.LogInformation("PLC connection reinitialization completed successfully");
                }
                else
                {
                    _logger.LogError("Failed to initialize tag reading during PLC reinitialization");
                }
            }
            else
            {
                _logger.LogInformation("No tags available for PLC reinitialization");
                _loading = false;
                NotifyState?.Invoke();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during PLC connection reinitialization");
            _loading = false;
            SetPlcConnectionStatus(false);
            NotifyState?.Invoke();
        }
        
        _logger.LogInformation("PLC connection reinitialization process completed");
    }
    
    private async Task LoadDatabaseDataAsync()
    {
        using var db = _contextFactory.CreateDbContext();
        TagList = await db.Ios.ToListAsync();

        UpdateTagTimestamps();
        InitializeStatesFromCache();
        db.SaveChanges();

        if (TagList.Any())
        {
            _tags = _tagFactory.CreateReadTags(TagList);
        }
    }

    public async Task RefreshTagListFromDatabaseAsync()
    {
        using var db = _contextFactory.CreateDbContext();
        var updatedTagList = await db.Ios.ToListAsync();
        
        // Update the TagList with fresh data from database
        TagList = updatedTagList;
        
        // Update timestamps and states
        UpdateTagTimestamps();
        InitializeStatesFromCache();
        
        _logger.LogInformation("TagList refreshed from database - {Count} IOs loaded", TagList.Count);
    }
    
    public async Task ReconnectAsync(string ip, string path)
    {
        _logger.LogInformation("Reconnecting PLC with new configuration: IP={Ip}, Path={Path}", ip, path);
        
        try
        {
            // Use existing reinitialization logic which already handles:
            // - Resetting tag reader
            // - Disposing old connections
            // - Creating new tags with new IP/Path
            // - Testing connectivity
            // - Initializing tag reading
            await ReinitializePlcConnectionAsync();
            
            _logger.LogInformation("Successfully reconnected to PLC with new configuration");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to reconnect to PLC");
            throw;
        }
    }
    
    private void UpdateTagTimestamps()
    {
        foreach (var tag in TagList)
        {
            if (tag.Timestamp == null)
            {
                var date = DateTime.UtcNow;
                tag.Timestamp = date.ToString("MM/dd/yy h:mm tt");
            }
        }
    }
    
    private void InitializeStatesFromCache()
    {
        foreach (var tag in TagList)
        {
            if (tag.Name != null && _stateCache.TryGetValue(tag.Name, out var cachedState))
            {
                // Use cached state from previous reads
                tag.State = cachedState;
            }
            else
            {
                // Initialize to UNKNOWN for new tags
                tag.State = "UNKNOWN";
            }
        }
    }
    
    private async Task<bool> InitializeTagReading()
    {
        _logger.LogInformation("InitializeTagReading starting with {TagCount} tags, {IoCount} IOs", _tags.Count, TagList.Count);
        
        // Pass the actual TagList that the UI is bound to
        var success = await _tagReader.InitializeReadingAsync(_tags, TagList);
        _logger.LogInformation("TagReader initialization result: {Success}", success);
        
        if (success)
        {
            _disableTesting = false;
            _logger.LogInformation("Tag reading enabled - disableTesting set to false");
            
            // Update cache with initial states from PLC
            foreach (var tag in TagList)
            {
                if (tag.Name != null && tag.State != null && tag.State != "UNKNOWN")
                {
                    _stateCache[tag.Name] = tag.State;
                }
            }
            
            // Update PLC connection status - successful tag reading means we're connected
            SetPlcConnectionStatus(true);
            
            // Force UI refresh after initial states are set
            NotifyState?.Invoke();
        }
        else
        {
            // Failed to initialize tag reading - PLC connection issue
            _logger.LogError("Tag reading initialization failed");
            SetPlcConnectionStatus(false);
        }
        _loading = false;
        
        // Notify UI to refresh after tag initialization
        NotifyState?.Invoke();
        
        return success;
    }
    
    private async Task<bool> InitializeTagReadingDuringSubsystemSwitch()
    {
        _logger.LogInformation("InitializeTagReadingDuringSubsystemSwitch starting with {TagCount} tags, {IoCount} IOs", _tags.Count, TagList.Count);
        
        // Skip error detection during subsystem switch since cloud sync will reload correct tag definitions
        var success = await _tagReader.InitializeReadingAsync(_tags, TagList, skipErrorDetection: true);
        _logger.LogInformation("TagReader initialization result: {Success}", success);
        
        if (success)
        {
            _disableTesting = false;
            _logger.LogInformation("Tag reading enabled - disableTesting set to false");
            
            // Update cache with initial states from PLC
            foreach (var tag in TagList)
            {
                if (tag.Name != null && tag.State != null && tag.State != "UNKNOWN")
                {
                    _stateCache[tag.Name] = tag.State;
                }
            }
            
            // Update PLC connection status - successful tag reading means we're connected
            SetPlcConnectionStatus(true);
            
            // Force UI refresh after initial states are set
            NotifyState?.Invoke();
        }
        else
        {
            // Failed to initialize tag reading - PLC connection issue
            _logger.LogError("Tag reading initialization failed");
            SetPlcConnectionStatus(false);
        }
        
        // DON'T clear loading state here - this is just the intermediate step
        // Loading will be cleared when ReloadDataAfterCloudSyncAsync() completes
        _logger.LogInformation("Intermediate tag initialization complete - waiting for cloud sync to finish");
        
        // Notify UI to refresh after tag initialization
        NotifyState?.Invoke();
        
        return success;
    }
    
    private async void OnTagValueChanged(Io tag)
    {
        // Update state cache when tag value changes
        if (tag.Name != null && tag.State != null)
        {
            _stateCache[tag.Name] = tag.State;
        }
        
        // Send SignalR update to Next.js frontend only for state changes
        // Result changes are handled separately in API controllers
        try
        {
            await _signalRService.SendStateUpdateAsync(tag);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error sending SignalR state update for tag {TagName}", tag.Name);
        }
        
        NotifyIo?.Invoke(tag);
    }
    
    private void OnStateChanged()
    {
        _logger.LogDebug("OnStateChanged called - PLC Connected: {Connected}, Testing Disabled: {Disabled}, Needs Reinit: {NeedsReinit}", 
            _isPlcConnected, _disableTesting, _needsReinitialization);
        
        // Check if TagReaderService needs reinitialization after reconnection
        if (_isPlcConnected && _needsReinitialization)
        {
            _needsReinitialization = false; // Clear the flag
            _logger.LogInformation("TagReaderService requesting reinitialization after reconnection");
            _ = Task.Run(async () => await ReinitializeAfterReconnectionAsync());
        }
        
        NotifyState?.Invoke();
    }

    private async Task ReinitializeAfterReconnectionAsync()
    {
        try
        {
            _logger.LogInformation("Starting tag reinitialization after clean reconnection - {TagCount} tags in TagList", TagList.Count);
            
            // First, completely reset the TagReaderService
            _logger.LogInformation("Resetting TagReaderService...");
            await _tagReader.ResetForReconnectionAsync(isConfigurationChange: false);
            
            // Recreate tags from current TagList
            _logger.LogInformation("Recreating {TagCount} tags from TagList", TagList.Count);
            _tags = _tagFactory.CreateReadTags(TagList);
            _logger.LogInformation("Created {CreatedCount} new tags", _tags.Count);
            
            // Reinitialize tag reading with fresh tags
            _logger.LogInformation("Starting tag reading initialization...");
            var success = await InitializeTagReading();
            
            if (success)
            {
                _logger.LogInformation("Tag reinitialization completed successfully - continuous reading should now be active");
            }
            else
            {
                _logger.LogError("Tag reinitialization failed during InitializeTagReading");
                SetPlcConnectionStatus(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to reinitialize tags after reconnection");
            SetPlcConnectionStatus(false);
        }
    }
    
    private void OnConnectionStatusChanged(bool isConnected)
    {
        SetPlcConnectionStatus(isConnected);
        
        if (isConnected)
        {
            // Stop reconnection attempts when connection is restored
            StopReconnectionTimer();
            
            // Mark that we need reinitialization after reconnection
            _needsReinitialization = true;
            _logger.LogInformation("PLC reconnected - marking for reinitialization");
        }
        else
        {
            // TagReaderService now handles clean disconnection/reconnection
            // The old timer-based approach is disabled in favor of clean slate reconnection
            _logger.LogInformation("PLC disconnected - TagReaderService will handle clean reconnection");
            StopReconnectionTimer(); // Make sure old timer is stopped
            _disableTesting = true; // Reset testing state for reconnection
        }
    }

    private void StartReconnectionTimer()
    {
        StopReconnectionTimer(); // Stop any existing timer
        
        _logger.LogInformation("Starting PLC reconnection attempts every 10 seconds");
        _reconnectionTimer = new Timer(async _ => await TryReconnectAsync(), null, 
                                     TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
    }

    private void StopReconnectionTimer()
    {
        if (_reconnectionTimer != null)
        {
            _reconnectionTimer.Dispose();
            _reconnectionTimer = null;
            _logger.LogDebug("Stopped PLC reconnection timer");
        }
    }

        private async Task TryReconnectAsync()
    {
        if (_isPlcConnected || !_tags.Any())
        {
            // Already connected or no tags to test
            return;
        }

        _logger.LogDebug("Attempting PLC reconnection...");
        
        try
        {
            // Use full tag initialization instead of single tag test
            if (_disableTesting)
            {
                var success = await InitializeTagReading();
                if (success)
                {
                    _logger.LogInformation("PLC reconnection successful!");
                    SetPlcConnectionStatus(true);
                }
                else
                {
                    _logger.LogDebug("PLC reconnection attempt failed - will retry");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Exception during PLC reconnection attempt");
        }
    }

     public void Dispose()
     {
         StopReconnectionTimer();
     }
 } 