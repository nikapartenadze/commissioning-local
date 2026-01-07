namespace IO_Checkout_Tool.Services.Interfaces;

public interface IDatabaseSeedingService
{
    Task<bool> SeedDatabaseWithTestTagsAsync(int numberOfTags = 1000);
} 