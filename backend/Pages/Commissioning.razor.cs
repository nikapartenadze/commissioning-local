using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using MudBlazor;
using IO_Checkout_Tool.SharedComponents;
using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Controllers;
using Shared.Library.Models.Entities;
using IO_Checkout_Tool.Components;

namespace IO_Checkout_Tool.Pages;

public partial class Commissioning : ComponentBase, IDisposable
{
    [Inject] private TestExecutionController TestExecution { get; set; } = null!;
    [Inject] private DialogController DialogController { get; set; } = null!;
    [Inject] private EventHandlingController EventHandling { get; set; } = null!;
    [Inject] private IPlcCommunicationService PlcCommunication { get; set; } = null!;
    [Inject] private IWatchdogService Watchdog { get; set; } = null!;
    [Inject] private IConfigurationService Configuration { get; set; } = null!;
    [Inject] private IAppStateService AppState { get; set; } = null!;
    [Inject] private IExportService ExportService { get; set; } = null!;
    [Inject] private IFilterService FilterService { get; set; } = null!;
    [Inject] private IGraphDataService GraphDataService { get; set; } = null!;
    [Inject] private ITestExecutionService TestExecutionService { get; set; } = null!;
    [Inject] private ICloudSyncService CloudSyncService { get; set; } = null!;
    [Inject] private IErrorDialogService ErrorDialogService { get; set; } = null!;
    [Inject] private IDialogService DialogService { get; set; } = null!;
    
    IDialogReference? valueDialog = null;
    private bool _isCloudConnected = false;
    private bool _isPlcConnected = false;

    private Func<Io, object> _sortBy => FilterService.CreateTimestampSortFunction();
    private Func<Io, bool> _quickFilter => FilterService.CreateQuickFilter(AppState);
    private Func<Io, int, string> _rowStyleFunc => FilterService.CreateRowStyleFunction();

    protected override async Task OnInitializedAsync()
    {
        AppState.StateChanged += OnStateChanged;
        CloudSyncService.ConnectionStateChanged += OnCloudConnectionChanged;
        PlcCommunication.PlcConnectionChanged += OnPlcConnectionChanged;
        ErrorDialogService.NotifyAlert += OnErrorAlert;
        Configuration.ColumnVisibilityChanged += OnColumnVisibilityChanged;
        _isCloudConnected = CloudSyncService.IsConnected;
        _isPlcConnected = PlcCommunication.IsPlcConnected;
        await base.OnInitializedAsync();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            await InitializeComponent();
        }
    }

    private async Task InitializeComponent()
    {
        HandleInitialAlert();
        await InitializeTestTag();
        StateHasChanged();
        SetupEventHandlers();
        SetupSignalRConnection();
    }

    private void OnStateChanged()
    {
        InvokeAsync(StateHasChanged);
    }

    private void OnColumnVisibilityChanged()
    {
        InvokeAsync(StateHasChanged);
    }

    private void OnCloudConnectionChanged()
    {
        _isCloudConnected = CloudSyncService.IsConnected;
        InvokeAsync(StateHasChanged);
    }

    private void OnPlcConnectionChanged()
    {
        _isPlcConnected = PlcCommunication.IsPlcConnected;
        InvokeAsync(StateHasChanged);
    }

    private void OnErrorAlert()
    {
        InvokeAsync(async () =>
        {
            await ShowErrorDialog();
            // Clear the alert flag after showing the dialog
            ErrorDialogService.ClearAlert();
            StateHasChanged();
        });
    }

    void ResultValuesChanged(bool value, string item)
    {
        AppState.FilterState.SetResultFilter(item, value);
    }

    void StateValuesChanged(bool value, string item)
    {
        AppState.FilterState.SetStateFilter(item, value);
    }

    void ResetStateFilter()
    {
        AppState.FilterState.ResetStateFilter();
    }

    void ResetResultFilter()
    {
        AppState.FilterState.ResetResultFilter();
    }

    async Task ShowGraph()
    {
        AppState.UiState.ToggleGraph();

        if (AppState.UiState.ShowGraph)
        {
            await GraphDataService.UpdateGraphDataAsync();
        }
    }

    private async Task EnableOutput(CellContext<Io> context)
    {
        var result = await DialogController.ShowOutputDialogAsync(context.Item);
        
        if (result.ShouldTriggerValueChanged)
        {
            await Task.Delay(TestConstants.UI_DELAY_MS);
            await this.InvokeAsync(() => ValueChanged(context.Item));
        }
        else if (result.ShouldHandleOutputToTest)
        {
            await Task.Delay(TestConstants.UI_DELAY_MS);
            await this.InvokeAsync(() => ValueChanged(AppState.TestState.OutputToTestInputTag));
            AppState.TestState.ClearOutputTag();
        }
    }

    private void FireDown(Io tag)
    {
        TestExecution.HandleFireDown(tag);
    }

    private void FireUp(Io tag)
    {
        TestExecution.HandleFireUp(tag, () => ValueChanged(tag));
    }

    private async Task ManualFail(Io failTag)
    {
        var success = await TestExecution.HandleManualFailAsync(failTag);
        
        if (success)
        {
            await FinalizeTestOperation(failTag);
        }
    }

    private async Task FinalizeTestOperation(Io tag)
    {
        StateHasChanged();
        await this.InvokeAsync(() => Send(tag));
    }

    private async Task CsvDownload()
    {
        await ExportService.DownloadCsvAsync(PlcCommunication.TagList);
    }

    private void HandleInitialAlert()
    {
        if (DialogController.ShouldShowInitialAlert())
        {
            ShowAlert();
            // Clear the alert flag so it doesn't show again on page refresh
            ErrorDialogService.ClearAlert();
        }
    }

    private async Task InitializeTestTag()
    {
        await TestExecutionService.UpdateNextTestTagAsync();
    }

    private void SetupEventHandlers()
    {
        PlcCommunication.NotifyIo += OnNotifyIo;
        PlcCommunication.NotifyState += OnNotifyState;
    }

    private void SetupSignalRConnection()
    {
        EventHandling.InitializeSignalR(OnMessageReceived);
        // Dialog coordination is now handled directly by ValueChangedDialog components
    }

    private async Task OnMessageReceived(Io tag)
    {
        var result = await EventHandling.HandleSignalRMessageAsync(tag);
        if (result.ShouldRefreshUI)
        {
            await Refresh(tag);
        }
    }

    private async Task ShowErrorDialog()
    {
        await DialogController.ShowErrorDialogAsync();
    }

    void ShowAlert()
    {
        this.InvokeAsync(() => ShowErrorDialog());
        InvokeAsync(() => { StateHasChanged(); });
    }

    void OnNotifyIo(Io tag)
    {
        InvokeAsync(async () =>
        {
            // Find the actual tag in the TagList (UI's data source)
            var actualTag = PlcCommunication.TagList.FirstOrDefault(t => t.Name == tag.Name);
            if (actualTag != null)
            {
                // Update the state on the actual tag that the UI is bound to
                actualTag.State = tag.State;
                
                var eventResult = EventHandling.HandleIoEvent(actualTag);
                
                if (eventResult.ShouldTriggerValueChanged)
                {
                    if (!AppState.UiState.DisableDialog)
                    {
                        AppState.UiState.DisableDialog = true;
                        await ValueChanged(actualTag);
                    }
                }
            }
            
            // Always refresh UI when tag state changes
            StateHasChanged();
        });
    }

    void OnNotifyState()
    {
        InvokeAsync(() => { StateHasChanged(); });
    }

    async Task Refresh(Io tag)
    {
        valueDialog = await DialogController.CloseValueDialogAsync(valueDialog);
        await InvokeAsync(StateHasChanged);
    }

    async Task ValueChanged(Io triggeredTag)
    {
        try
        {
            var testResult = await TestExecution.HandleValueChangedAsync(triggeredTag, 
                async (tag) => await DialogController.ShowValueChangedDialogAsync(tag));
            
            // Reset DisableDialog immediately after dialog completes
            AppState.UiState.DisableDialog = false;
            
            if (testResult.IsSkipped)
            {
                return;
            }

            if (testResult.IsSuccess && testResult.UpdateTag != null)
            {
                // Run animations and finalization in the background - don't block the UI
                _ = Task.Run(async () =>
                {
                    try
                    {
                        if (testResult.ShouldShowAnimation)
                        {
                            await InvokeAsync(async () => await SuccessAnimation());
                        }
                        await InvokeAsync(async () => await FinalizeTestOperation(testResult.UpdateTag));
                    }
                    catch (Exception ex)
                    {
                        // Log error silently
                    }
                });
            }
        }
        catch (Exception ex)
        {
            // Make sure DisableDialog is reset even on error
            AppState.UiState.DisableDialog = false;
        }
    }

    private async Task ShowTestHistory(Io io)
    {
        await DialogController.ShowTestHistoryAsync(io);
    }
    
    private async Task ShowAllHistory()
    {
        await DialogController.ShowAllHistoryAsync();
    }

    private async Task ShowConfigDialog()
    {
        var options = new DialogOptions 
        { 
            CloseOnEscapeKey = true,
            MaxWidth = MaxWidth.Small,
            FullWidth = true
        };

        var dialog = await DialogService.ShowAsync<ConfigEditDialog>("Configuration", options);
        var result = await dialog.Result;

        if (!result.Canceled)
        {
            // Configuration was updated and app was reloaded
            // Force UI refresh to ensure updated data is displayed
            StateHasChanged();
            
            // Give additional time for async operations to complete
            await Task.Delay(1000);
            
            // Force another UI refresh
            StateHasChanged();
        }
    }

    private async Task OnCloudSyncClick()
    {
        // Check if cloud is connected
        if (!_isCloudConnected)
        {
            return;
        }

        // Show sync dialog
        var options = new DialogOptions 
        { 
            CloseOnEscapeKey = false, // Prevent accidental closing during sync
            MaxWidth = MaxWidth.Small,
            FullWidth = true,
            BackdropClick = false // Prevent closing by clicking outside
        };

        var dialog = await DialogService.ShowAsync<CloudSyncDialog>("Sync from Cloud", options);
        var result = await dialog.Result;

        if (!result.Canceled)
        {
            // Sync completed successfully - force UI refresh
            StateHasChanged();
        }
    }



    private async Task ClearRow(CellContext<Io> context)
    {
        var success = await TestExecution.HandleClearTestAsync(context.Item);
        
        if (success)
        {
            await FinalizeTestOperation(context.Item);
        }
    }

    private async Task NewComment(CellContext<Io> context)
    {
        if (AppState.UiState.DisableDialog)
        {
            return;
        }

        var success = await TestExecution.HandleCommentUpdateAsync(context.Item);
        
        if (success)
        {
            await FinalizeTestOperation(context.Item);
        }
    }

    private async Task Send(Io tag)
    {
        await EventHandling.SendSignalRMessageAsync(tag);
    }

    async Task<Io> SuccessAnimation()
    {
        AppState.UiState.PassAnimation = TestConstants.Styles.PASS_ANIMATION_VISIBLE;
        await Task.Delay(TestConstants.SUCCESS_ANIMATION_DURATION_MS);
        AppState.UiState.PassAnimation = TestConstants.Styles.PASS_ANIMATION_HIDDEN;
        
        // The row animation logic has been removed as SelectedIo doesn't exist
        // The pass animation will still show via the PassAnimation property
        
        return new Io(); // Return empty Io as placeholder
    }

    public void Dispose()
    {
        AppState.StateChanged -= OnStateChanged;
        CloudSyncService.ConnectionStateChanged -= OnCloudConnectionChanged;
        PlcCommunication.PlcConnectionChanged -= OnPlcConnectionChanged;
        ErrorDialogService.NotifyAlert -= OnErrorAlert;
        Configuration.ColumnVisibilityChanged -= OnColumnVisibilityChanged;
    }
} 
