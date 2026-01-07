using MudBlazor;
using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services.State;

public class FilterState
{
    private bool _openResultFilter = false;
    private string _resultFilterIcon = Icons.Material.Filled.FilterAlt;
    private Dictionary<string, bool> _resultItems = new()
    {
        {TestConstants.RESULT_PASSED, true},
        {TestConstants.RESULT_FAILED, true},
        {TestConstants.RESULT_NOT_TESTED, true}
    };

    private bool _openStateFilter = false;
    private string _stateFilterIcon = Icons.Material.Filled.FilterAlt;
    private Dictionary<string, bool> _stateItems = new()
    {
        {TestConstants.FilterStates.STATE_TRUE, true},
        {TestConstants.FilterStates.STATE_FALSE, true}
    };

    public bool OpenResultFilter
    {
        get => _openResultFilter;
        set
        {
            if (_openResultFilter != value)
            {
                _openResultFilter = value;
                StateChanged?.Invoke();
            }
        }
    }

    public string ResultFilterIcon
    {
        get => _resultFilterIcon;
        private set
        {
            if (_resultFilterIcon != value)
            {
                _resultFilterIcon = value;
                StateChanged?.Invoke();
            }
        }
    }

    public Dictionary<string, bool> ResultItems => _resultItems;

    public bool OpenStateFilter
    {
        get => _openStateFilter;
        set
        {
            if (_openStateFilter != value)
            {
                _openStateFilter = value;
                StateChanged?.Invoke();
            }
        }
    }

    public string StateFilterIcon
    {
        get => _stateFilterIcon;
        private set
        {
            if (_stateFilterIcon != value)
            {
                _stateFilterIcon = value;
                StateChanged?.Invoke();
            }
        }
    }

    public Dictionary<string, bool> StateItems => _stateItems;

    public event Action? StateChanged;

    public void SetResultFilter(string item, bool value)
    {
        if (_resultItems.ContainsKey(item) && _resultItems[item] != value)
        {
            _resultItems[item] = value;
            UpdateResultFilterIcon();
            StateChanged?.Invoke();
        }
    }

    public void SetStateFilter(string item, bool value)
    {
        if (_stateItems.ContainsKey(item) && _stateItems[item] != value)
        {
            _stateItems[item] = value;
            UpdateStateFilterIcon();
            StateChanged?.Invoke();
        }
    }

    public void ResetResultFilter()
    {
        _resultItems = new Dictionary<string, bool>
        {
            {TestConstants.RESULT_PASSED, true},
            {TestConstants.RESULT_FAILED, true},
            {TestConstants.RESULT_NOT_TESTED, true}
        };
        UpdateResultFilterIcon();
        StateChanged?.Invoke();
    }

    public void ResetStateFilter()
    {
        _stateItems = new Dictionary<string, bool>
        {
            {TestConstants.FilterStates.STATE_TRUE, true},
            {TestConstants.FilterStates.STATE_FALSE, true}
        };
        UpdateStateFilterIcon();
        StateChanged?.Invoke();
    }

    public void Reset()
    {
        ResetResultFilter();
        ResetStateFilter();
        OpenResultFilter = false;
        OpenStateFilter = false;
    }

    private void UpdateResultFilterIcon()
    {
        ResultFilterIcon = (_resultItems[TestConstants.RESULT_PASSED] && 
                           _resultItems[TestConstants.RESULT_FAILED] && 
                           _resultItems[TestConstants.RESULT_NOT_TESTED])
                           ? Icons.Material.Filled.FilterAlt
                           : Icons.Material.Outlined.FilterAlt;
    }

    private void UpdateStateFilterIcon()
    {
        StateFilterIcon = (_stateItems[TestConstants.FilterStates.STATE_TRUE] && 
                          _stateItems[TestConstants.FilterStates.STATE_FALSE])
                          ? Icons.Material.Filled.FilterAlt
                          : Icons.Material.Outlined.FilterAlt;
    }
} 