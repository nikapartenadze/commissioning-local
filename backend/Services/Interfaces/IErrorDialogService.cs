namespace IO_Checkout_Tool.Services.Interfaces;

public class TagConnectionStatus
{
    public int TotalTags { get; set; }
    public int SuccessfulTags { get; set; }
    public int FailedTags { get; set; }
    public List<string> NotFoundTags { get; set; } = new();
    public List<string> IllegalTags { get; set; } = new();
    public List<string> UnknownErrorTags { get; set; } = new();
    public List<string> DintGroupFailures { get; set; } = new();
    public DateTime? LastUpdated { get; set; }
    public bool HasErrors => FailedTags > 0 || DintGroupFailures.Count > 0;
    public double SuccessRate => TotalTags > 0 ? (double)SuccessfulTags / TotalTags * 100 : 0;
}

public interface IErrorDialogService
{
    string DialogTitle { get; }
    string DialogMessage { get; }
    bool Alert { get; }
    TagConnectionStatus TagStatus { get; }

    event Action? NotifyAlert;

    void ShowError(string title, string message);
    void ShowConfigurationError();
    void ShowCommunicationError(string serverIp, string plcIp, string plcPath);
    void ShowTagErrors(List<string> notFoundTags, List<string> illegalTags, List<string> unknownTags);
    void ShowInternetConnectionError();
    void ShowTagReadError(List<string> errorMessages);
    void ClearAlert();
    void ClearTagStatus();
    void ShowPlcCommunicationError();
    void ShowFailedTags();
    void ShowConnectionNotDetected();
    void ShowFailedToReadTags(List<string> errorMessages);
    void ShowAuthenticationError();
} 