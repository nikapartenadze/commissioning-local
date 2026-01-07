using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Microsoft.EntityFrameworkCore;
using Microsoft.JSInterop;
using CsvHelper;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

public class ExportService : IExportService
{
    private readonly IJSRuntime _jsRuntime;
    private readonly IDbContextFactory<TagsContext> _dbFactory;
    private readonly IConfigurationService _configurationService;
    private readonly HttpClient _httpClient;

    public ExportService(
        IJSRuntime jsRuntime,
        IDbContextFactory<TagsContext> dbFactory,
        IConfigurationService configurationService,
        HttpClient httpClient)
    {
        _jsRuntime = jsRuntime;
        _dbFactory = dbFactory;
        _configurationService = configurationService;
        _httpClient = httpClient;
    }

    public async Task DownloadCsvAsync(List<Io> tagList)
    {
        var csvContent = await GenerateCsvAsync(tagList);
        var csvBytes = Encoding.UTF8.GetBytes(csvContent);
        
        await _jsRuntime.InvokeVoidAsync(SignalRConstants.JavaScriptFunctions.BLAZOR_DOWNLOAD_FILE, 
                                         TestConstants.EXPORT_CSV_FILENAME, 
                                         TestConstants.CSV_CONTENT_TYPE, 
                                         csvBytes);
    }

    private async Task<string> GenerateCsvAsync(List<Io> tagList)
    {
        using var memoryStream = new MemoryStream();
        using var streamWriter = new StreamWriter(memoryStream);
        using var csvWriter = new CsvWriter(streamWriter, CultureInfo.InvariantCulture);
        
        csvWriter.WriteRecords(tagList);
        await streamWriter.FlushAsync();
        memoryStream.Seek(0, SeekOrigin.Begin);
        
        using var reader = new StreamReader(memoryStream);
        return await reader.ReadToEndAsync();
    }



    public async Task<byte[]> GenerateCsvBytesAsync(IEnumerable<Io> data)
    {
        using var ms = new MemoryStream();
        using var streamWriter = new StreamWriter(ms);
        using var csvWriter = new CsvWriter(streamWriter, CultureInfo.InvariantCulture);
        
        csvWriter.WriteRecords(data);
        await streamWriter.FlushAsync();
        ms.Seek(0, SeekOrigin.Begin);
        
        return ms.ToArray();
    }

    public async Task<byte[]> GenerateCompressedCsvBytesAsync(IEnumerable<Io> data)
    {
        using var ms = new MemoryStream();
        using var gzipStream = new GZipStream(ms, CompressionLevel.Optimal, true);
        using var streamWriter = new StreamWriter(gzipStream);
        using var csvWriter = new CsvWriter(streamWriter, CultureInfo.InvariantCulture);
        
        csvWriter.WriteRecords(data);
        await streamWriter.FlushAsync();
        await gzipStream.FlushAsync();
        ms.Seek(0, SeekOrigin.Begin);
        
        return ms.ToArray();
    }

    private void ConfigureHttpContent(HttpContent content, byte[] csvBytes)
    {
        content.Headers.ContentLength = csvBytes.Length;
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(TestConstants.CSV_CONTENT_TYPE);
        content.Headers.ContentEncoding.Add(SignalRConstants.HttpHeaders.GZIP_ENCODING);
    }
} 