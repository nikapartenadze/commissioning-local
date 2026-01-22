using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;

namespace IO_Checkout_Tool.Services;

public class DatabaseInitializationHostedService : IHostedService
{
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly ILogger<DatabaseInitializationHostedService> _logger;

    public DatabaseInitializationHostedService(
        IDbContextFactory<TagsContext> contextFactory,
        ILogger<DatabaseInitializationHostedService> logger)
    {
        _contextFactory = contextFactory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Initializing database...");
            
            using var context = _contextFactory.CreateDbContext();
            
            // This will create the database if it doesn't exist
            await context.Database.EnsureCreatedAsync(cancellationToken);
            
            // Initialize database with SQL-specific configurations and migrations
            context.InitializeDatabase();
            
            _logger.LogInformation("Database initialized successfully");
            
            // Log the database location
            var connectionString = context.Database.GetConnectionString();
            _logger.LogInformation("Database location: {ConnectionString}", connectionString);
            
            // Check if there are any IOs in the database
            var ioCount = await context.Ios.CountAsync(cancellationToken);
            _logger.LogInformation("Database contains {Count} IOs", ioCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize database");
            // Don't throw - let the application continue even if database init fails
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }
} 