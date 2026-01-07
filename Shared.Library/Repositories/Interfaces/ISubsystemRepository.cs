using Shared.Library.Models.Entities;

namespace Shared.Library.Repositories.Interfaces;

/// <summary>
/// Shared repository interface for Subsystem entities.
/// Primarily used by Cloud app, but available for Tool app if needed.
/// </summary>
public interface ISubsystemRepository
{
    // Read operations
    Task<List<Subsystem>> GetAllAsync();
    Task<List<Subsystem>> GetByProjectIdAsync(int projectId);
    Task<Subsystem?> GetByIdAsync(int id);
    Task<Subsystem?> GetByNameAsync(string name, int projectId);
    
    // Write operations
    Task<Subsystem> AddAsync(Subsystem subsystem);
    Task<Subsystem> UpdateAsync(Subsystem subsystem);
    Task DeleteAsync(int id);
    Task DeleteByProjectIdAsync(int projectId);
    Task<int> SaveChangesAsync();
} 