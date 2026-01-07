using IO_Checkout_Tool.Constants;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

public class TestHistoryService : ITestHistoryService
{
    private readonly ITestHistoryRepository _historyRepository;

    public TestHistoryService(ITestHistoryRepository historyRepository)
    {
        _historyRepository = historyRepository;
    }

    public async Task AddTestHistoryAsync(int ioId, string result, string? comments = null, string? state = null)
    {
        var testHistory = new TestHistory
        {
            IoId = ioId,
            Result = result,
            Timestamp = DateTime.UtcNow.ToString(TestConstants.TIMESTAMP_FORMAT),
            Comments = comments,
            State = state
        };

        await _historyRepository.AddAsync(testHistory);
    }

    public async Task<List<TestHistory>> GetHistoryForIoAsync(int ioId)
    {
        return await _historyRepository.GetByIoIdAsync(ioId);
    }

    public async Task<List<TestHistory>> GetAllHistoryAsync()
    {
        return await _historyRepository.GetAllAsync();
    }
} 