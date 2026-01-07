using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;
using Shared.Library.Repositories.Interfaces;
using Microsoft.AspNetCore.Components;
using MudBlazor;
using Shared.Library.Components;
using Microsoft.EntityFrameworkCore;

namespace IO_Checkout_Tool.Services;

public class DialogManagerService : IDialogManagerService
{
    private readonly IDialogService _dialogService;
    private readonly ITestHistoryService _testHistoryService;
    private readonly IIoRepository _ioRepository;
    private readonly ISimpleDialogService _simpleDialogService;

    public DialogManagerService(IDialogService dialogService, ITestHistoryService testHistoryService, IIoRepository ioRepository, ISimpleDialogService simpleDialogService)
    {
        _dialogService = dialogService;
        _testHistoryService = testHistoryService;
        _ioRepository = ioRepository;
        _simpleDialogService = simpleDialogService;
    }

    public async Task ShowTestHistoryAsync(int ioId, string description)
    {
        var histories = await _testHistoryService.GetHistoryForIoAsync(ioId);
        var io = await _ioRepository.GetByIdAsync(ioId);
        
        // Convert local TestHistory to shared TestHistory
        var sharedHistories = histories.Select(h => new TestHistory
        {
            Id = h.Id,
            IoId = h.IoId,
            Result = h.Result,
            State = h.State,
            Comments = h.Comments,
            Timestamp = h.Timestamp,
            TestedBy = h.TestedBy
        }).ToList();
        
        var parameters = new DialogParameters
        {
            { "TestHistories", sharedHistories },
            { "IoName", io?.Name },
            { "IoDescription", io?.Description }
        };
        
        var options = new DialogOptions
        {
            CloseButton = true,
            MaxWidth = MaxWidth.Medium,
            FullWidth = true
        };
        
        await _dialogService.ShowAsync<TestHistoryDialog>("", parameters, options);
    }

    public async Task ShowAllHistoryAsync()
    {
        var allHistories = await _testHistoryService.GetAllHistoryAsync();
        
        // Convert to TestHistoryWithIoInfo
        var historiesWithIoInfo = allHistories.Select(h => new AllHistoryDialog.TestHistoryWithIoInfo
        {
            Id = h.Id,
            IoId = h.IoId,
            Result = h.Result,
            State = h.State,
            Comments = h.Comments,
            Timestamp = h.Timestamp,
            TestedBy = h.TestedBy,
            IoName = h.Io?.Name,
            IoDescription = h.Io?.Description
        }).ToList();
        
        var parameters = new DialogParameters
        {
            { "AllHistories", historiesWithIoInfo },
            { "OnShowHistory", EventCallback.Factory.Create<AllHistoryDialog.TestHistoryWithIoInfo>(this, ShowHistoryFromAllHistory) }
        };
        
        var options = new DialogOptions
        {
            CloseButton = true,
            MaxWidth = MaxWidth.Large,
            FullWidth = true
        };
        
        await _dialogService.ShowAsync<AllHistoryDialog>(TestConstants.DialogTitles.COMPLETE_TEST_HISTORY, parameters, options);
    }

    private async Task ShowHistoryFromAllHistory(AllHistoryDialog.TestHistoryWithIoInfo historyItem)
    {
        if (historyItem.IoId > 0)
        {
            await ShowTestHistoryAsync(historyItem.IoId, historyItem.IoDescription ?? historyItem.IoName ?? "Unknown");
        }
    }

    public async Task<DialogResult> ShowValueChangedDialogAsync(Io tag)
    {
        var parameters = new DialogParameters();
        parameters.Add(TestConstants.DialogParameters.TAG, tag.Name);
        parameters.Add(TestConstants.DialogParameters.DESCRIPTION, tag.Description);
        parameters.Add(TestConstants.DialogParameters.VALUE, tag.State);

        DialogOptions disableBackdropClick = new DialogOptions() { BackdropClick = false };
        var valueDialog = await _dialogService.ShowAsync<ValueChangedDialog>(TestConstants.DialogTitles.VALUE_CHANGED, parameters, disableBackdropClick);
        
        return await valueDialog.Result;
    }

    public async Task<DialogResult> ShowOutputDialogAsync(Io tag)
    {
        DialogOptions disableBackdropClick = new DialogOptions() { BackdropClick = false };
        var parameters = new DialogParameters();
        parameters.Add(TestConstants.DialogParameters.TAG, tag);
        
        var outputDialog = await _dialogService.ShowAsync<OutputDialog>("Enable Output", parameters, disableBackdropClick);
        return await outputDialog.Result;
    }

    public async Task ShowErrorDialogAsync(string title, string message)
    {
        // Use our simple dialog service instead of MudBlazor to avoid focus issues
        await _simpleDialogService.ShowErrorAsync(title, message);
    }

    public async Task<string?> GetCommentsAsync(string? tagDescription, string? initialComment = null)
    {
        var parameters = new DialogParameters();
        parameters.Add(TestConstants.DialogParameters.TAG, tagDescription);
        parameters.Add(TestConstants.DialogParameters.COMMENT, initialComment ?? string.Empty);
        
        DialogOptions disableBackdropClick = new DialogOptions() { BackdropClick = false };
        var commentDialog = await _dialogService.ShowAsync<CommentDialog>(TestConstants.DialogTitles.COMMENT, parameters, disableBackdropClick);
        var result = await commentDialog.Result;
        
        if (result == null || result.Canceled)
            return null;
            
        return result.Data?.ToString();
    }

    public Task<IDialogReference?> CloseValueDialogAsync(IDialogReference? valueDialog)
    {
        if (valueDialog != null)
        {
            valueDialog.Close(DialogResult.Cancel());
        }
        return Task.FromResult<IDialogReference?>(null);
    }

    public Task CloseCurrentValueDialogAsync()
    {
        return Task.CompletedTask;
    }

    public void SetCurrentValueDialog(IDialogReference? dialog)
    {
        // No longer needed - dialogs handle their own close events
    }
} 