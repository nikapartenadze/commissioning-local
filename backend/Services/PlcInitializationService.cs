using IO_Checkout_Tool.Services.Interfaces;
using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;

namespace IO_Checkout_Tool.Services;

public class PlcInitializationService : IPlcInitializationService
{
    private readonly IPlcCommunicationService _plcCommunicationService;
    private readonly IConfigurationService _configService;
    private readonly IErrorDialogService _errorDialogService;
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly IStartupCoordinationService _startupCoordination;
    private readonly ILogger<PlcInitializationService> _logger;
    
    private bool _isInitialized = false;
    
    public bool IsInitialized => _isInitialized;
    public event Action? InitializationCompleted;

    public PlcInitializationService(
        IPlcCommunicationService plcCommunicationService,
        IConfigurationService configService,
        IErrorDialogService errorDialogService,
        IDbContextFactory<TagsContext> contextFactory,
        IStartupCoordinationService startupCoordination,
        ILogger<PlcInitializationService> logger)
    {
        _plcCommunicationService = plcCommunicationService;
        _configService = configService;
        _errorDialogService = errorDialogService;
        _contextFactory = contextFactory;
        _startupCoordination = startupCoordination;
        _logger = logger;
    }

    public async Task<bool> InitializeAsync()
    {
        if (_isInitialized)
            return true;

        if (!_configService.LoadConfiguration())
        {
            _errorDialogService.ShowConfigurationError();
            return false;
        }

        // Check if we have a subsystem mismatch that requires cloud sync first
        var needsCloudSync = await CheckIfCloudSyncNeeded();
        
        // Signal the coordination service about cloud sync requirement
        _startupCoordination.SetCloudSyncNeeded(needsCloudSync);
        
        if (needsCloudSync)
        {
            _logger.LogInformation("Subsystem mismatch detected - deferring PLC initialization until after cloud sync");
            
            // Start a timeout task in case cloud sync never completes
            _ = Task.Run(async () => await CloudSyncTimeoutHandler());
            
            // Don't initialize PLC yet - CloudSyncHostedService will call InitializePlcAfterCloudSync() when ready
            return true; // Return true to indicate service started successfully, just deferred
        }

        // No mismatch, proceed with normal PLC initialization
        return await InitializePlc();
    }

    /// <summary>
    /// Called by CloudSyncHostedService after cloud sync completes to initialize PLC with correct data
    /// </summary>
    public async Task<bool> InitializePlcAfterCloudSync()
    {
        _logger.LogInformation("Initializing PLC after cloud sync completion");
        return await InitializePlc();
    }

    private async Task<bool> InitializePlc()
    {
        var initSuccess = await _plcCommunicationService.InitializeAsync();
        
        if (initSuccess)
        {
            _isInitialized = true;
            InitializationCompleted?.Invoke();
        }
        
        return initSuccess;
    }

    private async Task<bool> CheckIfCloudSyncNeeded()
    {
        try
        {
            // If no remote URL configured, no cloud sync needed
            if (string.IsNullOrEmpty(_configService.RemoteUrl))
            {
                _logger.LogInformation("No cloud sync configured - proceeding with local database");
                return false;
            }

            var configSubsystemId = int.Parse(_configService.SubsystemId);
            
            using var context = _contextFactory.CreateDbContext();
            var iosInDatabase = await context.Ios.ToListAsync();
            
            if (!iosInDatabase.Any())
            {
                _logger.LogInformation("Database is empty - cloud sync needed to load initial data");
                return true;
            }

            // Check if all IOs in database belong to the configured subsystem
            var databaseSubsystems = iosInDatabase.Select(io => io.SubsystemId).Distinct().ToList();
            
            if (databaseSubsystems.Count == 1 && databaseSubsystems[0] == configSubsystemId)
            {
                _logger.LogInformation("Database contains correct subsystem {SubsystemId} data - no cloud sync needed", configSubsystemId);
                return false;
            }
            
            _logger.LogInformation("Database contains subsystems [{DatabaseSubsystems}] but config is for subsystem {ConfigSubsystem} - cloud sync needed", 
                string.Join(", ", databaseSubsystems), configSubsystemId);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error checking if cloud sync is needed - defaulting to no cloud sync");
            return false;
        }
    }

    /// <summary>
    /// Timeout handler for cloud sync - shows error if sync doesn't complete
    /// NOTE: With fixed service ordering, this should rarely trigger since CloudSyncHostedService 
    /// now completes before PlcInitializationService starts
    /// </summary>
    private async Task CloudSyncTimeoutHandler()
    {
        const int timeoutSeconds = 60; // Increased timeout since cloud sync now runs first
        
        await Task.Delay(TimeSpan.FromSeconds(timeoutSeconds));
        
        // Check if PLC was already initialized (cloud sync completed)
        if (_isInitialized)
        {
            _logger.LogDebug("Cloud sync completed within timeout period");
            return;
        }
        
        _logger.LogError("Cloud sync timeout after {TimeoutSeconds} seconds - cannot proceed safely", timeoutSeconds);
        
        // DO NOT call InitializeAsync() here as it interferes with proper cloud sync
        // Just show error and let background reconnection services handle recovery
        _logger.LogWarning("Not forcing initialization to avoid interference with cloud sync process");
        
        // Show error - do NOT proceed with local data for safety
        _errorDialogService.ShowError(
            "Cloud Sync Timeout",
            $"<p><strong>Cloud synchronization did not complete within {timeoutSeconds} seconds.</strong></p>" +
            $"<br/>" +
            $"<p><strong>For safety, the application cannot proceed without the correct I/O definitions from the cloud server.</strong></p>" +
            $"<br/>" +
            $"<div style='background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; padding: 12px;'>" +
            $"<p style='margin: 0 0 8px 0; color: #721c24;'><strong>⏱️ Connection Timeout</strong></p>" +
            $"<ul style='margin: 0; padding-left: 16px; color: #721c24;'>" +
            $"<li>Check your network connection</li>" +
            $"<li>Verify the cloud server is responding</li>" +
            $"<li><strong>Try the cloud sync button</strong> when connectivity improves</li>" +
            $"<li><strong>Restart the application</strong> to retry initialization</li>" +
            $"</ul>" +
            $"<p style='margin: 8px 0 0 0; color: #721c24; font-style: italic;'>Background reconnection will continue automatically.</p>" +
            $"</div>"
        );
    }
} 