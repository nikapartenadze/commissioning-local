using Microsoft.Extensions.Configuration;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Constants;
using System.Text.Json;
using System.Diagnostics;
using Microsoft.Extensions.Logging;

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

    public string Ip { get; private set; } = string.Empty;
    public string Path { get; private set; } = string.Empty;
    public string SubsystemId { get; private set; } = string.Empty;
    public string RemoteUrl { get; private set; } = string.Empty;
    public string ApiPassword { get; private set; } = string.Empty;
    public bool OrderMode { get; private set; }
    public bool DisableWatchdog { get; private set; }
    
    // Column visibility settings
    public bool ShowStateColumn { get; private set; } = true;
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

    public async Task<bool> UpdateConfigurationAsync(string ip, string path, string subsystemId, string remoteUrl, string apiPassword, bool orderMode, bool disableWatchdog, bool showStateColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn)
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

    public void UpdateColumnVisibility(bool showStateColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn)
    {
        ShowStateColumn = showStateColumn;
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
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_RESULT_COLUMN] = ShowResultColumn.ToString().ToLower();
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_TIMESTAMP_COLUMN] = ShowTimestampColumn.ToString().ToLower();
            currentConfig[DatabaseConstants.ConfigKeys.SHOW_HISTORY_COLUMN] = ShowHistoryColumn.ToString().ToLower();

            var options = new JsonSerializerOptions
            {
                WriteIndented = true
            };

            var jsonString = JsonSerializer.Serialize(currentConfig, options);
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
            
            // 2. Reload configuration from the updated file
            ((IConfigurationRoot)_configuration).Reload();
            var configReloaded = LoadConfiguration();
            
            if (!configReloaded)
            {
                _logger.LogError("Failed to reload configuration - stopping reinitialization");
                return;
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

                    // Test the new connection
                    _logger.LogInformation("Testing new cloud connection with updated configuration...");
                    var connectionRestored = await cloudSyncService.IsCloudAvailable();
                    if (connectionRestored)
                    {
                        _logger.LogInformation("Cloud connection restored successfully - real-time updates active");
                    }
                    else
                    {
                        _logger.LogWarning("Failed to restore cloud connection - check configuration and cloud availability");
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
                
                // 6. If no cloud sync, just reload local data
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
    
    public async Task<bool> SwitchToConfigurationAsync(string ip, string path, string subsystemId, string remoteUrl, string apiPassword, bool orderMode, bool disableWatchdog, bool showStateColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn)
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
            ShowResultColumn = showResultColumn;
            ShowTimestampColumn = showTimestampColumn;
            ShowHistoryColumn = showHistoryColumn;
            
            // Optionally save to config.json for persistence across app restarts
            await UpdateConfigurationAsync(ip, path, subsystemId, remoteUrl, apiPassword, orderMode, disableWatchdog, showStateColumn, showResultColumn, showTimestampColumn, showHistoryColumn);
            
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
} 