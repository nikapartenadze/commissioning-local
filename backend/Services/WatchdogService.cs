using System;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.PlcTags;
using IO_Checkout_Tool.Services.PlcTags.Native;
using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services;

public class WatchdogService : IWatchdogService
{
    private readonly IConfigurationService _configService;
    private readonly IErrorDialogService _errorDialogService;
    private readonly IPlcTagFactoryService _plcTagFactory;
    private readonly ILogger<WatchdogService> _logger;
    
    private bool _enableWatchdog = false;
    private bool _testingStarted = false;
    private bool _loading = false;
    private string _watchdogColor = PlcConstants.Colors.WatchdogInactive;
    private NativeTag? _watchdogTag;
    private DateTime _lastErrorDialogTime = DateTime.MinValue;
    private readonly TimeSpan _errorDialogCooldown = TimeSpan.FromSeconds(5); // Quick notification but prevent spam
    private readonly object _tagLock = new object(); // Lock for thread-safe tag operations
    
    public bool TestingStarted => _testingStarted;
    public string WatchdogColor => _watchdogColor;
    public bool Loading => _loading;
    
    public event Action? NotifyAlert;
    public event Action? WatchdogStateChanged;
    
    public WatchdogService(
        IConfigurationService configService, 
        IErrorDialogService errorDialogService,
        IPlcTagFactoryService plcTagFactory,
        ILogger<WatchdogService> logger)
    {
        _configService = configService;
        _errorDialogService = errorDialogService;
        _plcTagFactory = plcTagFactory;
        _logger = logger;
        _errorDialogService.NotifyAlert += () => NotifyAlert?.Invoke();
        
        // Always start watchdog for UI state management
        _ = StartWatchdogAsync();
    }
    
    public async Task ToggleWatchdogAsync()
    {
        if (_configService.DisableWatchdog)
        {
            _logger.LogInformation("Toggling watchdog UI state from {CurrentState} (PLC communication disabled by config)", 
                _enableWatchdog ? "enabled" : "disabled");
        }
        else
        {
            _logger.LogInformation("Toggling watchdog state from {CurrentState} (PLC communication enabled)", 
                _enableWatchdog ? "enabled" : "disabled");
        }
        
        _loading = true;
        _enableWatchdog = !_enableWatchdog;
        
        await Task.Delay(PlcConstants.WatchdogToggleDelay);
        
        if (!_enableWatchdog)
        {
            _watchdogColor = PlcConstants.Colors.WatchdogInactive;
            _testingStarted = false;
        }
        else
        {
            _watchdogColor = PlcConstants.Colors.WatchdogActive;
            _testingStarted = true;
        }
        
        _loading = false;
        WatchdogStateChanged?.Invoke();
    }
    
    public async Task ReinitializeWatchdogAsync()
    {
        _logger.LogInformation("Reinitializing watchdog with new configuration - IP: {Ip}, Path: {Path}, DisableWatchdog: {DisableWatchdog}", 
            _configService.Ip, _configService.Path, _configService.DisableWatchdog);
        
        lock (_tagLock)
        {
            // Dispose the old watchdog tag if it exists
            if (_watchdogTag != null)
            {
                _logger.LogInformation("Disposing old watchdog tag");
                try
                {
                    _watchdogTag.Dispose();
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Error disposing old watchdog tag");
                }
                _watchdogTag = null;
            }
            
            // Create new watchdog tag with fresh IP/Path if PLC communication is enabled
            if (!_configService.DisableWatchdog)
            {
                _logger.LogInformation("Creating new watchdog tag with IP: {Ip}, Path: {Path}", 
                    _configService.Ip, _configService.Path);
                
                try
                {
                    _watchdogTag = _plcTagFactory.CreateReadTag(PlcConstants.WatchdogTagName);
                    
                    // Try to initialize the new tag
                    var status = _watchdogTag.Initialize();
                    if (status != LibPlcTag.PLCTAG_STATUS_OK)
                    {
                        _logger.LogWarning("Failed to initialize new watchdog tag: {Error}", LibPlcTag.DecodeError(status));
                        // Don't dispose - continue anyway to allow testing without watchdog
                    }
                    else
                    {
                        _logger.LogInformation("Successfully initialized new watchdog tag");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error creating new watchdog tag");
                    _watchdogTag = null;
                }
            }
            else
            {
                _logger.LogInformation("Watchdog PLC communication disabled by configuration - no tag created");
            }
        }
        
        _logger.LogInformation("Watchdog reinitialization completed");
    }
    
    private void ShowWatchdogCommunicationError()
    {
        // Throttle error dialogs to prevent spam
        if (DateTime.Now - _lastErrorDialogTime < _errorDialogCooldown)
        {
            return;
        }
        
        _lastErrorDialogTime = DateTime.Now;
        _logger.LogError("Watchdog communication failure detected");
        _errorDialogService.ShowPlcCommunicationError();
    }

    public async Task StartWatchdogAsync()
    {
        _logger.LogInformation("WatchdogService starting - DisableWatchdog config: {DisableWatchdog}", _configService.DisableWatchdog);
        
        if (_configService.DisableWatchdog || string.IsNullOrEmpty(_configService.Ip))
        {
            _logger.LogInformation(string.IsNullOrEmpty(_configService.Ip)
                ? "Watchdog skipped — no PLC IP configured yet. Configure via UI."
                : "Watchdog PLC communication disabled by configuration");
            _watchdogTag = null; // Ensure tag is null when disabled
        }
        else
        {
            // Create the watchdog tag only if PLC communication is enabled
            _watchdogTag = _plcTagFactory.CreateReadTag(PlcConstants.WatchdogTagName);
            
            // Try to initialize the tag
            var status = _watchdogTag.Initialize();
            if (status != LibPlcTag.PLCTAG_STATUS_OK)
            {
                _logger.LogError("Failed to initialize watchdog tag: {Error}", LibPlcTag.DecodeError(status));
                // Don't return - continue anyway to allow testing without watchdog
            }
        }
        
        while (true)
        {
            await Task.Delay(PlcConstants.WatchdogInterval);
            
            // Use lock to ensure thread-safe access to _watchdogTag
            NativeTag? currentTag;
            lock (_tagLock)
            {
                currentTag = _watchdogTag;
            }
            
            // Only do PLC communication if enabled and watchdog is active
            if (_enableWatchdog && !_configService.DisableWatchdog && currentTag != null)
            {
                try
                {
                    // Try to read the watchdog tag
                    var readStatus = currentTag.Read();
                    if (readStatus != LibPlcTag.PLCTAG_STATUS_OK)
                    {
                        _logger.LogWarning("Failed to read watchdog tag: {Error}", LibPlcTag.DecodeError(readStatus));
                        ShowWatchdogCommunicationError();
                        // Continue without disabling - just log the error
                        continue;
                    }
                    
                    if (currentTag.Value == 0)
                    {
                        // Set the watchdog active value
                        currentTag.Value = TestConstants.PlcValues.WATCHDOG_ACTIVE;
                        
                        // Try to write the watchdog tag
                        var writeStatus = currentTag.Write();
                        if (writeStatus != LibPlcTag.PLCTAG_STATUS_OK)
                        {
                            _logger.LogWarning("Failed to write watchdog tag: {Error}", LibPlcTag.DecodeError(writeStatus));
                            ShowWatchdogCommunicationError();
                            // Continue without disabling - just log the error
                            continue;
                        }
                    }
                    else
                    {
                        // Watchdog failed - show error but don't disable
                        _logger.LogError("Watchdog value is not zero, indicating PLC watchdog failure");
                        _errorDialogService.ShowWatchdogError();
                        
                        // Don't automatically toggle off - let the user decide
                        // await ToggleWatchdogAsync();
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error in watchdog loop");
                    ShowWatchdogCommunicationError();
                    // Continue without disabling
                }
            }
            // If watchdog PLC communication is disabled, the loop continues but skips PLC operations
            // This allows the UI state (_enableWatchdog, _testingStarted) to still work via ToggleWatchdogAsync()
        }
    }
} 