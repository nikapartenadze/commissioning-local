using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Coordinates startup between CloudSyncHostedService and PlcInitializationHostedService
/// to eliminate race conditions and arbitrary delays
/// </summary>
public class StartupCoordinationService : IStartupCoordinationService
{
    private readonly TaskCompletionSource<bool> _startupCompletionSource = new();
    private readonly ILogger<StartupCoordinationService> _logger;
    private readonly object _lockObject = new();
    
    public StartupCoordinationService(ILogger<StartupCoordinationService> logger)
    {
        _logger = logger;
    }
    
    public bool IsCloudSyncNeeded { get; private set; }
    
    public bool IsStartupComplete { get; private set; }
    
    public Task<bool> StartupCompletionTask => _startupCompletionSource.Task;
    
    public void SetCloudSyncNeeded(bool needed)
    {
        lock (_lockObject)
        {
            if (IsStartupComplete)
            {
                _logger.LogWarning("Attempted to set cloud sync needed status after startup completion");
                return;
            }
            
            IsCloudSyncNeeded = needed;
            _logger.LogInformation("Cloud sync needed status set to: {CloudSyncNeeded}", needed);
        }
    }
    
    public void SignalStartupComplete()
    {
        lock (_lockObject)
        {
            if (IsStartupComplete)
            {
                _logger.LogDebug("Startup completion already signaled");
                return;
            }
            
            IsStartupComplete = true;
            _logger.LogInformation("Startup initialization completed successfully");
            _startupCompletionSource.SetResult(true);
        }
    }
    
    public void SignalStartupFailed(Exception? exception = null)
    {
        lock (_lockObject)
        {
            if (IsStartupComplete)
            {
                _logger.LogWarning("Attempted to signal startup failure after completion");
                return;
            }
            
            IsStartupComplete = true;
            _logger.LogError(exception, "Startup initialization failed");
            
            if (exception != null)
            {
                _startupCompletionSource.SetException(exception);
            }
            else
            {
                _startupCompletionSource.SetResult(false);
            }
        }
    }
} 