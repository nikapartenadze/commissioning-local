using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IExportService
{
    Task DownloadCsvAsync(List<Io> tagList);
    Task<byte[]> GenerateCsvBytesAsync(IEnumerable<Io> data);
    Task<byte[]> GenerateCompressedCsvBytesAsync(IEnumerable<Io> data);
} 