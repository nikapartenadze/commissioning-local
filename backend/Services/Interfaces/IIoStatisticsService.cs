namespace IO_Checkout_Tool.Services.Interfaces;

public class TestStatistics
{
    public int TotalCount { get; set; }
    public int PassedCount { get; set; }
    public int FailedCount { get; set; }
    public int NotTestedCount { get; set; }
    public double PassedPercentage { get; set; }
    public double FailedPercentage { get; set; }
    public double NotTestedPercentage { get; set; }
}

public interface IIoStatisticsService
{
    Task<TestStatistics> GetTestStatisticsAsync();
    Task<byte[]> ExportToCsvAsync();
} 