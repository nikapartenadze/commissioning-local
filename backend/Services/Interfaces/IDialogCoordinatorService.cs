namespace IO_Checkout_Tool.Services.Interfaces;

public interface IDialogCoordinatorService
{
    void RegisterDialog(string dialogId, Func<Task> closeAction);
    void UnregisterDialog(string dialogId);
    Task CloseAllDialogsExceptAsync(string exceptDialogId);
} 