using Shared.Library.Models.Entities;

namespace Shared.Library.Repositories.Interfaces;

/// <summary>
/// Shared repository interface for IO entities.
/// Implementations can choose to implement only the methods they need.
/// </summary>
public interface IIoRepository
{
    // Core read operations (required by both apps)
    Task<List<Io>> GetBySubsystemIdAsync(int subsystemId);
    Task<Io?> GetByIdAsync(int id);
    
    // Extended read operations (primarily Tool app)
    Task<List<Io>> GetAllAsync();
    Task<List<Io>> GetFilteredAsync(bool includeSpares = false);
    Task<Io?> GetNextUntestedAsync();
    Task<List<Io>> GetByResultAsync(string result);
    
    // Write operations (both apps need these)
    Task<Io> UpdateAsync(Io io);
    Task<Io> AddAsync(Io io);
    
    // Extended write operations (primarily Tool app)
    Task<Io> AddWithSpecificIdAsync(Io io);
    Task DeleteAsync(int id);
    Task DeleteRangeAsync(List<Io> ios);
    Task<int> SaveChangesAsync();
    
    // Batch operations
    Task<List<Io>> UpdateBatchAsync(List<Io> ios);
    Task<List<Io>> AddRangeAsync(List<Io> ios);
    Task<List<Io>> UpdateRangeAsync(List<Io> ios);
    
    // Statistics operations (primarily Tool app)
    Task<int> CountTotalTestableAsync();
    Task<int> CountByResultAsync(string result);
    Task<int> CountUntestedAsync();
} 