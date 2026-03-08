using System.Collections.Concurrent;
using Serilog.Core;
using Serilog.Events;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// In-memory ring buffer that captures recent log entries.
/// Used to stream backend logs to the frontend during PLC connection setup.
/// </summary>
public class RecentLogService : ILogEventSink
{
    private readonly ConcurrentQueue<LogEntry> _entries = new();
    private const int MaxEntries = 200;
    private long _sequence = 0;

    public void Emit(LogEvent logEvent)
    {
        var entry = new LogEntry
        {
            Id = Interlocked.Increment(ref _sequence),
            Timestamp = logEvent.Timestamp.LocalDateTime,
            Level = logEvent.Level.ToString().Substring(0, 3).ToUpper(),
            Message = logEvent.RenderMessage(),
        };

        _entries.Enqueue(entry);

        // Trim to max size
        while (_entries.Count > MaxEntries)
            _entries.TryDequeue(out _);
    }

    /// <summary>
    /// Get log entries after a given sequence ID. Pass 0 to get all.
    /// </summary>
    public List<LogEntry> GetEntriesSince(long afterId)
    {
        return _entries.Where(e => e.Id > afterId).ToList();
    }

    public class LogEntry
    {
        public long Id { get; set; }
        public DateTime Timestamp { get; set; }
        public string Level { get; set; } = "";
        public string Message { get; set; } = "";
    }
}
