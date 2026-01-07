using System.Globalization;
using System.Text;
using CsvHelper;
using IO_Checkout_Tool.Constants;
using Shared.Library.Repositories.Interfaces;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services;

public class IoStatisticsService : IIoStatisticsService
{
    private readonly IIoRepository _ioRepository;

    public IoStatisticsService(IIoRepository ioRepository)
    {
        _ioRepository = ioRepository;
    }

    public async Task<(int total, int passed, int failed, int notTested, double passedPercentage, double failedPercentage, double notTestedPercentage)> GetStatisticsAsync()
    {
        var allIos = await _ioRepository.GetAllAsync();
        
        var totalCount = allIos.Count;
        var passedCount = allIos.Count(io => io.Result == TestConstants.RESULT_PASSED);
        var failedCount = allIos.Count(io => io.Result == TestConstants.RESULT_FAILED);
        var notTestedCount = allIos.Count(io => string.IsNullOrEmpty(io.Result));

        var passedPercentage = totalCount > 0 ? Math.Round((float)passedCount * MathConstants.PERCENTAGE_MULTIPLIER / totalCount, MathConstants.DECIMAL_PRECISION) : 0;
        var failedPercentage = totalCount > 0 ? Math.Round((float)failedCount * MathConstants.PERCENTAGE_MULTIPLIER / totalCount, MathConstants.DECIMAL_PRECISION) : 0;
        var notTestedPercentage = totalCount > 0 ? Math.Round((float)notTestedCount * MathConstants.PERCENTAGE_MULTIPLIER / totalCount, MathConstants.DECIMAL_PRECISION) : 0;

        return (totalCount, passedCount, failedCount, notTestedCount, passedPercentage, failedPercentage, notTestedPercentage);
    }

    public async Task<TestStatistics> GetTestStatisticsAsync()
    {
        var totalCount = await _ioRepository.CountTotalTestableAsync();
        var passedCount = await _ioRepository.CountByResultAsync(TestConstants.RESULT_PASSED);
        var failedCount = await _ioRepository.CountByResultAsync(TestConstants.RESULT_FAILED);
        var notTestedCount = await _ioRepository.CountUntestedAsync();

        var passedPercentage = totalCount > 0 ? Math.Round((float)passedCount * 100 / totalCount, 2) : 0;
        var failedPercentage = totalCount > 0 ? Math.Round((float)failedCount * 100 / totalCount, 2) : 0;
        var notTestedPercentage = totalCount > 0 ? Math.Round((float)notTestedCount * 100 / totalCount, 2) : 0;

        return new TestStatistics
        {
            TotalCount = totalCount,
            PassedCount = passedCount,
            FailedCount = failedCount,
            NotTestedCount = notTestedCount,
            PassedPercentage = passedPercentage,
            FailedPercentage = failedPercentage,
            NotTestedPercentage = notTestedPercentage
        };
    }

    public async Task<byte[]> ExportToCsvAsync()
    {
        var ios = await _ioRepository.GetAllAsync();
        
        using var memoryStream = new MemoryStream();
        using var streamWriter = new StreamWriter(memoryStream);
        using var csvWriter = new CsvWriter(streamWriter, CultureInfo.InvariantCulture);
        
        csvWriter.WriteRecords(ios);
        streamWriter.Flush();
        
        return memoryStream.ToArray();
    }
} 