using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services;

public class ErrorDialogService : IErrorDialogService
{
    public string DialogTitle { get; private set; } = string.Empty;
    public string DialogMessage { get; private set; } = string.Empty;
    public bool Alert { get; private set; } = false;
    
    public event Action? NotifyAlert;

    public void ShowError(string title, string message)
    {
        DialogTitle = title;
        DialogMessage = message;
        Alert = true;
        NotifyAlert?.Invoke();
    }

    public void ShowConfigurationError()
    {
        ShowError("Configuration Error", 
            "Failed to read config.json file.\n\n" +
            "Please check:\n" +
            "1. The config.json file exists in the application folder\n" +
            "2. The file contains valid JSON format\n" +
            "3. All required settings are present (ip, path, subsystemId)\n\n" +
            "See config-help.txt for detailed configuration instructions.");
    }

    public void ShowCommunicationError(string serverIp, string plcIp, string plcPath)
    {
        ShowError("Failed to communicate with PLC", 
            $"Server IP: {serverIp}{Environment.NewLine}" +
            $"PLC IP: {plcIp}{Environment.NewLine}PLC Path: {plcPath}{Environment.NewLine}Please check your connection/configuration and try again.");
    }

    public void ShowTagErrors(List<string> notFoundTags, List<string> illegalTags, List<string> unknownTags)
    {
        var totalErrors = notFoundTags.Count + illegalTags.Count + unknownTags.Count;
        List<string> sections = [];

        // Header with summary
        var header = $"<p><strong>Tag Validation Failed - {totalErrors} errors found:</strong></p>";
        sections.Add(header);

        if (notFoundTags.Count > 0)
        {
            var section = $"<div style='margin-bottom: 16px;'>" +
                         $"<h4 style='color: #d32f2f; margin: 8px 0;'>❌ MISSING TAGS ({notFoundTags.Count})</h4>" +
                         $"<p style='margin: 4px 0;'>These tags don't exist in the PLC or have incorrect paths:</p>" +
                         $"<ul style='margin: 8px 0; padding-left: 20px;'>" +
                         string.Join("", notFoundTags.Select(tag => $"<li style='margin: 2px 0;'>{tag}</li>")) +
                         "</ul></div>";
            sections.Add(section);
        }

        if (illegalTags.Count > 0)
        {
            var section = $"<div style='margin-bottom: 16px;'>" +
                         $"<h4 style='color: #f57c00; margin: 8px 0;'>⚠️ MODULE FAULT/OFFLINE ({illegalTags.Count})</h4>" +
                         $"<p style='margin: 4px 0;'>These tags have fault values (not 0 or 1) - likely offline modules:</p>" +
                         $"<ul style='margin: 8px 0; padding-left: 20px;'>" +
                         string.Join("", illegalTags.Select(tag => $"<li style='margin: 2px 0;'>{tag}</li>")) +
                         "</ul></div>";
            sections.Add(section);
        }

        if (unknownTags.Count > 0)
        {
            var section = $"<div style='margin-bottom: 16px;'>" +
                         $"<h4 style='color: #1976d2; margin: 8px 0;'>🔍 OTHER ERRORS ({unknownTags.Count})</h4>" +
                         $"<p style='margin: 4px 0;'>These tags failed validation with other errors:</p>" +
                         $"<ul style='margin: 8px 0; padding-left: 20px;'>" +
                         string.Join("", unknownTags.Select(error => $"<li style='margin: 2px 0;'>{error}</li>")) +
                         "</ul></div>";
            sections.Add(section);
        }

        // Footer with guidance
        var footer = "<div style='margin-top: 16px; padding: 12px; background-color: #e3f2fd; border-left: 4px solid #2196f3; border-radius: 4px;'>" +
                    "<h4 style='color: #1976d2; margin: 0 0 8px 0;'>💡 ACTION REQUIRED</h4>" +
                    "<p style='margin: 0;'>Please fix these tag definitions or PLC configuration before proceeding.</p>" +
                    "</div>";
        sections.Add(footer);

        DialogMessage = string.Join("", sections);
        DialogTitle = $"Tag Validation Failed ({totalErrors} errors)";
        Alert = true;
        NotifyAlert?.Invoke();
    }

    public void ShowInternetConnectionError()
    {
        ShowError("Connection to internet not detected on startup", 
                  "Data from the remote server will not sync, and may not be up to date.");
    }

    public void ShowWatchdogError()
    {
        ShowError("Watchdog Failed", "Make sure the Watchdog AOI is enabled in the PLC");
    }

    public void ShowTagReadError(List<string> errorMessages)
    {
        ShowError("Failed to read tags", string.Join(Environment.NewLine, errorMessages));
    }

    public void ClearAlert()
    {
        Alert = false;
    }

    public void ShowPlcCommunicationError()
    {
        ShowError(PlcConstants.ErrorMessages.PlcCommFailure,
            "Error communicating with PLC. This could be due to a network timeout or invalid tag name. Please check the PLC connection and tag configuration.");
    }

    public void ShowFailedTags()
    {
        DialogTitle = PlcConstants.ErrorMessages.FailedTags;
        DialogMessage = string.Empty;
        Alert = true;
    }

    public void ShowConnectionNotDetected()
    {
        ShowError(PlcConstants.ErrorMessages.ConnectionFailed,
            "Internet connection not detected when the application was started. Data will not be uploaded to remote server.");
    }

    public void ShowWatchdogFailed()
    {
        ShowError(PlcConstants.ErrorMessages.WatchdogFailed, PlcConstants.ErrorMessages.WatchdogAoiMessage);
    }

    public void ShowFailedToReadTags(List<string> errorMessages)
    {
        ShowError(PlcConstants.ErrorMessages.FailedToReadTags, string.Join(Environment.NewLine, errorMessages));
    }

    public void ShowAuthenticationError()
    {
        ShowError("Authentication Failed", 
            "<p><strong>The API Password is incorrect.</strong></p>" +
            "<br/>" +
            "<div style='background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 4px; padding: 12px; margin: 8px 0;'>" +
            "<p style='margin: 0 0 8px 0; color: #856404;'><strong>⚠️ Invalid Credentials</strong></p>" +
            "<p style='margin: 0; color: #856404;'>The server rejected your API Password</p>" +
            "</div>" +
            "<p><strong>Please verify:</strong></p>" +
            "<ul>" +
            "<li>The API Password in your configuration is correct</li>" +
            "<li>Contact your administrator for the correct API Password</li>" +
            "<li>Ensure the cloud server URL is correct</li>" +
            "</ul>" +
            "<br/>" +
            "<div style='background-color: #d1ecf1; border: 1px solid #bee5eb; border-radius: 4px; padding: 12px;'>" +
            "<p style='margin: 0 0 8px 0; color: #0c5460;'><strong>🔧 How to Fix</strong></p>" +
            "<p style='margin: 0; color: #0c5460;'>Click the <strong>settings gear icon</strong> in the toolbar to update your configuration</p>" +
            "</div>");
    }

    // Test method - remove this after testing
    public void TestAuthenticationError()
    {
        ShowAuthenticationError();
    }
} 