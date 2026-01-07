using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;
using Shared.Library.Repositories.Interfaces;

namespace IO_Checkout_Tool.Repositories;

public class PendingSyncRepository : IPendingSyncRepository
{
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly ILogger<PendingSyncRepository> _logger;

    public PendingSyncRepository(
        IDbContextFactory<TagsContext> contextFactory,
        ILogger<PendingSyncRepository> logger)
    {
        _contextFactory = contextFactory;
        _logger = logger;
    }

    public async Task<List<PendingSync>> GetAllPendingSyncsAsync()
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        return await context.PendingSyncs
            .OrderBy(p => p.CreatedAt)
            .ToListAsync();
    }

    public async Task AddPendingSyncAsync(PendingSync pendingSync)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        context.PendingSyncs.Add(pendingSync);
        await context.SaveChangesAsync();
        _logger.LogDebug("Added pending sync for IO {IoId}", pendingSync.IoId);
    }

    public async Task RemovePendingSyncAsync(int id)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        var pendingSync = await context.PendingSyncs.FindAsync(id);
        if (pendingSync != null)
        {
            context.PendingSyncs.Remove(pendingSync);
            await context.SaveChangesAsync();
            _logger.LogDebug("Removed pending sync {Id}", id);
        }
    }

    public async Task RemovePendingSyncsAsync(List<int> ids)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        var pendingSyncs = await context.PendingSyncs
            .Where(p => ids.Contains(p.Id))
            .ToListAsync();
        
        if (pendingSyncs.Any())
        {
            context.PendingSyncs.RemoveRange(pendingSyncs);
            await context.SaveChangesAsync();
            _logger.LogDebug("Removed {Count} pending syncs", pendingSyncs.Count);
        }
    }

    public async Task UpdateRetryCountAsync(int id, string error)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        var pendingSync = await context.PendingSyncs.FindAsync(id);
        if (pendingSync != null)
        {
            pendingSync.RetryCount++;
            pendingSync.LastError = error;
            await context.SaveChangesAsync();
            _logger.LogDebug("Updated retry count for pending sync {Id} to {RetryCount}", id, pendingSync.RetryCount);
        }
    }

    public async Task<int> GetPendingSyncCountAsync()
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        return await context.PendingSyncs.CountAsync();
    }

    // Additional methods required by shared interface
    public async Task<List<PendingSync>> GetByIoIdAsync(int ioId)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        return await context.PendingSyncs
            .Where(p => p.IoId == ioId)
            .OrderBy(p => p.CreatedAt)
            .ToListAsync();
    }

    public async Task<List<PendingSync>> GetFailedSyncsAsync(int maxRetryCount = 3)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        return await context.PendingSyncs
            .Where(p => p.RetryCount >= maxRetryCount)
            .OrderBy(p => p.CreatedAt)
            .ToListAsync();
    }

    public async Task<PendingSync?> GetByIdAsync(int id)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        return await context.PendingSyncs.FindAsync(id);
    }

    public async Task<PendingSync> UpdateAsync(PendingSync pendingSync)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        context.PendingSyncs.Update(pendingSync);
        await context.SaveChangesAsync();
        _logger.LogDebug("Updated pending sync {Id}", pendingSync.Id);
        return pendingSync;
    }

    public async Task<int> SaveChangesAsync()
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        return await context.SaveChangesAsync();
    }

    public async Task<List<PendingSync>> AddRangeAsync(List<PendingSync> pendingSyncs)
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        context.PendingSyncs.AddRange(pendingSyncs);
        await context.SaveChangesAsync();
        _logger.LogDebug("Added {Count} pending syncs", pendingSyncs.Count);
        return pendingSyncs;
    }

    public async Task ClearAllAsync()
    {
        using var context = await _contextFactory.CreateDbContextAsync();
        var allSyncs = await context.PendingSyncs.ToListAsync();
        if (allSyncs.Any())
        {
            context.PendingSyncs.RemoveRange(allSyncs);
            await context.SaveChangesAsync();
            _logger.LogInformation("Cleared all {Count} pending syncs", allSyncs.Count);
        }
    }
} 