using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;

namespace IO_Checkout_Tool.Services;

public class DatabaseInitializationHostedService : IHostedService
{
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly ILogger<DatabaseInitializationHostedService> _logger;
    private readonly IWebHostEnvironment _environment;
    private readonly IServiceProvider _serviceProvider;

    public DatabaseInitializationHostedService(
        IDbContextFactory<TagsContext> contextFactory,
        ILogger<DatabaseInitializationHostedService> logger,
        IWebHostEnvironment environment,
        IServiceProvider serviceProvider)
    {
        _contextFactory = contextFactory;
        _logger = logger;
        _environment = environment;
        _serviceProvider = serviceProvider;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            // Auto-backup existing database before any initialization
            BackupDatabase();

            _logger.LogInformation("Initializing database...");

            using var context = _contextFactory.CreateDbContext();

            // This will create the database if it doesn't exist
            await context.Database.EnsureCreatedAsync(cancellationToken);

            _logger.LogInformation("Database initialized successfully");

            // Log the database location
            var connectionString = context.Database.GetConnectionString();
            _logger.LogInformation("Database location: {ConnectionString}", connectionString);

            // Check if there are any IOs in the database
            var ioCount = await context.Ios.CountAsync(cancellationToken);
            _logger.LogInformation("Database contains {Count} IOs", ioCount);

            // Auto-import sample diagnostic data if TagTypeDiagnostics table is empty
            await SeedDiagnosticDataAsync(context, cancellationToken);

            // Run network discovery to populate NetworkDevices from existing IOs
            await RunNetworkDiscoveryAsync(context, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize database");
            // Don't throw - let the application continue even if database init fails
        }
    }

    private async Task SeedDiagnosticDataAsync(TagsContext context, CancellationToken cancellationToken)
    {
        try
        {
            var diagnosticCount = await context.TagTypeDiagnostics.CountAsync(cancellationToken);
            if (diagnosticCount > 0)
            {
                _logger.LogInformation("TagTypeDiagnostics table already has {Count} entries, skipping seed", diagnosticCount);
                return;
            }

            // Look for SampleDiagnosticData.sql in the application directory
            var sqlFilePath = Path.Combine(_environment.ContentRootPath, "SampleDiagnosticData.sql");
            if (!File.Exists(sqlFilePath))
            {
                _logger.LogWarning("SampleDiagnosticData.sql not found at {Path}, skipping diagnostic seed", sqlFilePath);
                return;
            }

            _logger.LogInformation("TagTypeDiagnostics table is empty, seeding from SampleDiagnosticData.sql...");

            var sql = await File.ReadAllTextAsync(sqlFilePath, cancellationToken);

            // Execute the SQL statements (filter out comment-only lines)
            var statements = sql
                .Split(';')
                .Select(s => s.Trim())
                .Where(s => !string.IsNullOrWhiteSpace(s) && !s.StartsWith("--"));

            foreach (var statement in statements)
            {
                try
                {
                    await context.Database.ExecuteSqlRawAsync(statement + ";", cancellationToken);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to execute diagnostic seed statement (may already exist)");
                }
            }

            var newCount = await context.TagTypeDiagnostics.CountAsync(cancellationToken);
            _logger.LogInformation("Seeded {Count} diagnostic entries from SampleDiagnosticData.sql", newCount);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to seed diagnostic data - non-critical, continuing startup");
        }
    }

    private async Task RunNetworkDiscoveryAsync(TagsContext context, CancellationToken cancellationToken)
    {
        try
        {
            var ioCount = await context.Ios.CountAsync(cancellationToken);
            if (ioCount == 0)
            {
                _logger.LogInformation("No IOs in database, skipping network discovery");
                return;
            }

            // Get unique subsystem IDs from existing IOs
            var subsystemIds = await context.Ios
                .Select(io => io.SubsystemId)
                .Distinct()
                .ToListAsync(cancellationToken);

            using var scope = _serviceProvider.CreateScope();
            var discoveryService = scope.ServiceProvider.GetRequiredService<IO_Checkout_Tool.Services.Interfaces.INetworkDiscoveryService>();

            foreach (var subsystemId in subsystemIds)
            {
                await discoveryService.DiscoverDevicesAsync(subsystemId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to run network discovery - non-critical, continuing startup");
        }
    }

    private void BackupDatabase()
    {
        try
        {
            var dbPath = IO_Checkout_Tool.Constants.DatabaseConstants.DatabasePath;
            if (!File.Exists(dbPath))
            {
                _logger.LogInformation("No existing database to backup");
                return;
            }

            var backupPath = $"{dbPath}.backup";
            File.Copy(dbPath, backupPath, overwrite: true);

            // Also copy WAL and SHM files if they exist (SQLite journal files)
            var walPath = $"{dbPath}-wal";
            var shmPath = $"{dbPath}-shm";
            if (File.Exists(walPath))
                File.Copy(walPath, $"{backupPath}-wal", overwrite: true);
            if (File.Exists(shmPath))
                File.Copy(shmPath, $"{backupPath}-shm", overwrite: true);

            var fileInfo = new FileInfo(dbPath);
            _logger.LogInformation("Database backed up: {DbPath} → {BackupPath} ({Size:F1} KB)",
                dbPath, backupPath, fileInfo.Length / 1024.0);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to backup database — non-critical, continuing startup");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }
} 