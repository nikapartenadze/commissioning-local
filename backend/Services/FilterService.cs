using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

public class FilterService : IFilterService
{
    public Func<Io, bool> CreateQuickFilter(IAppStateService appState)
    {
        return x => PassesFilters(x, appState);
    }

    public Func<Io, bool> CreateQuickFilter(IAppStateService appState, Func<int, double>? getHz, IReadOnlyDictionary<string, bool>? hzFilterItems)
    {
        if (getHz == null || hzFilterItems == null)
            return CreateQuickFilter(appState);
        return x => PassesFilters(x, appState) && PassesHzFilter(x, getHz, hzFilterItems);
    }

    /// <summary>
    /// Returns the Hz filter interval key for a given frequency (e.g. "2-5 Hz", "0 Hz", ">5 Hz").
    /// </summary>
    public static string GetHzIntervalKey(double hz)
    {
        if (hz <= 0) return TestConstants.HzFilterIntervals.Zero;
        if (hz <= 0.2) return TestConstants.HzFilterIntervals.From0To02;
        if (hz <= 0.5) return TestConstants.HzFilterIntervals.From02To05;
        if (hz <= 1) return TestConstants.HzFilterIntervals.From05To1;
        if (hz <= 2) return TestConstants.HzFilterIntervals.From1To2;
        if (hz <= 5) return TestConstants.HzFilterIntervals.From2To5;
        return TestConstants.HzFilterIntervals.Over5;
    }

    public Func<Io, int, string> CreateRowStyleFunction()
    {
        return (x, i) => GetRowStyle(x);
    }

    public Func<Io, object> CreateTimestampSortFunction()
    {
        return x => DateTime.Parse(x.Timestamp!);
    }

    public bool IsValidTestableItem(Io item)
    {
        var isSpareInputOutput = item.Description?.Contains("SPARE") == true || 
                                item.Description == TestConstants.DESC_INPUT || 
                                item.Description == TestConstants.DESC_OUTPUT;
        
        var hasNoResult = item.Result == null || item.Result == string.Empty;
        
        // Hide spare/input/output items that have no results
        return !(isSpareInputOutput && hasNoResult);
    }

    public string GetRowStyle(Io item)
    {
        return item.Result switch
        {
            TestConstants.RESULT_PASSED => TestConstants.Styles.ROW_PASSED,
            TestConstants.RESULT_FAILED => TestConstants.Styles.ROW_FAILED,
            _ => TestConstants.Styles.ROW_DEFAULT
        };
    }

    public bool PassesFilters(Io item, IAppStateService appState)
    {
        // First check if it's a valid testable item
        if (!IsValidTestableItem(item))
            return false;

        // Check state filters
        if (!PassesStateFilters(item, appState))
            return false;

        // Check result filters
        if (!PassesResultFilters(item, appState))
            return false;

        return true;
    }

    public bool PassesHzFilter(Io item, Func<int, double> getHz, IReadOnlyDictionary<string, bool> hzFilterItems)
    {
        var hz = getHz(item.Id);
        var key = GetHzIntervalKey(hz);
        return hzFilterItems.TryGetValue(key, out var checked_) && checked_;
    }

    private bool PassesStateFilters(Io item, IAppStateService appState)
    {
        if (appState.FilterState.StateItems[TestConstants.FilterStates.STATE_TRUE] == false && 
            item.State == TestConstants.FilterStates.STATE_TRUE)
            return false;

        if (appState.FilterState.StateItems[TestConstants.FilterStates.STATE_FALSE] == false && 
            item.State == TestConstants.FilterStates.STATE_FALSE)
            return false;

        return true;
    }

    private bool PassesResultFilters(Io item, IAppStateService appState)
    {
        if (appState.FilterState.ResultItems[TestConstants.RESULT_PASSED] == false && 
            item.Result == TestConstants.RESULT_PASSED)
            return false;

        if (appState.FilterState.ResultItems[TestConstants.RESULT_FAILED] == false && 
            item.Result == TestConstants.RESULT_FAILED)
            return false;

        if (appState.FilterState.ResultItems[TestConstants.RESULT_NOT_TESTED] == false && 
            (item.Result == null || item.Result == string.Empty))
            return false;

        return true;
    }
} 