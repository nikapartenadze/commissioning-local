using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;
using MudBlazor;

namespace IO_Checkout_Tool.Controllers;

public class DialogController
{
    private readonly IDialogManagerService _dialogManager;
    private readonly IErrorDialogService _errorDialog;
    private readonly IAppStateService _appState;

    public DialogController(
        IDialogManagerService dialogManager,
        IErrorDialogService errorDialog,
        IAppStateService appState)
    {
        _dialogManager = dialogManager;
        _errorDialog = errorDialog;
        _appState = appState;
    }

    public async Task<DialogResult> ShowValueChangedDialogAsync(Io triggeredTag)
    {
        return await _dialogManager.ShowValueChangedDialogAsync(triggeredTag);
    }

    public async Task<OutputDialogResult> ShowOutputDialogAsync(Io contextItem)
    {
        if (contextItem.Result == null || contextItem.Result == string.Empty)
        {
            _appState.UiState.OutputToTestInput = true;
        }
        
        _appState.UiState.DisableDialog = true;
        var result = await _dialogManager.ShowOutputDialogAsync(contextItem);
        
        var shouldTriggerValueChanged = !result.Canceled && 
                                       (contextItem.Result == string.Empty || contextItem.Result == null);
        
        var shouldHandleOutputToTest = false;
        if (!shouldTriggerValueChanged)
        {
            shouldHandleOutputToTest = _appState.TestState.OutputToTestInputTag.Name != null && 
                                     _appState.TestState.OutputToTestInputTag != contextItem;
            
            if (!shouldHandleOutputToTest)
            {
                _appState.UiState.OutputToTestInput = false;
                _appState.UiState.DisableDialog = false;
            }
        }

        return new OutputDialogResult
        {
            DialogResult = result,
            ShouldTriggerValueChanged = shouldTriggerValueChanged,
            ShouldHandleOutputToTest = shouldHandleOutputToTest,
            ContextItem = contextItem
        };
    }

    public async Task ShowTestHistoryAsync(Io io)
    {
        if (io.Id == null) return;
        
        var ioDescription = io.Description ?? io.Name ?? TestConstants.UiText.UNKNOWN_DESCRIPTION;
                    await _dialogManager.ShowTestHistoryAsync(io.Id, ioDescription);
    }
    
    public async Task ShowAllHistoryAsync()
    {
        await _dialogManager.ShowAllHistoryAsync();
    }

    public async Task ShowErrorDialogAsync()
    {
        await _dialogManager.ShowErrorDialogAsync(_errorDialog.DialogTitle, _errorDialog.DialogMessage);
    }

    public async Task<IDialogReference?> CloseValueDialogAsync(IDialogReference? valueDialog)
    {
        return await _dialogManager.CloseValueDialogAsync(valueDialog);
    }

    public bool ShouldShowInitialAlert()
    {
        return _errorDialog.Alert;
    }
}

public class OutputDialogResult
{
    public DialogResult DialogResult { get; set; } = null!;
    public bool ShouldTriggerValueChanged { get; set; }
    public bool ShouldHandleOutputToTest { get; set; }
    public Io ContextItem { get; set; } = null!;
} 