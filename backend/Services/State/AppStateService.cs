using IO_Checkout_Tool.SharedComponents;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Services.State;

public class AppStateService : IAppStateService
{
    public UiState UiState { get; }
    public FilterState FilterState { get; }
    public TestState TestState { get; }
    public GraphState GraphState { get; }

    public event Action? StateChanged;

    public AppStateService()
    {
        UiState = new UiState();
        FilterState = new FilterState();
        TestState = new TestState();
        GraphState = new GraphState();

        UiState.StateChanged += NotifyStateChanged;
        FilterState.StateChanged += NotifyStateChanged;
        TestState.StateChanged += NotifyStateChanged;
        GraphState.StateChanged += NotifyStateChanged;
    }

    private void NotifyStateChanged() => StateChanged?.Invoke();

    public void Reset()
    {
        UiState.Reset();
        FilterState.Reset();
        TestState.Reset();
        GraphState.Reset();
    }
} 