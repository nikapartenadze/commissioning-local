namespace IO_Checkout_Tool.Services.Interfaces;

public interface IPlcInitializationService
{
    Task<bool> InitializeAsync();
    Task<bool> InitializePlcAfterCloudSync();
    event Action? InitializationCompleted;
    bool IsInitialized { get; }
} 