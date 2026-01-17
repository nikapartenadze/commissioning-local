using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Linq;
using IO_Checkout_Tool.Services.PlcTags.Native;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services.PlcTags;

/// <summary>
/// Native wrapper for libplctag that provides similar functionality to NotifyValueChangedTag
/// </summary>
public class NativeTag : IDisposable
{
    private int _tagHandle = -1;
    private readonly string _tagPath;
    private readonly ILogger<NativeTag> _logger;
    private volatile sbyte _currentValue;
    private volatile bool _hasValue;
    private bool _disposed;

    // Global cancellation for aborting all pending tag operations
    private static volatile bool _globalAbort = false;

    /// <summary>
    /// Signal all NativeTag operations to abort immediately
    /// </summary>
    public static void AbortAllOperations()
    {
        _globalAbort = true;
    }

    /// <summary>
    /// Reset the global abort flag (call before starting new operations)
    /// </summary>
    public static void ResetAbort()
    {
        _globalAbort = false;
    }

    /// <summary>
    /// Check if operations should be aborted
    /// </summary>
    public static bool ShouldAbort => _globalAbort;

    // Events
    public event EventHandler? ValueChanged;
    
    public string Name { get; }
    public sbyte Value 
    { 
        get => _currentValue;
        set
        {
            if (_tagHandle >= 0)
            {
                var status = LibPlcTag.plc_tag_set_int8(_tagHandle, 0, value);
                if (status == LibPlcTag.PLCTAG_STATUS_OK)
                {
                    var oldValue = _currentValue;
                    _currentValue = value;
                    _hasValue = true;
                    
                    if (oldValue != value)
                    {
                        ValueChanged?.Invoke(this, EventArgs.Empty);
                    }
                }
            }
        }
    }
    
    public NativeTag(string name, string gateway, string path, int timeout = 5000, ILogger<NativeTag>? logger = null)
    {
        Name = name;
        _logger = logger ?? new LoggerFactory().CreateLogger<NativeTag>();
        
        // Build tag path similar to libplctag.NET
        _tagPath = $"protocol=ab_eip&gateway={gateway}&path={path}&cpu=logix&elem_size=1&elem_count=1&name={name}";
    }
    
    /// <summary>
    /// Create the tag handle without initializing. Call InitializeDeferred() to complete initialization.
    /// </summary>
    public int CreateDeferred()
    {
        if (_tagHandle >= 0)
            return LibPlcTag.PLCTAG_STATUS_OK;
            
        // Create tag without waiting for it to complete
        _tagHandle = LibPlcTag.plc_tag_create(_tagPath, 0);
        
        if (_tagHandle < 0)
        {
            _logger.LogError("Failed to create tag {Name}: {Error}", Name, LibPlcTag.DecodeError(_tagHandle));
            return _tagHandle;
        }
        

        return LibPlcTag.PLCTAG_STATUS_OK;
    }
    
    /// <summary>
    /// Complete initialization of a deferred tag
    /// </summary>
    public int InitializeDeferred(int timeout = 5000)
    {
        if (_tagHandle < 0)
            return LibPlcTag.PLCTAG_ERR_NOT_FOUND;
            
        // Wait for tag creation to complete
        var status = WaitForStatusOptimized(timeout);
        if (status != LibPlcTag.PLCTAG_STATUS_OK)
        {
            _logger.LogError("Tag {Name} deferred initialization failed with status: {Status}", Name, LibPlcTag.DecodeError(status));
            return status;
        }
        

        return LibPlcTag.PLCTAG_STATUS_OK;
    }
    
    public int Initialize()
    {
        if (_tagHandle >= 0)
            return LibPlcTag.PLCTAG_STATUS_OK;
        
        // Create without callback (faster)
        _tagHandle = LibPlcTag.plc_tag_create(_tagPath, 0); // Non-blocking
        
        if (_tagHandle < 0)
        {
            _logger.LogError("Failed to create tag {Name}: {Error}", Name, LibPlcTag.DecodeError(_tagHandle));
            return _tagHandle;
        }
        
        // Wait for tag creation to complete
        var status = WaitForStatusOptimized(5000);
        if (status != LibPlcTag.PLCTAG_STATUS_OK)
        {
            _logger.LogError("Tag {Name} creation failed with status: {Status}", Name, LibPlcTag.DecodeError(status));
            Dispose();
            return status;
        }

        // CRITICAL: Tag creation STATUS_OK only validates connection + syntax, NOT tag existence!
        // We must perform a read to verify the tag actually exists in the PLC
        var readStatus = LibPlcTag.plc_tag_read(_tagHandle, 0);
        if (readStatus == LibPlcTag.PLCTAG_STATUS_PENDING)
        {
            // Wait for read to complete
            readStatus = WaitForStatusOptimized(1000);
        }
        
        if (readStatus != LibPlcTag.PLCTAG_STATUS_OK)
        {
            _logger.LogError("Tag {Name} existence validation failed with read status: {Status} ({Code})", Name, LibPlcTag.DecodeError(readStatus), readStatus);
            Dispose();
            return readStatus;
        }
        
        // Check tag status after read attempt - this might reveal the real error
        var tagStatus = LibPlcTag.plc_tag_status(_tagHandle);
        if (tagStatus != LibPlcTag.PLCTAG_STATUS_OK)
        {
            _logger.LogError("Tag {Name} existence validation failed with tag status: {Status} ({Code})", Name, LibPlcTag.DecodeError(tagStatus), tagStatus);
            Dispose();
            return tagStatus;
        }
        
        // Read the initial value to complete validation
        var initialValue = LibPlcTag.plc_tag_get_int8(_tagHandle, 0);
        
        // CRITICAL: For digital I/O tags, check if value indicates a fault condition
        // Valid boolean values should only be 0 or 1. Anything else (like -21) indicates module fault/offline
        if (initialValue != 0 && initialValue != 1)
        {
            _logger.LogError("Tag {Name} has fault/offline value: {Value} (expected 0 or 1) - likely module offline or fault condition", Name, initialValue);
            Dispose();
            return LibPlcTag.PLCTAG_ERR_BAD_STATUS; // Use appropriate error code for fault condition
        }
        
        _currentValue = initialValue;
        _hasValue = true;
        
        return LibPlcTag.PLCTAG_STATUS_OK;
    }
    
    /// <summary>
    /// Batch initialization for multiple tags (static method)
    /// </summary>
    public static async Task<Dictionary<NativeTag, int>> InitializeBatchAsync(
        List<NativeTag> tags, int batchSize = 100, int timeout = 5000)
    {
        var results = new ConcurrentDictionary<NativeTag, int>();
        
        // Process in batches for optimal performance
        for (int i = 0; i < tags.Count; i += batchSize)
        {
            var batch = tags.Skip(i).Take(batchSize).ToList();
            
            // Create all handles in parallel
            var createTasks = batch.Select(tag => Task.Run(() =>
            {
                tag._tagHandle = LibPlcTag.plc_tag_create(tag._tagPath, 0);
                return (tag, handle: tag._tagHandle);
            })).ToArray();
            
            await Task.WhenAll(createTasks);
            
            // Wait for connections in parallel
            var connectTasks = createTasks
                .Where(t => t.Result.handle >= 0)
                .Select(t => Task.Run(() =>
                {
                    var tag = t.Result.tag;
                    var sw = new SpinWait();
                    var start = Environment.TickCount;
                    
                    while (true)
                    {
                        var status = LibPlcTag.plc_tag_status(tag._tagHandle);
                        
                        if (status != LibPlcTag.PLCTAG_STATUS_PENDING)
                        {
                            results.TryAdd(tag, status);
                            return status;
                        }
                        
                        if (Environment.TickCount - start > timeout)
                        {
                            results.TryAdd(tag, LibPlcTag.PLCTAG_ERR_TIMEOUT);
                            return LibPlcTag.PLCTAG_ERR_TIMEOUT;
                        }
                        
                        sw.SpinOnce();
                        if (sw.NextSpinWillYield)
                            Thread.Yield();
                    }
                })).ToArray();
            
            await Task.WhenAll(connectTasks);
            
            // Add failed creates to results
            foreach (var t in createTasks.Where(t => t.Result.handle < 0))
            {
                results.TryAdd(t.Result.tag, t.Result.handle);
            }
        }
        
        return results.ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
    }
    
    public int Read()
    {
        if (_tagHandle < 0)
            return LibPlcTag.PLCTAG_ERR_NOT_FOUND;
            
        var status = LibPlcTag.plc_tag_read(_tagHandle, 0); // Non-blocking
        if (status == LibPlcTag.PLCTAG_STATUS_PENDING)
        {
            // Wait for read operation to complete
            status = WaitForReadStatusOptimized(1000);
        }
        
        if (status == LibPlcTag.PLCTAG_STATUS_OK)
        {
            var newValue = LibPlcTag.plc_tag_get_int8(_tagHandle, 0);
            var oldValue = _currentValue;
            _currentValue = newValue;
            _hasValue = true;
            
            if (oldValue != newValue)
            {
                ValueChanged?.Invoke(this, EventArgs.Empty);
            }
        }
        
        return status;
    }
    
    public async Task<int> ReadAsync(CancellationToken cancellationToken = default)
    {
        if (_tagHandle < 0)
            return LibPlcTag.PLCTAG_ERR_NOT_FOUND;
            
        // Start non-blocking read
        var status = LibPlcTag.plc_tag_read(_tagHandle, 0);
        if (status != LibPlcTag.PLCTAG_STATUS_PENDING && status != LibPlcTag.PLCTAG_STATUS_OK)
            return status;
            
        // Add timeout to prevent infinite spinning when PLC is disconnected
        var startTime = Environment.TickCount;
        const int timeoutMs = 2000; // 2 second timeout - if PLC is disconnected, reads should fail quickly
        
        // Use SpinWait for efficient async polling
        var sw = new SpinWait();
        while (!cancellationToken.IsCancellationRequested)
        {
            status = LibPlcTag.plc_tag_status(_tagHandle);
            
            if (status != LibPlcTag.PLCTAG_STATUS_PENDING)
            {
                if (status == LibPlcTag.PLCTAG_STATUS_OK)
                {
                    var newValue = LibPlcTag.plc_tag_get_int8(_tagHandle, 0);
                    var oldValue = _currentValue;
                    _currentValue = newValue;
                    _hasValue = true;
                    
                    if (oldValue != newValue)
                    {
                        ValueChanged?.Invoke(this, EventArgs.Empty);
                    }
                }
                return status;
            }
            
            // Check for timeout - this is critical for PLC disconnection detection!
            if (Environment.TickCount - startTime > timeoutMs)
            {
                _logger.LogWarning("Tag {Name} read timed out after {TimeoutMs}ms - likely PLC disconnection", Name, timeoutMs);
                return LibPlcTag.PLCTAG_ERR_TIMEOUT;
            }
            
            sw.SpinOnce();
            
            // Only use async delay if we've been spinning for a while
            if (sw.NextSpinWillYield)
            {
                await Task.Yield();
            }
        }
        
        throw new OperationCanceledException();
    }
    
    public int Write()
    {
        if (_tagHandle < 0)
            return LibPlcTag.PLCTAG_ERR_NOT_FOUND;
            
        return LibPlcTag.plc_tag_write(_tagHandle, 1000);
    }
    
    /// <summary>
    /// Optimized wait using SpinWait instead of Thread.Sleep for tag creation/connection
    /// </summary>
    private int WaitForStatusOptimized(int timeoutMs)
    {
        var sw = new SpinWait();
        var startTime = Environment.TickCount;
        int status;

        while (true)
        {
            // Check for global abort (disconnect was requested) - silent return
            if (_globalAbort)
            {
                return LibPlcTag.PLCTAG_ERR_ABORT;
            }

            status = LibPlcTag.plc_tag_status(_tagHandle);
            if (status != LibPlcTag.PLCTAG_STATUS_PENDING)
                break;

            if (Environment.TickCount - startTime > timeoutMs)
            {
                status = LibPlcTag.PLCTAG_ERR_TIMEOUT;
                break;
            }

            sw.SpinOnce();

            // Only yield if we've been spinning for a while
            if (sw.NextSpinWillYield)
            {
                Thread.Yield();
            }
        }

        return status;
    }
    
    /// <summary>
    /// Optimized wait specifically for read operations - polls read status not connection status
    /// </summary>
    private int WaitForReadStatusOptimized(int timeoutMs)
    {
        var sw = new SpinWait();
        var startTime = Environment.TickCount;
        int status;

        while (true)
        {
            // Check for global abort (disconnect was requested)
            if (_globalAbort)
            {
                return LibPlcTag.PLCTAG_ERR_ABORT;
            }

            status = LibPlcTag.plc_tag_status(_tagHandle);
            if (status != LibPlcTag.PLCTAG_STATUS_PENDING)
                break;

            if (Environment.TickCount - startTime > timeoutMs)
            {
                status = LibPlcTag.PLCTAG_ERR_TIMEOUT;
                break;
            }

            sw.SpinOnce();

            // Only yield if we've been spinning for a while
            if (sw.NextSpinWillYield)
            {
                Thread.Yield();
            }
        }

        return status;
    }
    
    public void Dispose()
    {
        if (_disposed)
            return;
            
        _disposed = true;
        
        if (_tagHandle >= 0)
        {
            LibPlcTag.plc_tag_destroy(_tagHandle);
            _tagHandle = -1;
        }
        
        GC.SuppressFinalize(this);
    }
} 