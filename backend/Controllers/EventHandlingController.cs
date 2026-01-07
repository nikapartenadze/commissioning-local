using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Controllers;

public class EventHandlingController
{
    private readonly IAppStateService _appState;
    private readonly IWatchdogService _watchdog;
    private readonly ISignalRService _signalRService;
    private readonly IGraphDataService _graphDataService;

    public EventHandlingController(
        IAppStateService appState,
        IWatchdogService watchdog,
        ISignalRService signalRService,
        IGraphDataService graphDataService)
    {
        _appState = appState;
        _watchdog = watchdog;
        _signalRService = signalRService;
        _graphDataService = graphDataService;
    }

    public IoEventResult HandleIoEvent(Io tag)
    {
        var shouldSetOutputToTestInput = _appState.UiState.DisableDialog && 
                                       _appState.UiState.OutputToTestInput && 
                                       !tag.Name!.Contains(TestConstants.OUTPUT_TAG_SUFFIX) && 
                                       (tag.Result == null || tag.Result.Trim() == string.Empty);

        // Require watchdog to be enabled (TestingStarted = true) for test dialogs
        var shouldTriggerValueChanged = !_appState.UiState.DisableDialog && 
                                      _watchdog.TestingStarted &&
                                      (tag.Result == null || tag.Result.Trim() == string.Empty);

        // Debug logging to help diagnose issues
        if (!shouldTriggerValueChanged && !shouldSetOutputToTestInput)
        {
            var reasons = new List<string>();
            if (_appState.UiState.DisableDialog) reasons.Add("DisableDialog=true");
            if (!_watchdog.TestingStarted) reasons.Add("TestingStarted=false");
            if (tag.Result != null && tag.Result.Trim() != string.Empty) reasons.Add($"Result='{tag.Result}'");
            
            System.Diagnostics.Debug.WriteLine($"Tag {tag.Name} state changed to {tag.State} but not triggering dialog. Reasons: {string.Join(", ", reasons)}");
        }

        if (shouldSetOutputToTestInput)
        {
            _appState.TestState.OutputToTestInputTag = tag;
        }

        return new IoEventResult
        {
            ShouldSetOutputToTestInput = shouldSetOutputToTestInput,
            ShouldTriggerValueChanged = shouldTriggerValueChanged,
            Tag = tag
        };
    }

    public async Task<SignalREventResult> HandleSignalRMessageAsync(Io tag)
    {
        await _graphDataService.UpdateGraphDataAsync();
        
        return new SignalREventResult
        {
            Tag = tag,
            ShouldRefreshUI = true
        };
    }

    public void SetupEventHandlers(
        Action<Io> onIoNotify,
        Action onAlertNotify,
        Action onStateNotify,
        Func<Io, Task> onSignalRMessage)
    {
        // Note: The actual event subscription will be done in the page
        // This method documents what events need to be wired up
    }

    public void InitializeSignalR(Func<Io, Task> messageHandler)
    {
        // For regular IO message synchronization between clients
        // Dialog coordination is handled separately by DialogCoordinatorService
    }

    public void CleanupEventHandlers(
        Action<Io> onIoNotify,
        Action onAlertNotify, 
        Action onStateNotify,
        Func<Io, Task> onSignalRMessage)
    {
        // Note: The actual event unsubscription will be done in the page
        // This method documents what events need to be cleaned up
    }

    public async Task HandleStateChangeAsync()
    {
        // Handle any state change logic here if needed
        await Task.CompletedTask;
    }

    public async Task SendSignalRMessageAsync(Io tag)
    {
        await _signalRService.SendMessageAsync(tag);
    }
}

public class IoEventResult
{
    public bool ShouldSetOutputToTestInput { get; set; }
    public bool ShouldTriggerValueChanged { get; set; }
    public Io Tag { get; set; } = null!;
}

public class SignalREventResult
{
    public Io Tag { get; set; } = null!;
    public bool ShouldRefreshUI { get; set; }
} 