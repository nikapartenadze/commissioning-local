using IO_Checkout_Tool.Services.PlcTags.Native;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services.PlcTags;

/// <summary>
/// Represents a group of boolean I/O points that share a parent DINT tag.
/// Instead of reading each boolean individually (1 CIP request per bit),
/// reads the parent DINT once (1 CIP request for up to 32 bits) and extracts individual bit values.
///
/// Example:
///   Individual reads: EPZ_PS2_FIO1:I.Pt00.Data, Pt01.Data, ..., Pt15.Data = 16 CIP requests
///   DINT group read:  EPZ_PS2_FIO1:I.Data = 1 CIP request, then extract bits 0-15 in software
/// </summary>
public class DintGroupTag : IDisposable
{
    private readonly NativeTag _tag;
    private readonly Dictionary<int, string> _bitToIoName; // bit offset → original IO tag name
    private readonly ILogger? _logger;
    private int _previousDintValue;
    private bool _hasValue;
    private bool _disposed;

    /// <summary>
    /// The parent DINT tag path (e.g., "EPZ_PS2_FIO1:I.Data")
    /// </summary>
    public string ParentTagPath { get; }

    /// <summary>
    /// The underlying NativeTag used for reading the DINT
    /// </summary>
    public NativeTag Tag => _tag;

    /// <summary>
    /// Mapping of bit offsets to original IO tag names
    /// </summary>
    public IReadOnlyDictionary<int, string> BitMappings => _bitToIoName;

    /// <summary>
    /// Number of individual IO points covered by this DINT group
    /// </summary>
    public int MemberCount => _bitToIoName.Count;

    public DintGroupTag(string parentTagPath, NativeTag tag, Dictionary<int, string> bitMappings, ILogger? logger = null)
    {
        ParentTagPath = parentTagPath;
        _tag = tag;
        _bitToIoName = new Dictionary<int, string>(bitMappings);
        _logger = logger;
    }

    /// <summary>
    /// Initialize the underlying DINT tag (create handle + verify connection)
    /// </summary>
    public int Initialize()
    {
        return _tag.Initialize();
    }

    /// <summary>
    /// Read the DINT from the PLC and extract all individual bit values.
    /// Returns the read status and a list of (IO name, bool value) for bits that changed.
    /// </summary>
    public async Task<(int status, List<(string ioName, bool value)> changes)> ReadAndExtractAsync(CancellationToken cancellationToken)
    {
        var status = await _tag.ReadAsync(cancellationToken);
        if (status != LibPlcTag.PLCTAG_STATUS_OK)
        {
            return (status, new List<(string, bool)>());
        }

        var dintValue = _tag.GetInt32(0);
        var changes = new List<(string ioName, bool value)>();

        foreach (var (bitOffset, ioName) in _bitToIoName)
        {
            var bitValue = (dintValue & (1 << bitOffset)) != 0;

            if (!_hasValue)
            {
                // First read - report all values as changes for initial state
                changes.Add((ioName, bitValue));
            }
            else
            {
                var previousBitValue = (_previousDintValue & (1 << bitOffset)) != 0;
                if (bitValue != previousBitValue)
                {
                    changes.Add((ioName, bitValue));
                }
            }
        }

        _previousDintValue = dintValue;
        _hasValue = true;

        return (status, changes);
    }

    /// <summary>
    /// Get all current bit values without reading from PLC (uses cached DINT value).
    /// Returns empty dictionary if no value has been read yet.
    /// </summary>
    public Dictionary<string, bool> GetAllCurrentValues()
    {
        if (!_hasValue)
            return new Dictionary<string, bool>();

        var values = new Dictionary<string, bool>();
        foreach (var (bitOffset, ioName) in _bitToIoName)
        {
            values[ioName] = (_previousDintValue & (1 << bitOffset)) != 0;
        }
        return values;
    }

    /// <summary>
    /// Read the DINT and return all current values (for initialization).
    /// </summary>
    public async Task<(int status, Dictionary<string, bool> values)> ReadAllValuesAsync(CancellationToken cancellationToken = default)
    {
        var status = await _tag.ReadAsync(cancellationToken);
        if (status != LibPlcTag.PLCTAG_STATUS_OK)
        {
            return (status, new Dictionary<string, bool>());
        }

        var dintValue = _tag.GetInt32(0);
        _previousDintValue = dintValue;
        _hasValue = true;

        var values = new Dictionary<string, bool>();
        foreach (var (bitOffset, ioName) in _bitToIoName)
        {
            values[ioName] = (dintValue & (1 << bitOffset)) != 0;
        }

        return (status, values);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _tag?.Dispose();
    }
}
