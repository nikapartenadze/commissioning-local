using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Constants;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Repositories;

public class IoRepository : IIoRepository
{
    private readonly IDbContextFactory<TagsContext> _dbFactory;

    public IoRepository(IDbContextFactory<TagsContext> dbFactory)
    {
        _dbFactory = dbFactory;
    }

    public async Task<List<Io>> GetAllAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios.ToListAsync();
    }

    public async Task<Io?> GetByIdAsync(int id)
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios.FirstOrDefaultAsync(x => x.Id == id);
    }

    public async Task<List<Io>> GetFilteredAsync(bool includeSpares = false)
    {
        using var db = _dbFactory.CreateDbContext();
        
        var query = db.Ios.AsQueryable();
        
        if (!includeSpares)
        {
            query = query.Where(x => !x.Description.Contains("SPARE") && 
                                   x.Description != TestConstants.DESC_INPUT && 
                                   x.Description != TestConstants.DESC_OUTPUT);
        }
        
        return await query.ToListAsync();
    }

    public async Task<Io?> GetNextUntestedAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios
            .Where(x => (x.Result == null || x.Result == string.Empty) && x.Order != null)
            .OrderBy(x => x.Order)
            .FirstOrDefaultAsync();
    }

    public async Task<List<Io>> GetByResultAsync(string result)
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios
            .Where(x => x.Result == result)
            .ToListAsync();
    }

    public async Task<List<Io>> GetBySubsystemIdAsync(int subsystemId)
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios
            .Where(x => x.SubsystemId == subsystemId)
            .ToListAsync();
    }

    public async Task<Io> AddAsync(Io io)
    {
        using var db = _dbFactory.CreateDbContext();
        var entry = await db.Ios.AddAsync(io);
        await db.SaveChangesAsync();
        return entry.Entity;
    }

    public async Task<Io> AddWithSpecificIdAsync(Io io)
    {
        using var db = _dbFactory.CreateDbContext();
        
        // For SQLite, we need to enable IDENTITY_INSERT behavior
        // by explicitly setting the ID value
        if (io.Id > 0)
        {
            // First, ensure the ID doesn't already exist
            var existing = await db.Ios.FindAsync(io.Id);
            if (existing != null)
            {
                throw new InvalidOperationException($"IO with ID {io.Id} already exists");
            }
            
            // Add the entity with the specific ID
            db.Entry(io).State = EntityState.Added;
            await db.SaveChangesAsync();
            return io;
        }
        else
        {
            // If no ID specified, use regular Add
            return await AddAsync(io);
        }
    }

    public async Task<Io> UpdateAsync(Io io)
    {
        using var db = _dbFactory.CreateDbContext();
        db.Ios.Update(io);
        await db.SaveChangesAsync();
        return io;
    }

    public async Task DeleteAsync(int id)
    {
        using var db = _dbFactory.CreateDbContext();
        var io = await db.Ios.FindAsync(id);
        if (io != null)
        {
            db.Ios.Remove(io);
            await db.SaveChangesAsync();
        }
    }

    public async Task DeleteRangeAsync(List<Io> ios)
    {
        using var db = _dbFactory.CreateDbContext();
        db.Ios.RemoveRange(ios);
        await db.SaveChangesAsync();
    }

    public async Task<int> SaveChangesAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.SaveChangesAsync();
    }

    public async Task<List<Io>> AddRangeAsync(List<Io> ios)
    {
        using var db = _dbFactory.CreateDbContext();
        await db.Ios.AddRangeAsync(ios);
        await db.SaveChangesAsync();
        return ios;
    }

    public async Task<List<Io>> UpdateRangeAsync(List<Io> ios)
    {
        using var db = _dbFactory.CreateDbContext();
        db.Ios.UpdateRange(ios);
        await db.SaveChangesAsync();
        return ios;
    }

    public async Task<List<Io>> UpdateBatchAsync(List<Io> ios)
    {
        // Alias for UpdateRangeAsync to match the shared interface
        return await UpdateRangeAsync(ios);
    }

    public async Task<int> CountTotalTestableAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios
            .CountAsync(x => (!x.Description.Contains("SPARE") && 
                             x.Description != TestConstants.DESC_INPUT && 
                             x.Description != TestConstants.DESC_OUTPUT) || 
                            x.Result == TestConstants.RESULT_FAILED);
    }

    public async Task<int> CountByResultAsync(string result)
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios.CountAsync(x => x.Result == result);
    }

    public async Task<int> CountUntestedAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        return await db.Ios
            .CountAsync(x => !x.Description.Contains("SPARE") && 
                           x.Description != TestConstants.DESC_INPUT && 
                           x.Description != TestConstants.DESC_OUTPUT && 
                           (x.Result == null || x.Result == string.Empty));
    }
} 