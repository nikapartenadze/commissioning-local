using IO_Checkout_Tool.SharedComponents;
using MudBlazor;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IDialogManagerService
{
    Task ShowTestHistoryAsync(int ioId, string description);
    Task ShowAllHistoryAsync();
    Task<DialogResult> ShowValueChangedDialogAsync(Io tag);
    Task<DialogResult> ShowOutputDialogAsync(Io tag);
    Task ShowErrorDialogAsync(string title, string message);
    Task<string?> GetCommentsAsync(string? tagDescription, string? initialComment = null);
    Task<IDialogReference?> CloseValueDialogAsync(IDialogReference? valueDialog);
    Task CloseCurrentValueDialogAsync();
    void SetCurrentValueDialog(IDialogReference? dialog);
} 