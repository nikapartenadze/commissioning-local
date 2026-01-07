namespace IO_Checkout_Tool.Services.Interfaces;

public interface IErrorDialogService
{
    string DialogTitle { get; }
    string DialogMessage { get; }
    bool Alert { get; }
    
    event Action? NotifyAlert;
    
    void ShowError(string title, string message);
    void ShowConfigurationError();
    void ShowCommunicationError(string serverIp, string plcIp, string plcPath);
    void ShowTagErrors(List<string> notFoundTags, List<string> illegalTags, List<string> unknownTags);
    void ShowInternetConnectionError();
    void ShowWatchdogError();
    void ShowTagReadError(List<string> errorMessages);
    void ClearAlert();
    void ShowPlcCommunicationError();
    void ShowFailedTags();
    void ShowConnectionNotDetected();
    void ShowWatchdogFailed();
    void ShowFailedToReadTags(List<string> errorMessages);
    void ShowAuthenticationError();
} 