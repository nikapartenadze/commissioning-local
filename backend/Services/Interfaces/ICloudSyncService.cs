using Shared.Library.DTOs;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ICloudSyncService
{
    Task<List<Io>> GetSubsystemIosAsync(int subsystemId);
    Task<bool> SyncIoUpdateAsync(IoUpdateDto update);
    Task<bool> SyncIoUpdatesAsync(List<IoUpdateDto> updates);
    Task<bool> SyncTestHistoriesAsync(int subsystemId, List<TestHistoryDto> histories);
    Task<bool> IsCloudAvailable();
    Task<bool> TriggerFreshSyncAsync(bool skipPlcInitialization = false);
    bool IsConnected { get; }
    event Action? ConnectionStateChanged;
} 