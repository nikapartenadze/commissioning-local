using Microsoft.EntityFrameworkCore;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Repositories;

public class TestHistoryRepository : ITestHistoryRepository
{
    private readonly IDbContextFactory<TagsContext> _dbFactory;

    public TestHistoryRepository(IDbContextFactory<TagsContext> dbFactory)
    {
        _dbFactory = dbFactory;
    }

    public async Task<List<TestHistory>> GetAllAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        var histories = await db.TestHistories
            .Include(th => th.Io)
            .ToListAsync();
            
        // Sort by parsed DateTime to handle millisecond precision correctly
        return histories
            .OrderByDescending(h => DateTime.TryParse(h.Timestamp, out var dt) ? dt : DateTime.MinValue)
            .ToList();
    }

    public async Task<TestHistory?> GetByIdAsync(int id)
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.TestHistories
            .Include(th => th.Io)
            .FirstOrDefaultAsync(x => x.Id == id);
    }

    public async Task<List<TestHistory>> GetByIoIdAsync(int ioId, int limit = 100)
    {
        using var db = _dbFactory.CreateDbContext();
        var histories = await db.TestHistories
            .Where(x => x.IoId == ioId)
            .ToListAsync();
            
        // Sort by parsed DateTime to handle millisecond precision correctly
        return histories
            .OrderByDescending(h => DateTime.TryParse(h.Timestamp, out var dt) ? dt : DateTime.MinValue)
            .Take(limit)
            .ToList();
    }

    public async Task<List<TestHistory>> GetByResultAsync(string result)
    {
        using var db = _dbFactory.CreateDbContext();
        var histories = await db.TestHistories
            .Include(th => th.Io)
            .Where(x => x.Result == result)
            .ToListAsync();
            
        // Sort by parsed DateTime to handle millisecond precision correctly
        return histories
            .OrderByDescending(h => DateTime.TryParse(h.Timestamp, out var dt) ? dt : DateTime.MinValue)
            .ToList();
    }

    public async Task<List<TestHistory>> GetRecentAsync(int count = DatabaseConstants.Defaults.RECENT_HISTORY_COUNT)
    {
        using var db = _dbFactory.CreateDbContext();
        var histories = await db.TestHistories
            .Include(th => th.Io)
            .ToListAsync();
            
        // Sort by parsed DateTime and take the most recent
        return histories
            .OrderByDescending(h => DateTime.TryParse(h.Timestamp, out var dt) ? dt : DateTime.MinValue)
            .Take(count)
            .ToList();
    }

    public async Task<List<TestHistory>> GetByDateRangeAsync(DateTime startDate, DateTime endDate)
    {
        using var db = _dbFactory.CreateDbContext();
        
        // Convert DateTime to string format for comparison since Timestamp is stored as string
        var startDateString = startDate.ToString("MM/dd/yy");
        var endDateString = endDate.ToString("MM/dd/yy");
        
        var histories = await db.TestHistories
            .Include(th => th.Io)
            .Where(x => x.Timestamp != null && 
                       string.Compare(x.Timestamp.Substring(0, 8), startDateString) >= 0 &&
                       string.Compare(x.Timestamp.Substring(0, 8), endDateString) <= 0)
            .ToListAsync();
            
        // Sort by parsed DateTime to handle millisecond precision correctly
        return histories
            .OrderByDescending(h => DateTime.TryParse(h.Timestamp, out var dt) ? dt : DateTime.MinValue)
            .ToList();
    }

    public async Task<TestHistory> AddAsync(TestHistory testHistory)
    {
        using var db = _dbFactory.CreateDbContext();
        var entry = await db.TestHistories.AddAsync(testHistory);
        await db.SaveChangesAsync();
        return entry.Entity;
    }

    public async Task<TestHistory> UpdateAsync(TestHistory testHistory)
    {
        using var db = _dbFactory.CreateDbContext();
        db.TestHistories.Update(testHistory);
        await db.SaveChangesAsync();
        return testHistory;
    }

    public async Task DeleteAsync(int id)
    {
        using var db = _dbFactory.CreateDbContext();
        var testHistory = await db.TestHistories.FindAsync(id);
        if (testHistory != null)
        {
            db.TestHistories.Remove(testHistory);
            await db.SaveChangesAsync();
        }
    }

    public async Task DeleteByIoIdAsync(int ioId)
    {
        using var db = _dbFactory.CreateDbContext();
        var histories = await db.TestHistories
            .Where(x => x.IoId == ioId)
            .ToListAsync();
        
        if (histories.Any())
        {
            db.TestHistories.RemoveRange(histories);
            await db.SaveChangesAsync();
        }
    }

    public async Task<int> SaveChangesAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.SaveChangesAsync();
    }

    public async Task<List<TestHistory>> AddRangeAsync(List<TestHistory> histories)
    {
        using var db = _dbFactory.CreateDbContext();
        await db.TestHistories.AddRangeAsync(histories);
        await db.SaveChangesAsync();
        return histories;
    }

    public async Task<int> CountByResultAsync(string result)
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.TestHistories.CountAsync(x => x.Result == result);
    }

    public async Task<int> CountByIoIdAsync(int ioId)
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.TestHistories.CountAsync(x => x.IoId == ioId);
    }
} 