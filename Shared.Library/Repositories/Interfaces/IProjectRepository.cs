using Shared.Library.Models.Entities;

namespace Shared.Library.Repositories.Interfaces;

/// <summary>
/// Shared repository interface for Project entities.
/// Primarily used by Cloud app, but available for Tool app if needed.
/// </summary>
public interface IProjectRepository
{
    // Read operations
    Task<List<Project>> GetAllAsync();
    Task<Project?> GetByIdAsync(int id);
    Task<Project?> GetByNameAsync(string name);
    
    // Write operations
    Task<Project> AddAsync(Project project);
    Task<Project> UpdateAsync(Project project);
    Task DeleteAsync(int id);
    Task<int> SaveChangesAsync();
} 