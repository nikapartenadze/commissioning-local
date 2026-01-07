using IO_Checkout_Tool.Services.State;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IAppStateService
{
    UiState UiState { get; }
    FilterState FilterState { get; }
    TestState TestState { get; }
    GraphState GraphState { get; }
    
    event Action? StateChanged;
    
    void Reset();
} 