namespace IO_Checkout_Tool.Services.Interfaces;

public interface IWatchdogService
{
    bool TestingStarted { get; }
    string WatchdogColor { get; }
    bool Loading { get; }
    
    event Action? NotifyAlert;
    
    Task ToggleWatchdogAsync();
    Task StartWatchdogAsync();
    Task ReinitializeWatchdogAsync();
} 