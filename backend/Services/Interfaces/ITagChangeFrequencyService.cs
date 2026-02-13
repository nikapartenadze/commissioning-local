namespace IO_Checkout_Tool.Services.Interfaces;

/// <summary>
/// Tracks tag value change frequency per I/O over a 5-second sliding window.
/// Fires HzUpdated per I/O only for I/Os in the active set (non-zero Hz).
/// </summary>
public interface ITagChangeFrequencyService
{
    /// <summary>
    /// Average changes per second over the last 5 seconds for the given I/O (0 if no changes).
    /// </summary>
    double GetHz(int ioId);

    /// <summary>
    /// Raised per I/O when that I/O's Hz was updated. Argument is the ioId.
    /// Fired only for I/Os in the active set (have had at least one change in the past 5 seconds).
    /// </summary>
    event Action<int>? HzUpdated;
}
