namespace IO_Checkout_Tool.Models.Configuration;

public class ConfigurationSettings
{
    private string _remoteUrl = string.Empty;
    
    public string RemoteUrl 
    { 
        get => _remoteUrl;
        set => _remoteUrl = value?.TrimEnd('/') ?? string.Empty;
    }
    public string SubsystemId { get; set; } = string.Empty;
    public string ApiPassword { get; set; } = string.Empty;
    public string Ip { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string OrderMode { get; set; } = "0";
    
    // Sync optimization settings (with defaults)
    public int SyncBatchSize { get; set; } = 50;
    public int SyncBatchDelayMs { get; set; } = 500;
} 