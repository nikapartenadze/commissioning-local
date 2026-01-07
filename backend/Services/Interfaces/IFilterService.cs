using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface IFilterService
{
    Func<Io, bool> CreateQuickFilter(IAppStateService appState);
    Func<Io, int, string> CreateRowStyleFunction();
    Func<Io, object> CreateTimestampSortFunction();
    bool IsValidTestableItem(Io item);
    string GetRowStyle(Io item);
    bool PassesFilters(Io item, IAppStateService appState);
} 