using IO_Checkout_Tool.Services.PlcTags;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ITagReaderService
{
    event Action<Io>? TagValueChanged;
    event Action? StateChanged;
    event Action<bool>? ConnectionStatusChanged;

    Task<bool> InitializeReadingAsync(List<NativeTag> tags, List<Io> tagList, bool skipErrorDetection = false, CancellationToken cancellationToken = default);
    Task StartContinuousReadingAsync(List<NativeTag> tags);

    Task ResetForReconnectionAsync(bool isConfigurationChange = true);
    
    /// <summary>
    /// Get current performance metrics for tag reading operations
    /// </summary>
    TagReaderPerformanceMetrics GetPerformanceMetrics();
} 