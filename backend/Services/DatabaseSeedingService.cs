using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Repositories.Interfaces;
using Shared.Library.Models.Entities;
using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services;

public class DatabaseSeedingService : IDatabaseSeedingService
{
    private readonly IIoRepository _ioRepository;
    private readonly IConfigurationService _configService;
    private readonly ILogger<DatabaseSeedingService> _logger;

    public DatabaseSeedingService(
        IIoRepository ioRepository, 
        IConfigurationService configService,
        ILogger<DatabaseSeedingService> logger)
    {
        _ioRepository = ioRepository;
        _configService = configService;
        _logger = logger;
    }

    public async Task<bool> SeedDatabaseWithTestTagsAsync(int numberOfTags = 1000)
    {
        try
        {
            _logger.LogInformation("Starting database seeding with {NumberOfTags} test tags", numberOfTags);

            // Parse subsystem ID from configuration
            if (!int.TryParse(_configService.SubsystemId, out var subsystemId))
            {
                _logger.LogError("Invalid SubsystemId in configuration: {SubsystemId}", _configService.SubsystemId);
                return false;
            }

            // Clear existing IO records
            await ClearExistingIoRecordsAsync();

            // Create test tags
            var testTags = CreateTestTags(numberOfTags, subsystemId);

            // Add tags to database in batches for better performance
            await AddTagsInBatchesAsync(testTags);

            _logger.LogInformation("Successfully seeded database with {NumberOfTags} test tags", numberOfTags);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error occurred while seeding database with test tags");
            return false;
        }
    }

    private async Task ClearExistingIoRecordsAsync()
    {
        _logger.LogInformation("Clearing existing IO records");
        
        var existingTags = await _ioRepository.GetAllAsync();
        if (existingTags.Any())
        {
            await _ioRepository.DeleteRangeAsync(existingTags);
            _logger.LogInformation("Deleted {Count} existing IO records", existingTags.Count);
        }
    }

    private List<Io> CreateTestTags(int numberOfTags, int subsystemId)
    {
        _logger.LogInformation("Creating {NumberOfTags} test tags", numberOfTags);
        
        var tags = new List<Io>();
        var timestamp = DateTime.UtcNow.ToString(TestConstants.TIMESTAMP_FORMAT);

        for (int i = 1; i <= numberOfTags; i++)
        {
            var tag = new Io
            {
                SubsystemId = subsystemId,
                Name = $"tag{i}",
                Description = $"Test IO Tag {i}",
                Order = i,
                Timestamp = timestamp,
                Comments = "",
                State = "FALSE", // Default state for boolean tags
                Result = null    // Not tested yet
            };

            tags.Add(tag);
        }

        return tags;
    }

    private async Task AddTagsInBatchesAsync(List<Io> tags)
    {
        const int batchSize = 100; // Process in batches for better performance
        var totalTags = tags.Count;
        
        _logger.LogInformation("Adding {TotalTags} tags in batches of {BatchSize}", totalTags, batchSize);

        for (int i = 0; i < totalTags; i += batchSize)
        {
            var batch = tags.Skip(i).Take(batchSize).ToList();
            await _ioRepository.AddRangeAsync(batch);
            
            var processedCount = Math.Min(i + batchSize, totalTags);
            _logger.LogInformation("Processed {ProcessedCount}/{TotalTags} tags", processedCount, totalTags);
        }
    }
} 