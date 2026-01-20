using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;

namespace IO_Checkout_Tool.Tests.TestHelpers;

/// <summary>
/// A test implementation of IDbContextFactory that creates fresh in-memory database contexts.
/// Each call to CreateDbContext/CreateDbContextAsync creates a new context instance,
/// but all contexts share the same in-memory database (identified by the database name).
/// </summary>
public class InMemoryDbContextFactory : IDbContextFactory<TagsContext>
{
    private readonly DbContextOptions<TagsContext> _options;

    public InMemoryDbContextFactory(string databaseName)
    {
        _options = new DbContextOptionsBuilder<TagsContext>()
            .UseInMemoryDatabase(databaseName: databaseName)
            .Options;
    }

    public TagsContext CreateDbContext()
    {
        return new TagsContext(_options);
    }

    public async Task<TagsContext> CreateDbContextAsync(CancellationToken cancellationToken = default)
    {
        // For in-memory database, creation is synchronous, but we return a task for async compatibility
        await Task.CompletedTask;
        return new TagsContext(_options);
    }
}
