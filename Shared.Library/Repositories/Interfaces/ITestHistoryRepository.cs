using Shared.Library.Models.Entities;

namespace Shared.Library.Repositories.Interfaces;

/// <summary>
/// Shared repository interface for TestHistory entities.
/// Implementations can choose to implement only the methods they need.
/// </summary>
public interface ITestHistoryRepository
{
    // Core read operations (both apps)
    Task<List<TestHistory>> GetByIoIdAsync(int ioId, int limit = 100);
    Task<TestHistory?> GetByIdAsync(int id);
    
    // Extended read operations (primarily Tool app)
    Task<List<TestHistory>> GetAllAsync();
    Task<List<TestHistory>> GetByResultAsync(string result);
    Task<List<TestHistory>> GetRecentAsync(int count = 50);
    Task<List<TestHistory>> GetByDateRangeAsync(DateTime startDate, DateTime endDate);
    
    // Write operations (both apps)
    Task<TestHistory> AddAsync(TestHistory testHistory);
    Task<TestHistory> UpdateAsync(TestHistory testHistory);
    Task DeleteAsync(int id);
    Task DeleteByIoIdAsync(int ioId);
    Task<int> SaveChangesAsync();
    
    // Bulk operations
    Task<List<TestHistory>> AddRangeAsync(List<TestHistory> histories);
    
    // Statistics operations (primarily Tool app)
    Task<int> CountByResultAsync(string result);
    Task<int> CountByIoIdAsync(int ioId);
} 