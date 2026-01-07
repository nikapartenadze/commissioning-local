using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services;

public class SimpleDialogService : ISimpleDialogService
{
    public string CurrentTitle { get; private set; } = "";
    public string CurrentMessage { get; private set; } = "";
    public bool IsVisible { get; private set; } = false;
    public bool ShowOkButton { get; private set; } = true;
    public bool ShowCancelButton { get; private set; } = false;
    public string OkText { get; private set; } = "OK";
    public string CancelText { get; private set; } = "Cancel";
    
    private TaskCompletionSource<bool>? _currentTask;
    
    public event Action? StateChanged;

    public async Task ShowErrorAsync(string title, string message)
    {
        await ShowDialogAsync(title, message, "OK", null);
    }

    public async Task ShowInfoAsync(string title, string message)
    {
        await ShowDialogAsync(title, message, "OK", null);
    }

    public async Task<bool> ShowConfirmAsync(string title, string message, string okText = "OK", string cancelText = "Cancel")
    {
        return await ShowDialogAsync(title, message, okText, cancelText);
    }

    public void ShowError(string title, string message)
    {
        _ = ShowErrorAsync(title, message);
    }

    public void ShowInfo(string title, string message)
    {
        _ = ShowInfoAsync(title, message);
    }

    private async Task<bool> ShowDialogAsync(string title, string message, string okText, string? cancelText)
    {
        if (_currentTask != null && !_currentTask.Task.IsCompleted)
        {
            _currentTask.SetResult(false);
        }

        _currentTask = new TaskCompletionSource<bool>();

        CurrentTitle = title;
        CurrentMessage = message;
        OkText = okText;
        CancelText = cancelText ?? "Cancel";
        ShowOkButton = true;
        ShowCancelButton = !string.IsNullOrEmpty(cancelText);
        IsVisible = true;
        
        StateChanged?.Invoke();

        return await _currentTask.Task;
    }

    public void HandleOk()
    {
        if (_currentTask != null && !_currentTask.Task.IsCompleted)
        {
            _currentTask.SetResult(true);
        }
        CloseDialog();
    }

    public void HandleCancel()
    {
        if (_currentTask != null && !_currentTask.Task.IsCompleted)
        {
            _currentTask.SetResult(false);
        }
        CloseDialog();
    }

    public void HandleClose()
    {
        if (_currentTask != null && !_currentTask.Task.IsCompleted)
        {
            _currentTask.SetResult(false);
        }
        CloseDialog();
    }

    private void CloseDialog()
    {
        IsVisible = false;
        StateChanged?.Invoke();
    }
} 