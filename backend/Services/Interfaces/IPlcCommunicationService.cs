using Shared.Library.Models.Entities;
namespace IO_Checkout_Tool.Services.Interfaces;

public interface IPlcCommunicationService
{
    List<Io> TagList { get; }
    bool DisableTesting { get; }
    bool Loading { get; }
    bool IsPlcConnected { get; }
    
    event Action<Io>? NotifyIo;
    event Action? NotifyState;
    event Action? PlcConnectionChanged;
    
    Task<bool> InitializeAsync();
    void InitializeOutputTag(Io tag);
    void ToggleBit();
    Task ReloadDataAsync();
    Task ReloadDataAfterCloudSyncAsync();
    void UpdatePlcConnectionStatus(bool isConnected);
    Task ReinitializePlcConnectionAsync();
    Task PauseForCloudSyncAsync();
    Task ResumeAfterCloudSyncAsync();
    Task RefreshTagListFromDatabaseAsync();
    Task ReconnectAsync(string ip, string path); // Reconnect to PLC with new configuration
} 