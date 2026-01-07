namespace IO_Checkout_Tool.Services.Interfaces;

public interface IStartupCoordinationService
{
    /// <summary>
    /// Indicates whether cloud sync is needed during startup
    /// </summary>
    bool IsCloudSyncNeeded { get; }
    
    /// <summary>
    /// Indicates whether the startup initialization (cloud sync or direct PLC init) has completed
    /// </summary>
    bool IsStartupComplete { get; }
    
    /// <summary>
    /// Task that completes when startup initialization is finished
    /// </summary>
    Task<bool> StartupCompletionTask { get; }
    
    /// <summary>
    /// Set whether cloud sync is needed (called by PlcInitializationService)
    /// </summary>
    void SetCloudSyncNeeded(bool needed);
    
    /// <summary>
    /// Signal that startup initialization has completed successfully
    /// </summary>
    void SignalStartupComplete();
    
    /// <summary>
    /// Signal that startup initialization failed
    /// </summary>
    void SignalStartupFailed(Exception? exception = null);
} 