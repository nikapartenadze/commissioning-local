using System.ComponentModel.DataAnnotations;

namespace IO_Checkout_Tool.Models.Configuration;

public class PlcConfiguration
{
    [Required]
    public string Ip { get; set; } = string.Empty;
    
    [Required]
    public string Path { get; set; } = string.Empty;
    
    private string? _remoteUrl;
    public string? RemoteUrl 
    { 
        get => _remoteUrl;
        set => _remoteUrl = value?.TrimEnd('/');
    }
    
    [Required]
    public string SubsystemId { get; set; } = string.Empty;
    
    [Required]
    public string OrderMode { get; set; } = "0";

    public bool IsOrderModeEnabled => OrderMode == "1";
    
    public int SubsystemIdAsInt => int.TryParse(SubsystemId, out var id) ? id : 0;
}

public class ApplicationConfiguration
{
    public PlcConfiguration Plc { get; set; } = new();
    
    public class ConnectionSettings
    {
        public int TimeoutMs { get; set; } = 5000;
        public int RetryAttempts { get; set; } = 3;
        public int HeartbeatIntervalMs { get; set; } = 1000;
    }
    
    public ConnectionSettings Connection { get; set; } = new();
} 