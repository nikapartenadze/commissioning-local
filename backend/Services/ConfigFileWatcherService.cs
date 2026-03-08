using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Monitors config.json for external changes and triggers automatic reinitialization.
/// This allows factory IT to edit config.json directly without restarting the application.
///
/// Uses FileSystemWatcher with debouncing to handle:
/// - Multiple rapid file system events during save
/// - Text editor behaviors (temp files, multiple writes)
/// - Network file system delays
/// </summary>
public class ConfigFileWatcherService : BackgroundService
{
    private readonly ILogger<ConfigFileWatcherService> _logger;
    private readonly IServiceProvider _serviceProvider;
    private readonly ISignalRService _signalRService;
    private FileSystemWatcher? _watcher;
    private readonly string _configFilePath;
    private readonly SemaphoreSlim _debounceGate = new(1, 1);
    private DateTime _lastChangeTime = DateTime.MinValue;
    private DateTime _lastFileWriteTime = DateTime.MinValue;
    private const int DebounceDelayMs = 1000; // Wait 1 second after last change before processing

    // Track if the change came from our own UpdateConfigurationAsync (skip reinitializing)
    private static DateTime _lastInternalWrite = DateTime.MinValue;
    private const int InternalWriteGracePeriodMs = 5000;

    public ConfigFileWatcherService(
        ILogger<ConfigFileWatcherService> logger,
        IServiceProvider serviceProvider,
        ISignalRService signalRService)
    {
        _logger = logger;
        _serviceProvider = serviceProvider;
        _signalRService = signalRService;

        // Use DATA_DIR-aware path for config.json (same as ConfigurationService)
        _configFilePath = IO_Checkout_Tool.Constants.DatabaseConstants.ConfigFilePath;
    }

    /// <summary>
    /// Call this before writing to config.json internally to prevent triggering reinitialization
    /// </summary>
    public static void NotifyInternalWrite()
    {
        _lastInternalWrite = DateTime.UtcNow;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("ConfigFileWatcherService starting - watching {ConfigPath}", _configFilePath);

        try
        {
            var directory = Path.GetDirectoryName(_configFilePath);
            var fileName = Path.GetFileName(_configFilePath);

            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            {
                _logger.LogWarning("Config file directory does not exist: {Directory}", directory);
                return;
            }

            _watcher = new FileSystemWatcher(directory, fileName)
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime,
                EnableRaisingEvents = true
            };

            _watcher.Changed += OnConfigFileChanged;
            _watcher.Created += OnConfigFileChanged;

            // Store initial file write time
            if (File.Exists(_configFilePath))
            {
                _lastFileWriteTime = File.GetLastWriteTimeUtc(_configFilePath);
            }

            _logger.LogInformation("ConfigFileWatcherService started - monitoring config.json for external changes");

            // Keep the service running
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(1000, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Expected during shutdown
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ConfigFileWatcherService");
        }
    }

    private async void OnConfigFileChanged(object sender, FileSystemEventArgs e)
    {
        try
        {
            // Check if this was an internal write (from UpdateConfigurationAsync via UI)
            var timeSinceInternalWrite = DateTime.UtcNow - _lastInternalWrite;
            if (timeSinceInternalWrite.TotalMilliseconds < InternalWriteGracePeriodMs)
            {
                _logger.LogDebug("Ignoring config file change - internal write detected {TimeSince}ms ago",
                    timeSinceInternalWrite.TotalMilliseconds);
                return;
            }

            // Check if file write time actually changed (debounce duplicate events)
            if (File.Exists(_configFilePath))
            {
                var currentWriteTime = File.GetLastWriteTimeUtc(_configFilePath);
                if (currentWriteTime == _lastFileWriteTime)
                {
                    _logger.LogDebug("Ignoring config file event - file write time unchanged");
                    return;
                }
                _lastFileWriteTime = currentWriteTime;
            }

            _lastChangeTime = DateTime.UtcNow;

            // Use debouncing to handle multiple rapid events
            if (!await _debounceGate.WaitAsync(0))
            {
                _logger.LogDebug("Debounce gate already held, skipping");
                return;
            }

            try
            {
                // Wait for debounce period
                await Task.Delay(DebounceDelayMs);

                // Check if more changes came in during debounce
                var timeSinceLastChange = DateTime.UtcNow - _lastChangeTime;
                if (timeSinceLastChange.TotalMilliseconds < DebounceDelayMs - 100)
                {
                    _logger.LogDebug("More changes detected during debounce, waiting...");
                    await Task.Delay(DebounceDelayMs);
                }

                // Double-check internal write grace period after debounce
                timeSinceInternalWrite = DateTime.UtcNow - _lastInternalWrite;
                if (timeSinceInternalWrite.TotalMilliseconds < InternalWriteGracePeriodMs)
                {
                    _logger.LogDebug("Ignoring config file change after debounce - internal write detected");
                    return;
                }

                _logger.LogInformation("External config.json change detected - triggering automatic reinitialization");

                // Notify connected clients that configuration is being reloaded
                await _signalRService.BroadcastConfigurationReloading();

                // Get ConfigurationService and trigger reinitialization
                var configService = _serviceProvider.GetRequiredService<IConfigurationService>();
                await configService.ReinitializeApplicationAsync();

                // Notify connected clients that reinitialization is complete
                await _signalRService.BroadcastConfigurationReloaded();

                _logger.LogInformation("Automatic reinitialization completed after config.json change");
            }
            finally
            {
                _debounceGate.Release();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing config file change");
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("ConfigFileWatcherService stopping");

        if (_watcher != null)
        {
            _watcher.EnableRaisingEvents = false;
            _watcher.Changed -= OnConfigFileChanged;
            _watcher.Created -= OnConfigFileChanged;
            _watcher.Dispose();
            _watcher = null;
        }

        _debounceGate.Dispose();

        await base.StopAsync(cancellationToken);
    }
}
