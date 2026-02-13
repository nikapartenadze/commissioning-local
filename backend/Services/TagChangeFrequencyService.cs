using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Tracks tag value change frequency per I/O over a 5-second sliding window.
/// Maintains an active set of I/Os with at least one change in the past 5 seconds.
/// Every 500 ms, prunes and fires HzUpdated only for I/Os in the active set;
/// removes an I/O from the set when its count reaches 0.
/// </summary>
public class TagChangeFrequencyService : ITagChangeFrequencyService, IDisposable
{
    private const double WindowSeconds = 5.0;
    private const int TimerIntervalMs = 500;

    private readonly ITagReaderService _tagReader;
    private readonly object _lock = new();
    private readonly Dictionary<int, List<DateTime>> _timestamps = new();
    private readonly HashSet<int> _activeSet = new();
    private Timer? _pruneTimer;
    private bool _disposed;

    public event Action<int>? HzUpdated;
    public event Action? AnyHzUpdated;

    public TagChangeFrequencyService(ITagReaderService tagReader)
    {
        _tagReader = tagReader;
        _tagReader.TagValueChanged += OnTagValueChanged;
        _pruneTimer = new Timer(OnPruneTick, null, TimerIntervalMs, TimerIntervalMs);
    }

    public double GetHz(int ioId)
    {
        lock (_lock)
        {
            if (!_timestamps.TryGetValue(ioId, out var list) || list.Count == 0)
                return 0;

            PruneToLastFiveSeconds(list);
            return list.Count / WindowSeconds;
        }
    }

    private void OnTagValueChanged(Io io)
    {
        var ioId = io.Id;
        var now = DateTime.UtcNow;

        lock (_lock)
        {
            if (!_timestamps.TryGetValue(ioId, out var list))
            {
                list = new List<DateTime>();
                _timestamps[ioId] = list;
            }
            list.Add(now);
            _activeSet.Add(ioId);
        }
    }

    private void OnPruneTick(object? _)
    {
        List<int> toNotify;
        lock (_lock)
        {
            toNotify = new List<int>(_activeSet.Count);
            foreach (var ioId in _activeSet.ToList())
            {
                if (!_timestamps.TryGetValue(ioId, out var list))
                    continue;
                PruneToLastFiveSeconds(list);
                toNotify.Add(ioId);
                if (list.Count == 0)
                    _activeSet.Remove(ioId);
            }
        }

        foreach (var ioId in toNotify)
            HzUpdated?.Invoke(ioId);
        if (toNotify.Count > 0)
            AnyHzUpdated?.Invoke();
    }

    private static void PruneToLastFiveSeconds(List<DateTime> list)
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-WindowSeconds);
        for (var i = list.Count - 1; i >= 0; i--)
        {
            if (list[i] < cutoff)
                list.RemoveAt(i);
        }
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        _tagReader.TagValueChanged -= OnTagValueChanged;
        _pruneTimer?.Dispose();
        _pruneTimer = null;
        _disposed = true;
        GC.SuppressFinalize(this);
    }
}
