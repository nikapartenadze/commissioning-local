using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IFilterService
{
    Func<Io, bool> CreateQuickFilter(IAppStateService appState);
    /// <summary>
    /// Creates a quick filter that also applies Hz interval filter when getHz and hzFilterItems are provided.
    /// </summary>
    Func<Io, bool> CreateQuickFilter(IAppStateService appState, Func<int, double>? getHz, IReadOnlyDictionary<string, bool>? hzFilterItems);
    Func<Io, int, string> CreateRowStyleFunction();
    Func<Io, object> CreateTimestampSortFunction();
    bool IsValidTestableItem(Io item);
    string GetRowStyle(Io item);
    bool PassesFilters(Io item, IAppStateService appState);
    /// <summary>
    /// Returns true if the item's Hz (from getHz) falls in at least one checked interval in hzFilterItems.
    /// </summary>
    bool PassesHzFilter(Io item, Func<int, double> getHz, IReadOnlyDictionary<string, bool> hzFilterItems);
} 