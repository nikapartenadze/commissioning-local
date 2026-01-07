using IO_Checkout_Tool.Services.Interfaces;
using System.Collections.Concurrent;

namespace IO_Checkout_Tool.Services;

public class DialogCoordinatorService : IDialogCoordinatorService
{
    private readonly ConcurrentDictionary<string, Func<Task>> _activeDialogs = new();

    public void RegisterDialog(string dialogId, Func<Task> closeAction)
    {
        _activeDialogs.TryAdd(dialogId, closeAction);
    }

    public void UnregisterDialog(string dialogId)
    {
        _activeDialogs.TryRemove(dialogId, out _);
    }

    public async Task CloseAllDialogsExceptAsync(string exceptDialogId)
    {
        var dialogsToClose = _activeDialogs
            .Where(kvp => kvp.Key != exceptDialogId)
            .ToList();
        
        foreach (var dialog in dialogsToClose)
        {
            try
            {
                await dialog.Value();
            }
            catch
            {
                // Silently handle any errors during dialog closure
            }
        }
    }
} 