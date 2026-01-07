namespace IO_Checkout_Tool.Services.Interfaces;

public interface ISimpleDialogService
{
    string CurrentTitle { get; }
    string CurrentMessage { get; }
    bool IsVisible { get; }
    bool ShowOkButton { get; }
    bool ShowCancelButton { get; }
    string OkText { get; }
    string CancelText { get; }
    
    event Action? StateChanged;
    
    Task ShowErrorAsync(string title, string message);
    Task ShowInfoAsync(string title, string message);
    Task<bool> ShowConfirmAsync(string title, string message, string okText = "OK", string cancelText = "Cancel");
    void ShowError(string title, string message);
    void ShowInfo(string title, string message);
    void HandleOk();
    void HandleCancel();
    void HandleClose();
} 