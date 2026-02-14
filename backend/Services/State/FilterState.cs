using System.Linq;
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

    private bool _openHzFilter = false;
    private string _hzFilterIcon = Icons.Material.Filled.FilterAlt;
    private Dictionary<string, bool> _hzItems = new()
    {
        {TestConstants.HzFilterIntervals.Over5, true},
        {TestConstants.HzFilterIntervals.From2To5, true},
        {TestConstants.HzFilterIntervals.From1To2, true},
        {TestConstants.HzFilterIntervals.From05To1, true},
        {TestConstants.HzFilterIntervals.From02To05, true},
        {TestConstants.HzFilterIntervals.From0To02, true},
        {TestConstants.HzFilterIntervals.Zero, true}
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

    public bool OpenHzFilter
    {
        get => _openHzFilter;
        set
        {
            if (_openHzFilter != value)
            {
                _openHzFilter = value;
                StateChanged?.Invoke();
            }
        }
    }

    public string HzFilterIcon
    {
        get => _hzFilterIcon;
        private set
        {
            if (_hzFilterIcon != value)
            {
                _hzFilterIcon = value;
                StateChanged?.Invoke();
            }
        }
    }

    public Dictionary<string, bool> HzItems => _hzItems;

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

    public void SetHzFilter(string item, bool value)
    {
        if (_hzItems.ContainsKey(item) && _hzItems[item] != value)
        {
            _hzItems[item] = value;
            UpdateHzFilterIcon();
            StateChanged?.Invoke();
        }
    }

    public void ResetHzFilter()
    {
        _hzItems = new Dictionary<string, bool>
        {
            {TestConstants.HzFilterIntervals.Over5, true},
            {TestConstants.HzFilterIntervals.From2To5, true},
            {TestConstants.HzFilterIntervals.From1To2, true},
            {TestConstants.HzFilterIntervals.From05To1, true},
            {TestConstants.HzFilterIntervals.From02To05, true},
            {TestConstants.HzFilterIntervals.From0To02, true},
            {TestConstants.HzFilterIntervals.Zero, true}
        };
        UpdateHzFilterIcon();
        StateChanged?.Invoke();
    }

    public void Reset()
    {
        ResetResultFilter();
        ResetStateFilter();
        ResetHzFilter();
        OpenResultFilter = false;
        OpenStateFilter = false;
        OpenHzFilter = false;
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

    private void UpdateHzFilterIcon()
    {
        var allChecked = _hzItems.Values.All(v => v);
        HzFilterIcon = allChecked ? Icons.Material.Filled.FilterAlt : Icons.Material.Outlined.FilterAlt;
    }
} 