using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Models.Entities;
using IO_Checkout_Tool.Models.Common;

namespace IO_Checkout_Tool.Controllers;

public class TestExecutionController
{
    private readonly ITestExecutionService _testExecution;
    private readonly IIoTestService _ioTestService;
    private readonly IPlcCommunicationService _plcCommunication;
    private readonly IConfigurationService _configuration;
    private readonly IAppStateService _appState;

    public TestExecutionController(
        ITestExecutionService testExecution,
        IIoTestService ioTestService,
        IPlcCommunicationService plcCommunication,
        IConfigurationService configuration,
        IAppStateService appState)
    {
        _testExecution = testExecution;
        _ioTestService = ioTestService;
        _plcCommunication = plcCommunication;
        _configuration = configuration;
        _appState = appState;
    }

    public async Task<ControllerExecutionResult> HandleValueChangedAsync(Io triggeredTag, Func<Io, Task<MudBlazor.DialogResult>> showDialogFunc)
    {
        if (ShouldSkipTest(triggeredTag))
        {
            return ControllerExecutionResult.Skipped();
        }

        var testDialogResult = await ProcessTestDialogAsync(triggeredTag, showDialogFunc);
        
        if (testDialogResult.DialogResult?.Data != null)
        {
            var resultCode = (int)testDialogResult.DialogResult.Data;
            
            // Handle Cancel (2) as a cancellation, not as TEST_CLEARED
            if (resultCode == 2)
            {
                return ControllerExecutionResult.Failed(); // Return failed but don't do any database operations
            }
            
            var success = await _testExecution.ExecuteTestAsync(triggeredTag, resultCode, testDialogResult.SwappedMessage);
            
            if (success)
            {
                var shouldShowAnimation = resultCode == TestConstants.ResultCodes.TEST_PASSED;
                return ControllerExecutionResult.Success(testDialogResult.UpdateTag, shouldShowAnimation);
            }
        }

        return ControllerExecutionResult.Failed();
    }

    public async Task<bool> HandleManualFailAsync(Io failTag)
    {
        var comments = await _testExecution.GetFailureCommentsAsync(failTag.Description);
        if (comments == null)
            return false;

        return await _testExecution.HandleManualFailAsync(failTag, comments);
    }

    public async Task<bool> HandleClearTestAsync(Io tag)
    {
        return await _testExecution.ClearTestResultAsync(tag);
    }

    public async Task<bool> HandleCommentUpdateAsync(Io tag)
    {
        var result = await _ioTestService.UpdateCommentAsync(tag, tag.Comments ?? "");
        
        if (result.Success && result.ChangesWereMade)
        {
            tag.Timestamp = DateTime.UtcNow.ToString(TestConstants.TIMESTAMP_FORMAT);
        }
        
        return result.Success;
    }

    public void HandleFireDown(Io tag)
    {
        if (_appState.UiState.DisableDialog)
            return;
        
        _appState.UiState.SetButtonPressed();
        _plcCommunication.ToggleBit();
    }

    public void HandleFireUp(Io tag, Func<Task> onValueChanged)
    {
        if (_appState.UiState.DownPressed)
        {
            _appState.UiState.SetButtonReleased();
            _plcCommunication.ToggleBit();
            
            Task.Delay(TestConstants.UI_DELAY_MS)
                .ContinueWith(_ => onValueChanged());
        }
    }

    private bool ShouldSkipTest(Io triggeredTag)
    {
        return _configuration.OrderMode && _appState.TestState.TestTag.Name == null;
    }

    private async Task<TestDialogResult> ProcessTestDialogAsync(Io triggeredTag, Func<Io, Task<MudBlazor.DialogResult>> showDialogFunc)
    {
        if (IsOrderModeTest(triggeredTag))
        {
            return CreateOrderModeResult(triggeredTag);
        }
        
        return await CreateStandardTestResult(triggeredTag, showDialogFunc);
    }

    private bool IsOrderModeTest(Io triggeredTag)
    {
        return _configuration.OrderMode && triggeredTag.Id == _appState.TestState.TestTag.Id;
    }

    private TestDialogResult CreateOrderModeResult(Io triggeredTag)
    {
        var updateTag = _plcCommunication.TagList.First(a => a.Id == _appState.TestState.TestTag.Id);
        var swapped = $"Triggered by: {triggeredTag.Name} Expected: {_appState.TestState.TestTag.Name}";
        
        return new TestDialogResult
        {
            UpdateTag = updateTag,
            DialogResult = MudBlazor.DialogResult.Ok(TestConstants.ResultCodes.TEST_PASSED),
            SwappedMessage = swapped
        };
    }

    private async Task<TestDialogResult> CreateStandardTestResult(Io triggeredTag, Func<Io, Task<MudBlazor.DialogResult>> showDialogFunc)
    {
        var updateTag = _plcCommunication.TagList.First(a => a.Id == triggeredTag.Id);
        var dialogResult = await showDialogFunc(triggeredTag);
        
        return new TestDialogResult
        {
            UpdateTag = updateTag,
            DialogResult = dialogResult,
            SwappedMessage = string.Empty
        };
    }
} 