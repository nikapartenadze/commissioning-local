using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services;

public class PlcInitializationHostedService : BackgroundService
{
    private readonly IPlcInitializationService _plcInitializationService;
    private readonly IStartupCoordinationService _startupCoordination;
    private readonly ILogger<PlcInitializationHostedService> _logger;

    public PlcInitializationHostedService(
        IPlcInitializationService plcInitializationService,
        IStartupCoordinationService startupCoordination,
        ILogger<PlcInitializationHostedService> logger)
    {
        _plcInitializationService = plcInitializationService;
        _startupCoordination = startupCoordination;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            // First, let PlcInitializationService determine if cloud sync is needed
            _logger.LogInformation("PlcInitializationHostedService starting - checking initialization requirements...");
            var success = await _plcInitializationService.InitializeAsync();
            
            // If cloud sync is needed, wait for it to complete
            if (_startupCoordination.IsCloudSyncNeeded && !_startupCoordination.IsStartupComplete)
            {
                _logger.LogInformation("Cloud sync required - waiting for CloudSyncHostedService to complete...");
                
                try
                {
                    // Wait for startup completion with cancellation support
                    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                    var completionTask = _startupCoordination.StartupCompletionTask;
                    var delayTask = Task.Delay(Timeout.Infinite, linkedCts.Token);
                    
                    var completedTask = await Task.WhenAny(completionTask, delayTask);
                    
                    if (completedTask == completionTask)
                    {
                        // Startup completed, check result
                        var result = await completionTask;
                        if (result)
                        {
                            _logger.LogInformation("Cloud sync completed successfully - PLC initialization handled by CloudSyncHostedService");
                        }
                        else
                        {
                            _logger.LogWarning("Cloud sync completed with failure - PLC initialization may not be complete");
                        }
                    }
                    else
                    {
                        _logger.LogInformation("PlcInitializationHostedService cancelled during cloud sync wait");
                    }
                }
                catch (OperationCanceledException)
                {
                    _logger.LogInformation("PlcInitializationHostedService cancelled while waiting for cloud sync");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error waiting for cloud sync completion");
                }
            }
            else
            {
                // No cloud sync needed or already complete
                if (success)
                {
                    _logger.LogInformation(PlcConstants.LogMessages.PlcInitSuccess);
                    _startupCoordination.SignalStartupComplete();
                }
                else
                {
                    _logger.LogWarning(PlcConstants.LogMessages.PlcInitFailed);
                    _startupCoordination.SignalStartupFailed();
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, PlcConstants.LogMessages.PlcInitError);
            _startupCoordination.SignalStartupFailed(ex);
        }
    }
} 