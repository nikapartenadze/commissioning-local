namespace IO_Checkout_Tool.Services.Interfaces;

public interface IConfigurationService
{
    string Ip { get; }
    string Path { get; }
    string SubsystemId { get; }
    string RemoteUrl { get; }
    string ApiPassword { get; }
    bool OrderMode { get; }
    bool DisableWatchdog { get; }
    bool IsReinitializing { get; } // Indicates if configuration reinitialization is currently in progress
    
    // Column visibility settings
    bool ShowStateColumn { get; }
    bool ShowHzColumn { get; }
    bool ShowResultColumn { get; }
    bool ShowTimestampColumn { get; }
    bool ShowHistoryColumn { get; }
    
    // Events
    event Action? ColumnVisibilityChanged;
    
    bool LoadConfiguration();
    
    // Methods for immediate UI updates (no reload required)
    void UpdateColumnVisibility(bool showStateColumn, bool showHzColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn);
    Task SaveUISettingsAsync();
    
    // New methods for config editing (requires reload)
    Task<bool> UpdateConfigurationAsync(string ip, string path, string subsystemId, string remoteUrl, string apiPassword, bool orderMode, bool disableWatchdog, bool showStateColumn, bool showHzColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn);
    Task ReinitializeApplicationAsync();
    
    // Runtime configuration switching (no reload required)
    Task<bool> SwitchToConfigurationAsync(string ip, string path, string subsystemId, string remoteUrl, string apiPassword, bool orderMode, bool disableWatchdog, bool showStateColumn, bool showHzColumn, bool showResultColumn, bool showTimestampColumn, bool showHistoryColumn);
} 