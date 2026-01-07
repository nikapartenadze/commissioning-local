using Shared.Library.Models.Entities;

namespace Shared.Library.Repositories.Interfaces;

/// <summary>
/// Shared repository interface for PendingSync entities.
/// Used by Tool app for offline sync queue management.
/// Cloud app doesn't need to implement this interface.
/// </summary>
public interface IPendingSyncRepository
{
    // Read operations
    Task<List<PendingSync>> GetAllPendingSyncsAsync();
    Task<List<PendingSync>> GetByIoIdAsync(int ioId);
    Task<List<PendingSync>> GetFailedSyncsAsync(int maxRetryCount = 3);
    Task<PendingSync?> GetByIdAsync(int id);
    Task<int> GetPendingSyncCountAsync();
    
    // Write operations
    Task AddPendingSyncAsync(PendingSync pendingSync);
    Task<PendingSync> UpdateAsync(PendingSync pendingSync);
    Task RemovePendingSyncAsync(int id);
    Task RemovePendingSyncsAsync(List<int> ids);
    Task UpdateRetryCountAsync(int id, string error);
    Task<int> SaveChangesAsync();
    
    // Bulk operations
    Task<List<PendingSync>> AddRangeAsync(List<PendingSync> pendingSyncs);
    Task ClearAllAsync();
} 