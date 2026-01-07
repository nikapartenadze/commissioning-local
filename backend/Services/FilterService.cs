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