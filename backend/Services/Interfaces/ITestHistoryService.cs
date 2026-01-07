using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ITestHistoryService
{
    Task AddTestHistoryAsync(int ioId, string result, string? comments = null, string? state = null);
    Task<List<TestHistory>> GetHistoryForIoAsync(int ioId);
    Task<List<TestHistory>> GetAllHistoryAsync();
} 