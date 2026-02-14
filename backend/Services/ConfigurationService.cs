using Microsoft.Extensions.Configuration;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Constants;
using System.Text.Json;
using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Shared.Library.Repositories.Interfaces;

namespace IO_Checkout_Tool.Services;

public class ConfigurationService : IConfigurationService, IAsyncDisposable
{
    private readonly IConfiguration _configuration;
    private readonly IErrorDialogService _errorDialogService;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ConfigurationService> _logger;
    
    // Reinitialization lock to prevent concurrent attempts
    private readonly SemaphoreSlim _reinitializationLock = new(1, 1);
    private volatile bool _isReinitializing = false;

    // Track previous subsystem to detect changes
    private string _previousSubsystemId = string.Empty;

    public string Ip { get; private set; } = string.Empty;
    public string Path { get; private set; } = string.Empty;
    public string SubsystemId { get; private set; } = string.Empty;
    public string RemoteUrl { get; private set; } = string.Empty;
    public string ApiPassword { get; private set; } = string.Empty;
    public bool OrderMode { get; private set; }
    public bool DisableWatchdog { get; private set; }
    
    // Column visibility settings
    public bool ShowStateColumn { get; private set; } = true;
    public bool ShowHzColumn { get; private set; } = true;
    public bool ShowResultColumn { get; private set; } = true;
    public bool ShowTimestampColumn { get; private set; } = true;
    public bool ShowHistoryColumn { get; private set; } = true;
    
    // Property to check if reinitialization is in progress
    public bool IsReinitializing => _isReinitializing;
    
    // Events
    public event Action? ColumnVisibilityChanged;

    public ConfigurationService(IConfiguration configuration, IErrorDialogService errorDialogService, IServiceProvider serviceProvider, ILogger<ConfigurationService> logger)
    {
        _configuration = configuration;
        _errorDialogService = errorDialogService;
        _serviceProvider = serviceProvider;
        _logger = logger;
        LoadConfiguration();
    }

    public bool LoadConfiguration()
    {
        // Read directly from root level since config.json has values at root
        if (string.IsNullOrEmpty(_configuration[DatabaseConstants.ConfigKeys.IP]) || 
            string.IsNullOrEmpty(_configuration[DatabaseConstants.ConfigKeys.PATH]) || 
            string.IsNullOrEmpty(_configuration[DatabaseConstants.ConfigKeys.SUBSYSTEM_ID]))
        {
            _errorDialogService.ShowConfigurationError();
            return false;
        }

        try
        {
            Ip = _configuration[DatabaseConstants.ConfigKeys.IP]!;
            Path = _configuration[DatabaseConstants.ConfigKeys.PATH]!;
            SubsystemId = _configuration[DatabaseConstants.ConfigKeys.SUBSYSTEM_ID]!;
            RemoteUrl = (_configuration[DatabaseConstants.ConfigKeys.REMOTE_URL] ?? string.Empty).TrimEnd('/');
            ApiPassword = _configuration["ApiPassword"] ?? string.Empty;
            OrderMode = int.Parse(_configuration[DatabaseConstants.ConfigKeys.ORDER_MODE] ?? "0") == DatabaseConstants.Defaults.ORDER_MODE_ENABLED;
            DisableWatchdog = bool.Parse(_configuration[DatabaseConstants.ConfigKeys.DISABLE_WATCHDOG] ?? "false");
            
            // Load column visibility settings (default to true if not specified)
            ShowStateColumn = bool.Parse(_configuration[DatabaseConstants.ConfigKeys.SHOW_STATE_COLUMN] ?? "true");
            ShowHzColumn = bool.Parse(_configuration[DatabaseConstants.ConfigKeys.SHOW_HZ_COLUMN] ?? "true");
            ShowResultColumn = bool.Parse(_configuration[DatabaseConstants.ConfigKeys.SHOW_RESULT_COLUMN] ?? "true");
            ShowTimestampColumn = bool.Parse(_configuration[DatabaseConstants.ConfigKeys.SHOW_TIMESTAMP_COLUMN] ?? "true");
            ShowHistoryColumn = bool.Parse(_configuration[DatabaseConstants.ConfigKeys.SHOW_HISTORY_COLUMN] ?? "true");
            
            return true;
        }
        catch
        {
            _errorDialogService.ShowConfigurationError();
            return false;
        }
    }

    public async Task<bool> UpdateConfigurationAsync(string ip, string path, string subsystemId, string remoteUrl, string apiPassword, bool orderMode, bool disableWatchdog, bool showStateColumn, bool showHzColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn)
    {
        try
        {
            var configData = new Dictionary<string, object>
            {
                { DatabaseConstants.ConfigKeys.IP, ip },
                { DatabaseConstants.ConfigKeys.PATH, path },
                { DatabaseConstants.ConfigKeys.SUBSYSTEM_ID, subsystemId },
                { DatabaseConstants.ConfigKeys.REMOTE_URL, remoteUrl },
                { "ApiPassword", apiPassword },
                { DatabaseConstants.ConfigKeys.ORDER_MODE, orderMode ? "1" : "0" },
                { DatabaseConstants.ConfigKeys.DISABLE_WATCHDOG, disableWatchdog.ToString().ToLower() },
                { DatabaseConstants.ConfigKeys.SHOW_STATE_COLUMN, showStateColumn.ToString().ToLower() },
                { DatabaseConstants.ConfigKeys.SHOW_HZ_COLUMN, showHzColumn.ToString().ToLower() },
                { DatabaseConstants.ConfigKeys.SHOW_RESULT_COLUMN, showResultColumn.ToString().ToLower() },
                { DatabaseConstants.ConfigKeys.SHOW_TIMESTAMP_COLUMN, showTimestampColumn.ToString().ToLower() },
                { DatabaseConstants.ConfigKeys.SHOW_HISTORY_COLUMN, showHistoryColumn.ToString().ToLower() },
                // Preserve existing values that might not be in the UI
                { "syncBatchSize", _configuration["syncBatchSize"] ?? "50" },
                { "syncBatchDelayMs", _configuration["syncBatchDelayMs"] ?? "500" }
            };

            var options = new JsonSerializerOptions
            {
                WriteIndented = true
            };

            var jsonString = JsonSerializer.Serialize(configData, options);

            // Notify file watcher that this is an internal write (prevent triggering reinitialization)
            ConfigFileWatcherService.NotifyInternalWrite();
            await File.WriteAllTextAsync("config.json", jsonString);

            // Update local properties
            Ip = ip;
            Path = path;
            SubsystemId = subsystemId;
            RemoteUrl = remoteUrl.TrimEnd('/');
            ApiPassword = apiPassword;
            OrderMode = orderMode;
            DisableWatchdog = disableWatchdog;
            ShowStateColumn = showStateColumn;
            ShowHzColumn = showHzColumn;
            ShowResultColumn = showResultColumn;
            ShowTimestampColumn = showTimestampColumn;
            ShowHistoryColumn = showHistoryColumn;

            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error updating configuration: {ex.Message}");
            return false;
        }
    }

    public void UpdateColumnVisibility(bool showStateColumn, bool showHzColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn)
    {
        ShowStateColumn = showStateColumn;
        ShowHzColumn = showHzColumn;
        ShowResultColumn = showResultColumn;
        ShowTimestampColumn = showTimestampColumn;
        ShowHistoryColumn = showHistoryColumn;
        
        // Notify components of the change
        ColumnVisibilityChanged?.Invoke();
    }

    public async Task SaveUISettingsAsync()
    {
        try
        {
            // Read the current config file to preserve all existing settings
            var currentConfig = new Dictionary<string, object>();
            
            if (File.Exists("config.json"))
            {
                var existingJson = await File.ReadAllTextAsync("config.json");
                if (!string.IsNullOrEmpty(existingJson))
                {
                    var existingConfig = JsonSerializer.Deserialize<Dictionary<string, object>>(existingJson);
                    if (existingConfig != null)
                    {
                        currentConfig = existingConfig;
                    }
                }
            }
            
            // Update only the column visibility settings
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_STATE_COLUMN] = ShowStateColumn.ToString().ToLower();
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_HZ_COLUMN] = ShowHzColumn.ToString().ToLower();
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_RESULT_COLUMN] = ShowResultColumn.ToString().ToLower();
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_TIMESTAMP_COLUMN] = ShowTimestampColumn.ToString().ToLower();
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_HISTORY_COLUMN] = ShowHistoryColumn.ToString().ToLower();

            var options = new JsonSerializerOptions
            {
                WriteIndented = true
            };

            var jsonString = JsonSerializer.Serialize(currentConfig, options);

            // Notify file watcher that this is an internal write (prevent triggering reinitialization)
            ConfigFileWatcherService.NotifyInternalWrite();
            await File.WriteAllTextAsync("config.json", jsonString);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error saving UI settings to configuration file");
        }
    }

    public async Task ReinitializeApplicationAsync()
    {
        // Use a timeout to prevent indefinite blocking
        var timeout = TimeSpan.FromMinutes(2); // 2-minute timeout for reinitialization
        
        if (!await _reinitializationLock.WaitAsync(timeout))
        {
            _logger.LogWarning("Reinitialization request timed out waiting for lock - another reinitialization may be in progress");
            return;
        }

        try
        {
            if (_isReinitializing)
            {
                _logger.LogInformation("Reinitialization already in progress, skipping duplicate request");
                return;
            }

            _isReinitializing = true;
            _logger.LogInformation("Starting application reinitialization...");

            // 1. Wait a moment to ensure file write is complete
            await Task.Delay(100);

            // Save previous subsystem ID to detect changes
            var previousSubsystem = SubsystemId;

            // 2. Reload configuration from the updated file
            ((IConfigurationRoot)_configuration).Reload();
            var configReloaded = LoadConfiguration();

            if (!configReloaded)
            {
                _logger.LogError("Failed to reload configuration - stopping reinitialization");
                return;
            }

            // Check if subsystem changed
            var subsystemChanged = !string.Equals(previousSubsystem, SubsystemId, StringComparison.OrdinalIgnoreCase);
            if (subsystemChanged)
            {
                _logger.LogInformation("Subsystem changed from {OldSubsystem} to {NewSubsystem} - will fetch fresh data from cloud",
                    previousSubsystem, SubsystemId);
            }

            _logger.LogInformation("Configuration reloaded successfully. IP={Ip}, Path={Path}, DisableWatchdog={DisableWatchdog}, OrderMode={OrderMode}",
                Ip, Path, DisableWatchdog, OrderMode);

            // 3. Get services needed for reinitialization
            var cloudSyncService = _serviceProvider.GetService<ICloudSyncService>();
            var plcCommunicationService = _serviceProvider.GetService<IPlcCommunicationService>();
            var watchdogService = _serviceProvider.GetService<IWatchdogService>();
            
            // 4. Reinitialize PLC connections with new IP/Path settings
            _logger.LogInformation("Reinitializing PLC connections with new configuration...");
            
            // First reinitialize the watchdog service with new IP/Path
            if (watchdogService != null)
            {
                try
                {
                    await watchdogService.ReinitializeWatchdogAsync();
                    _logger.LogInformation("Watchdog service reinitialized successfully");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to reinitialize watchdog service");
                }
            }
            
            // Wait extra time to ensure all background tasks from old subsystem are fully stopped
            _logger.LogInformation("Ensuring clean state before PLC reinitialization...");
            await Task.Delay(800);
            
            // Then reinitialize the PLC communication service
            if (plcCommunicationService != null)
            {
                try
                {
                    await plcCommunicationService.ReinitializePlcConnectionAsync();
                    _logger.LogInformation("PLC communication service reinitialized successfully");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to reinitialize PLC communication service");
                }
            }
            
            // 5. Force cloud sync service to reconnect with new configuration
            if (cloudSyncService != null)
            {
                _logger.LogInformation("Reinitializing cloud sync service with updated configuration...");

                // Check if this is the ResilientCloudSyncService which supports ForceReconnectAsync
                if (cloudSyncService is ResilientCloudSyncService resilientService)
                {
                    await resilientService.ForceReconnectAsync();
                    _logger.LogInformation("Cloud sync service reconnection initiated");

                    // Test the new connection - wait for SignalR to establish
                    _logger.LogInformation("Testing new cloud connection with updated configuration...");

                    // Wait up to 10 seconds for SignalR connection to establish
                    var connectionRestored = false;
                    for (int attempt = 0; attempt < 5 && !connectionRestored; attempt++)
                    {
                        connectionRestored = await cloudSyncService.IsCloudAvailable();
                        if (!connectionRestored && attempt < 4)
                        {
                            _logger.LogDebug("Waiting for cloud connection... attempt {Attempt}/5", attempt + 1);
                            await Task.Delay(2000); // Wait 2 seconds between attempts
                        }
                    }

                    if (connectionRestored)
                    {
                        _logger.LogInformation("Cloud connection restored successfully - real-time updates active");

                        // 6. Always fetch fresh IOs from cloud on config save
                        // This ensures data is loaded even if startup was skipped
                        _logger.LogInformation("Fetching fresh IOs from cloud for subsystem {SubsystemId}...", SubsystemId);
                        var cloudFetchSuccess = await FetchAndSyncCloudData(cloudSyncService, plcCommunicationService);

                        // If cloud fetch failed (e.g., 401 auth error), fall back to local database
                        if (!cloudFetchSuccess && plcCommunicationService != null)
                        {
                            _logger.LogInformation("Cloud fetch failed - loading existing IOs from local database...");
                            await plcCommunicationService.ReloadDataAsync();
                        }
                    }
                    else
                    {
                        _logger.LogWarning("Failed to restore cloud connection - will try to load from local database");

                        // Try to load from local database if cloud fails
                        if (plcCommunicationService != null)
                        {
                            _logger.LogInformation("Loading IOs from local database...");
                            await plcCommunicationService.ReloadDataAsync();
                        }
                    }
                }
                else
                {
                    _logger.LogInformation("Cloud sync service reinitialized with updated configuration");
                }
            }
            else
            {
                _logger.LogInformation("Cloud sync not available - reloading local data only");

                // If no cloud sync, just reload local data
                if (plcCommunicationService != null)
                {
                    await plcCommunicationService.ReloadDataAfterCloudSyncAsync();
                }
            }

            // 7. Wait for PlcCommunicationService to finish loading completely
            if (plcCommunicationService != null)
            {
                _logger.LogInformation("Waiting for PlcCommunicationService to finish loading...");
                
                // Wait up to 30 seconds for loading to complete
                var maxWait = TimeSpan.FromSeconds(30);
                var stopwatch = Stopwatch.StartNew();
                
                while (plcCommunicationService.Loading && stopwatch.Elapsed < maxWait)
                {
                    await Task.Delay(100);
                }
                
                if (plcCommunicationService.Loading)
                {
                    _logger.LogWarning("PlcCommunicationService still loading after {MaxWait} seconds", maxWait.TotalSeconds);
                }
                else
                {
                    _logger.LogInformation("PlcCommunicationService loading completed");
                }
                
                // Access a property to ensure the service state is current
                var tagCount = plcCommunicationService.TagList.Count;
                _logger.LogInformation("Data reload completed - {TagCount} IOs now loaded", tagCount);
            }
            else
            {
                // Fallback delay if service is not available
                await Task.Delay(1500);
            }

            _logger.LogInformation("Application reinitialization completed successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error reinitializing application");
            Console.WriteLine($"Error reinitializing application: {ex.Message}");
        }
        finally
        {
            _isReinitializing = false;
            _reinitializationLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            // Wait for any ongoing reinitialization to complete before disposing
            if (_isReinitializing)
            {
                _logger.LogInformation("Waiting for ongoing reinitialization to complete before disposal...");
                
                // Wait up to 30 seconds for reinitialization to complete
                var maxWait = TimeSpan.FromSeconds(30);
                var stopwatch = Stopwatch.StartNew();
                
                while (_isReinitializing && stopwatch.Elapsed < maxWait)
                {
                    await Task.Delay(100);
                }
                
                if (_isReinitializing)
                {
                    _logger.LogWarning("Reinitialization still in progress after {MaxWait} seconds, proceeding with disposal", maxWait.TotalSeconds);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during ConfigurationService disposal");
        }
        finally
        {
            _reinitializationLock?.Dispose();
        }
    }
    
    public async Task<bool> SwitchToConfigurationAsync(string ip, string path, string subsystemId, string remoteUrl, string apiPassword, bool orderMode, bool disableWatchdog, bool showStateColumn, bool showHzColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn)
    {
        try
        {
            _logger.LogInformation("Switching to configuration: IP={Ip}, Path={Path}, SubsystemId={SubsystemId}", ip, path, subsystemId);
            
            // Update in-memory configuration
            Ip = ip;
            Path = path;
            SubsystemId = subsystemId;
            RemoteUrl = remoteUrl?.TrimEnd('/') ?? string.Empty;
            ApiPassword = apiPassword ?? string.Empty;
            OrderMode = orderMode;
            DisableWatchdog = disableWatchdog;
            ShowStateColumn = showStateColumn;
            ShowHzColumn = showHzColumn;
            ShowResultColumn = showResultColumn;
            ShowTimestampColumn = showTimestampColumn;
            ShowHistoryColumn = showHistoryColumn;
            
            // Optionally save to config.json for persistence across app restarts
            await UpdateConfigurationAsync(ip, path, subsystemId, remoteUrl, apiPassword, orderMode, disableWatchdog, showStateColumn, showHzColumn, showResultColumn, showTimestampColumn, showHistoryColumn);
            
            // Notify components of column visibility changes
            ColumnVisibilityChanged?.Invoke();
            
            _logger.LogInformation("Successfully switched configuration");
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to switch configuration");
            return false;
        }
    }

    /// <summary>
    /// Fetches IOs from cloud for the current subsystem and syncs to local database
    /// </summary>
    /// <returns>True if IOs were successfully fetched and synced, false otherwise</returns>
    private async Task<bool> FetchAndSyncCloudData(ICloudSyncService cloudSyncService, IPlcCommunicationService? plcCommunicationService)
    {
        try
        {
            var subsystemId = int.Parse(SubsystemId);

            // 1. Fetch IOs from cloud
            _logger.LogInformation("Fetching IOs from cloud for subsystem {SubsystemId}...", subsystemId);
            var cloudIos = await cloudSyncService.GetSubsystemIosAsync(subsystemId);

            if (cloudIos == null || !cloudIos.Any())
            {
                _logger.LogWarning("No IOs retrieved from cloud for subsystem {SubsystemId} - will use local data", subsystemId);
                return false;
            }

            _logger.LogInformation("Retrieved {Count} IOs from cloud", cloudIos.Count);

            // 2. Get repository and clear old data
            using var scope = _serviceProvider.CreateScope();
            var ioRepository = scope.ServiceProvider.GetRequiredService<IIoRepository>();

            // Clear ALL local IOs (we're switching subsystems, so old data is irrelevant)
            _logger.LogInformation("Clearing local database for subsystem switch...");
            var existingIos = await ioRepository.GetAllAsync();
            foreach (var io in existingIos)
            {
                await ioRepository.DeleteAsync(io.Id);
            }

            // 3. Save new IOs to local database
            _logger.LogInformation("Saving {Count} IOs to local database...", cloudIos.Count);
            foreach (var io in cloudIos)
            {
                // Clear any state/result since this is fresh data
                io.State = null;
                await ioRepository.AddAsync(io);
            }

            _logger.LogInformation("Successfully synced {Count} IOs from cloud to local database", cloudIos.Count);

            // 4. Reload PLC with new data
            if (plcCommunicationService != null)
            {
                _logger.LogInformation("Reinitializing PLC with new IO data...");
                await plcCommunicationService.ReloadDataAsync();
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch and sync cloud data for subsystem {SubsystemId}", SubsystemId);
            return false;
        }
    }
} 