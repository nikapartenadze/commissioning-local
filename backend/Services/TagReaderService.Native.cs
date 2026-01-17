using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IO_Checkout_Tool.Constants;
using Shared.Library.Models.Entities;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.PlcTags;
using IO_Checkout_Tool.Services.PlcTags.Native;
using Microsoft.Extensions.Logging;
using System.Collections.Concurrent;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Example implementation of TagReaderService using native P/Invoke instead of libplctag.NET wrapper
/// </summary>
public class NativeTagReaderService : ITagReaderService, IDisposable
{
    private readonly IErrorDialogService _errorDialogService;
    private readonly ILogger<NativeTagReaderService> _logger;
    private readonly IPlcTagFactoryService? _tagFactory;
    private readonly IPlcConnectionService? _connectionService;
    private readonly List<NativeTag> _tags = new();
    private readonly List<string> _notFoundTags = [];
    private readonly List<string> _illegalTags = [];
    private readonly List<string> _unknownTags = [];
    private CancellationTokenSource? _readingCancellationToken;
    private bool _disposed = false;
    private bool _tagReadError = false;
    private DateTime _lastErrorDialogTime = DateTime.MinValue;
    private readonly TimeSpan _errorDialogCooldown = TimeSpan.FromSeconds(5); // Quick notification but prevent spam
    private bool _lastConnectionStatus = true; // Assume connected initially
    private int _consecutiveErrorCycles = 0;
    private readonly object _errorStateLock = new object();
    private bool _reconnectionInProgress = false;
    private List<Io>? _originalTagList; // Keep reference for reinitializing
    private bool _errorDialogShownThisDisconnection = false; // Ensure dialog shows only once per disconnection
    private volatile bool _isResetting = false; // Flag to indicate reset/subsystem switch in progress
    private volatile bool _hasConfigurationErrors = false; // Flag to prevent reconnection on config errors
    private volatile bool _initialValidationCompleted = false; // Flag to ensure individual validation only runs once
    
    // Performance tracking
    private readonly Stopwatch _performanceStopwatch = new();
    private int _totalReadCycles = 0;
    private long _totalReadTimeMs = 0;
    private readonly object _perfLock = new object();

    public event Action<Io>? TagValueChanged;
    public event Action? StateChanged;
    public event Action<bool>? ConnectionStatusChanged;

    public NativeTagReaderService(IErrorDialogService errorDialogService, ILogger<NativeTagReaderService> logger,
        IPlcTagFactoryService? tagFactory = null, IPlcConnectionService? connectionService = null)
    {
        _errorDialogService = errorDialogService;
        _logger = logger;
        _tagFactory = tagFactory;
        _connectionService = connectionService;
        
        // Initialize the library (set debug level if needed)
        LibPlcTag.plc_tag_set_debug_level(LibPlcTag.PLCTAG_DEBUG_ERROR);
        
        // Check library version
        var versionCheck = LibPlcTag.plc_tag_check_lib_version(2, 6, 0);
        if (versionCheck != LibPlcTag.PLCTAG_STATUS_OK)
        {
            _logger.LogWarning("Library version may not be compatible");
        }
    }

    public async Task<bool> InitializeReadingAsync(List<NativeTag> tags, List<Io> tagList, bool skipErrorDetection = false, CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Initializing native tag reading for {Count} tags with optimized batch initialization", tags.Count);

        // Check for cancellation at the start
        if (cancellationToken.IsCancellationRequested)
        {
            _logger.LogInformation("Tag initialization cancelled before starting");
            return false;
        }
        
        // Clear any existing tags first (important for reconnection scenarios)
        if (_tags.Any())
        {
            _logger.LogWarning("Clearing {Count} existing tags before reinitializing", _tags.Count);
            foreach (var existingTag in _tags)
            {
                try
                {
                    existingTag.Dispose();
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error disposing existing tag during reinitialization");
                }
            }
            _tags.Clear();
        }
        
        // Cancel any existing reading operations
        _readingCancellationToken?.Cancel();
        
        // Clear any existing tag error lists for clean initialization
        _notFoundTags.Clear();
        _illegalTags.Clear();
        _unknownTags.Clear();
        
        // Reset all error states for clean reconnection
        lock (_errorStateLock)
        {
            _tagReadError = false;
            _consecutiveErrorCycles = 0;
            _reconnectionInProgress = false;
            _errorDialogShownThisDisconnection = false; // Allow new dialog for next disconnection
            _hasConfigurationErrors = false; // Reset config error flag for new initialization
        }
        
        _originalTagList = tagList; // Store for potential reconnection
        
        try
        {
            List<NativeTag> successfulTags;
            int successCount = 0; // Declare at broader scope for both paths
            
            // Check if this is the first time or a reconnection
            if (!_initialValidationCompleted)
            {
                // FIRST TIME ONLY: Do parallel batch validation to get proper error codes
                _logger.LogInformation("Starting parallel batch validation of ALL {Count} tags to get proper error codes (FIRST TIME ONLY)", tags.Count);
                var stopwatch = Stopwatch.StartNew();
                
                successfulTags = new List<NativeTag>();
                var failedTags = new List<string>();
                
                // Process in parallel batches (same approach as continuous reading)
                var batchSize = PlcConstants.OptimizedBatchSize; // Use same batch size as continuous reading
                var batches = new List<List<NativeTag>>();
                
                for (int i = 0; i < tags.Count; i += batchSize)
                {
                    batches.Add(tags.Skip(i).Take(batchSize).ToList());
                }
                
                _logger.LogInformation("Validating {Count} tags in {BatchCount} parallel batches of ~{BatchSize} tags each", 
                    tags.Count, batches.Count, batchSize);
                
                // Validate all batches in parallel
                var batchTasks = batches.Select(async batch =>
                {
                    var batchSuccessful = new List<NativeTag>();
                    var batchFailed = new List<string>();

                    // Check for cancellation/abort before processing batch
                    if (cancellationToken.IsCancellationRequested || NativeTag.ShouldAbort)
                    {
                        // Dispose all tags in this batch without logging errors
                        foreach (var tag in batch)
                        {
                            try { tag.Dispose(); } catch { }
                        }
                        return (successful: batchSuccessful, failed: batchFailed);
                    }

                    // Validate all tags in this batch in parallel
                    var tagTasks = batch.Select(async tag =>
                    {
                        try
                        {
                            // Check for cancellation/abort before each tag - silent exit
                            if (cancellationToken.IsCancellationRequested || NativeTag.ShouldAbort)
                            {
                                try { tag.Dispose(); } catch { }
                                return (success: false, tag: tag, error: "cancelled");
                            }

                            // Initialize the tag first
                            var initStatus = tag.Initialize();

                            // If aborted during init, don't log error - just clean up
                            if (NativeTag.ShouldAbort || initStatus == LibPlcTag.PLCTAG_ERR_ABORT)
                            {
                                try { tag.Dispose(); } catch { }
                                return (success: false, tag: tag, error: "cancelled");
                            }

                            if (initStatus != LibPlcTag.PLCTAG_STATUS_OK)
                            {
                                _logger.LogError("Tag {Name} failed initialization with status: {Status} ({StatusCode})",
                                    tag.Name, LibPlcTag.DecodeError(initStatus), initStatus);
                                HandleTagError(tag.Name, initStatus);
                                tag.Dispose(); // Clean up failed tag
                                return (success: false, tag: tag, error: "init");
                            }

                            // Check for cancellation/abort after init - silent exit
                            if (cancellationToken.IsCancellationRequested || NativeTag.ShouldAbort)
                            {
                                try { tag.Dispose(); } catch { }
                                return (success: false, tag: tag, error: "cancelled");
                            }

                            // Now READ the tag to verify it actually exists and is accessible
                            var readStatus = await tag.ReadAsync(cancellationToken);

                            // If aborted during read, don't log error - just clean up
                            if (NativeTag.ShouldAbort || readStatus == LibPlcTag.PLCTAG_ERR_ABORT)
                            {
                                try { tag.Dispose(); } catch { }
                                return (success: false, tag: tag, error: "cancelled");
                            }

                            if (readStatus != LibPlcTag.PLCTAG_STATUS_OK)
                            {
                                _logger.LogError("Tag {Name} failed read validation with status: {Status} ({StatusCode})",
                                    tag.Name, LibPlcTag.DecodeError(readStatus), readStatus);
                                HandleTagError(tag.Name, readStatus);
                                tag.Dispose(); // Clean up failed tag
                                return (success: false, tag: tag, error: "read");
                            }

                            // Tag fully validated (init + read successful)
                            return (success: true, tag: tag, error: "");
                        }
                        catch (OperationCanceledException)
                        {
                            try { tag.Dispose(); } catch { }
                            return (success: false, tag: tag, error: "cancelled");
                        }
                        catch (Exception ex)
                        {
                            // Only log if not aborted
                            if (!NativeTag.ShouldAbort)
                            {
                                _logger.LogError(ex, "Exception during validation of tag {Name}", tag.Name);
                                HandleTagError(tag.Name, -1);
                            }
                            try { tag.Dispose(); } catch { } // Clean up on exception
                            return (success: false, tag: tag, error: "exception");
                        }
                    });
                    
                    var results = await Task.WhenAll(tagTasks);
                    
                    // Collect results from this batch
                    foreach (var result in results)
                    {
                        if (result.success)
                        {
                            batchSuccessful.Add(result.tag);
                        }
                        else
                        {
                            batchFailed.Add(result.tag.Name);
                        }
                    }
                    
                    return (successful: batchSuccessful, failed: batchFailed);
                });
                
                // Wait for all batches to complete
                var batchResults = await Task.WhenAll(batchTasks);

                // Check for cancellation after batch processing
                if (cancellationToken.IsCancellationRequested)
                {
                    _logger.LogInformation("Tag initialization cancelled - cleaning up");
                    // Dispose any successful tags since we're cancelling
                    foreach (var result in batchResults)
                    {
                        foreach (var tag in result.successful)
                        {
                            try { tag.Dispose(); } catch { }
                        }
                    }
                    return false;
                }

                // Combine results from all batches
                foreach (var batchResult in batchResults)
                {
                    successfulTags.AddRange(batchResult.successful);
                    failedTags.AddRange(batchResult.failed);
                }
                
                successCount = successfulTags.Count;
                stopwatch.Stop();
                var successPercentage = tags.Count > 0 ? (double)successCount / tags.Count * 100 : 0;
                
                _logger.LogInformation("Parallel batch validation completed in {ElapsedMs}ms: {SuccessCount}/{TotalCount} tags successful ({SuccessPercentage:F1}%)", 
                    stopwatch.ElapsedMilliseconds, successCount, tags.Count, successPercentage);
                
                // Handle tag errors FIRST - these are configuration issues
                if (!skipErrorDetection && HasTagErrors())
                {
                    _logger.LogError("CONFIGURATION ERROR: Found {ErrorCount} tag definition errors - showing error dialog", 
                        _notFoundTags.Count + _illegalTags.Count + _unknownTags.Count);
                    ShowTagErrors();
                    await Task.Delay(500); // Give time for dialog to appear
                }
                
                // Require 100% success before allowing batch reads
                if (failedTags.Any())
                {
                    _logger.LogError("Parallel batch validation failed - {FailedCount} of {TotalCount} tags failed. Failed tags: {FailedTags}", 
                        failedTags.Count, tags.Count, string.Join(", ", failedTags));
                    
                    // Set flags to prevent reconnection attempts for configuration errors
                    lock (_errorStateLock)
                    {
                        _tagReadError = true; // Mark as error but don't trigger reconnection
                        _reconnectionInProgress = false; // Ensure no reconnection happens
                        _hasConfigurationErrors = true; // Prevent all reconnection attempts
                    }
                    
                    // Report disconnected status but don't trigger reconnection attempts
                    ReportConnectionStatus(false);
                    
                    _logger.LogError("STOPPING: Parallel batch validation failed due to configuration errors - no batch reads will start");
                    return false;
                }
                
                // Clear configuration error flag on success and mark initial validation as completed
                lock (_errorStateLock)
                {
                    _hasConfigurationErrors = false; // Allow reconnection attempts for runtime issues
                    _initialValidationCompleted = true; // Mark that we've done initial validation successfully
                }
                
                _logger.LogInformation("All {Count} tags validated in parallel batches with 100% success - proceeding to batch reads", successCount);
            }
            else
            {
                // RECONNECTION: Skip individual validation, just initialize tags for batch reading
                _logger.LogInformation("Reconnection detected - skipping individual validation and initializing {Count} tags for batch reading", tags.Count);
                var stopwatch = Stopwatch.StartNew();
                
                                 successfulTags = new List<NativeTag>();
                 
                 // For reconnections, just initialize tags without the read validation step
                 foreach (var tag in tags)
                 {
                     try
                     {
                         var initStatus = tag.Initialize();
                         if (initStatus == LibPlcTag.PLCTAG_STATUS_OK)
                         {
                             successfulTags.Add(tag);
                             successCount++;
                         }
                         else
                         {
                             _logger.LogWarning("Tag {Name} failed initialization during reconnection: {Status}", 
                                 tag.Name, LibPlcTag.DecodeError(initStatus));
                             tag.Dispose();
                         }
                     }
                     catch (Exception ex)
                     {
                         _logger.LogError(ex, "Exception initializing tag {Name} during reconnection", tag.Name);
                         try { tag.Dispose(); } catch { }
                     }
                 }
                
                stopwatch.Stop();
                _logger.LogInformation("Reconnection initialization completed in {ElapsedMs}ms: {SuccessCount}/{TotalCount} tags ready", 
                    stopwatch.ElapsedMilliseconds, successfulTags.Count, tags.Count);
            }
            
            // Add successful tags to our internal list
            _tags.AddRange(successfulTags);
            
            // Set initial State based on actual tag values after validation
            foreach (var tag in successfulTags)
            {
                var io = tagList.FirstOrDefault(t => t.Name == tag.Name);
                if (io != null)
                {
                    io.State = Convert.ToBoolean(tag.Value).ToString().ToUpper(); // Set to actual current state
                }
                else
                {
                    _logger.LogWarning("Could not find IO for tag {Name} when setting initial state", tag.Name);
                }
            }
            
            // Notify general state change
            StateChanged?.Invoke();
            
            // Setup event handlers for successfully initialized tags
            foreach (var tag in successfulTags)
            {
                tag.ValueChanged += (sender, e) =>
                {
                    if (sender is NativeTag nativeTag)
                    {
                        var io = tagList.FirstOrDefault(t => t.Name == nativeTag.Name);
                        if (io != null)
                        {
                            var oldState = io.State;
                            var newState = Convert.ToBoolean(nativeTag.Value).ToString().ToUpper();
                            
                            if (oldState != newState)
                            {
                                io.State = newState;
                                TagValueChanged?.Invoke(io);
                            }
                        }
                    }
                };
            }
            
            _logger.LogInformation("Tag initialization complete with {SuccessCount}/{TotalCount} tags ready", 
                successCount, tags.Count);
            
            // Start continuous reading if we have any successful tags
            if (successCount > 0)
            {
                _logger.LogInformation("Starting continuous reading for {Count} successful tags", successfulTags.Count);
                _ = Task.Run(async () => await StartContinuousReadingAsync(successfulTags));
            }
            else
            {
                _logger.LogWarning("No successful tags available for continuous reading");
            }
            
            // Report connection status based on initialization success
            ReportConnectionStatus(successCount > 0);
            
            return successCount > 0;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize tags");
            return false;
        }
        finally
        {
            // Clear reset flag only if it was set (for subsystem switches)
            if (_isResetting)
            {
                _isResetting = false;
                // Reset flag cleared - subsystem switch complete
            }
        }
    }





    public async Task StartContinuousReadingAsync(List<NativeTag>? tags = null)
    {
        tags ??= _tags;
        
        if (!tags.Any())
        {
            _logger.LogWarning("No tags for continuous reading");
            return;
        }
        
        _logger.LogInformation("Starting optimized continuous reading for {Count} tags", tags.Count);
        

        _readingCancellationToken?.Cancel();
        _readingCancellationToken = new CancellationTokenSource();
        
        // Create batches for continuous reading
        var batchSize = PlcConstants.OptimizedBatchSize; // 50 tags per batch
        var batches = new List<List<NativeTag>>();
        
        for (int i = 0; i < tags.Count; i += batchSize)
        {
            batches.Add(tags.Skip(i).Take(batchSize).ToList());
        }
        
        _logger.LogInformation("Created {BatchCount} batches of ~{BatchSize} tags each", batches.Count, batchSize);
        
        // Start continuous reading tasks for each batch
        var readingTasks = batches.Select((batch, index) => 
            ContinuouslyReadBatchOptimized(batch, index, _readingCancellationToken.Token)
        ).ToArray();
        
        // Start performance monitoring
        _ = Task.Run(async () => await MonitorPerformanceAsync(_readingCancellationToken.Token));
        
        // Don't await - let them run in background
        _ = Task.WhenAll(readingTasks).ContinueWith(t =>
        {
            if (t.IsFaulted)
            {
                _logger.LogError(t.Exception, "Continuous reading tasks failed");
            }
            else
            {
                _logger.LogInformation("Continuous reading tasks completed");
            }
        });
        
        _logger.LogInformation("All {BatchCount} continuous reading tasks have been started", batches.Count);
    }

    private async Task ContinuouslyReadBatchOptimized(List<NativeTag> batch, int batchIndex, CancellationToken cancellationToken)
    {
        var batchName = $"Batch{batchIndex}";
        
        var cycleCount = 0;
        var totalCycleTime = 0L;
        var stopwatch = new Stopwatch();
        
        // Stagger batch starts to avoid thundering herd
        await Task.Delay(batchIndex * 10, cancellationToken);
        
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                stopwatch.Restart();
                
                // Read all tags in the batch concurrently using optimized async
                var readTasks = batch.Select(async tag =>
                {
                    try
                    {
                        var status = await tag.ReadAsync(cancellationToken);
                        var success = status == LibPlcTag.PLCTAG_STATUS_OK;
                        
                        if (!success)
                        {
                            // Individual tag failures are handled at batch level - no need for individual warnings

                        }
                        
                        return (success: success, status: status);
                    }
                    catch (OperationCanceledException)
                    {
                        throw; // Let cancellation bubble up
                    }
                                    catch (Exception ex)
                {
                    return (success: false, status: -1);
                }
                });
                
                var results = await Task.WhenAll(readTasks);
                
                stopwatch.Stop();
                var cycleTimeMs = stopwatch.ElapsedMilliseconds;
                cycleCount++;
                totalCycleTime += cycleTimeMs;
                
                // Update global performance metrics
                lock (_perfLock)
                {
                    _totalReadCycles++;
                    _totalReadTimeMs += cycleTimeMs;
                }
                
                // Analyze results for communication issues
                var failedCount = results.Count(r => !r.success);
                var totalCount = results.Length;
                var timeoutCount = results.Count(r => r.status == LibPlcTag.PLCTAG_ERR_TIMEOUT);
                var busyCount = results.Count(r => r.status == LibPlcTag.PLCTAG_ERR_BUSY);
                var commErrorCount = results.Count(r => 
                    r.status == LibPlcTag.PLCTAG_ERR_TIMEOUT ||
                    r.status == LibPlcTag.PLCTAG_ERR_ABORT ||
                    r.status == LibPlcTag.PLCTAG_ERR_NO_DATA ||
                    r.status == LibPlcTag.PLCTAG_ERR_BAD_CONNECTION ||
                    r.status == LibPlcTag.PLCTAG_ERR_BUSY);
                

                
                // Consider it a connection issue if:
                // 1. ANY timeouts occur (immediate detection)
                // 2. Any other communication errors occur
                // 3. More than 1% of tags fail (very sensitive detection)
                var hasConnectionIssue = timeoutCount > 0 || commErrorCount > 0 || (failedCount > 0 && (double)failedCount / totalCount > 0.01);
                
                // Update global error tracking
                lock (_errorStateLock)
                {
                    if (hasConnectionIssue)
                    {
                        var errorMsg = commErrorCount > 0 
                            ? $"{commErrorCount} communication errors ({timeoutCount} timeouts, {busyCount} busy), {failedCount}/{totalCount} total failures"
                            : $"{failedCount}/{totalCount} tag failures";
                            
                        _logger.LogWarning("{BatchName} has communication issues: {ErrorMsg} in cycle {Cycle}", 
                            batchName, errorMsg, cycleCount);
                        
                        _consecutiveErrorCycles++;
                        
                        // Report connection failure immediately on any timeout errors or after 2 consecutive error cycles
                        if (commErrorCount > 0 || _consecutiveErrorCycles >= 2)
                        {
                            if (!_tagReadError && !_reconnectionInProgress && !_isResetting)
                            {
                                _tagReadError = true;
                                _logger.LogError("PLC communication lost - batch {BatchName}: {ErrorMsg} (consecutive errors: {ConsecutiveErrors})", 
                                    batchName, errorMsg, _consecutiveErrorCycles);
                                ReportConnectionStatus(false);
                                
                                // Show dialog with cooldown to prevent spam
                                ShowRuntimeCommunicationError();
                                
                                // Only start disconnection process if no configuration errors
                                if (!_hasConfigurationErrors)
                                {
                                    _ = Task.Run(async () => await CleanDisconnectionAsync());
                                }
                                else
                                {
                                    _logger.LogInformation("Skipping reconnection attempts due to configuration errors");
                                }
                            }
                            else if (_isResetting)
                            {
                            }
                        }
                    }
                    else
                    {
                        // This batch was successful - but only clear error if we haven't had recent errors
                        if (_tagReadError && _consecutiveErrorCycles == 0)
                        {
                            _logger.LogInformation("{BatchName} - PLC communication restored! ({TotalCount}/{TotalCount} tags successful)", 
                                batchName, totalCount, totalCount);
                            _tagReadError = false; // Reset error flag only if no recent errors
                            ReportConnectionStatus(true);
                        }
                        
                        // Decay error count for successful reads, but don't clear immediately
                        if (_consecutiveErrorCycles > 0)
                        {
                            _consecutiveErrorCycles = Math.Max(0, _consecutiveErrorCycles - 1);
                        }
                    }
                }
                

                
                // Adaptive delay based on cycle time
                var targetInterval = PlcConstants.OptimizedReadInterval; // 100ms default
                var delay = Math.Max(0, targetInterval - (int)cycleTimeMs);
                
                if (delay > 0)
                {
                    await Task.Delay(delay, cancellationToken);
                }
                
                // Invoke state changed event on every cycle for immediate UI updates
                StateChanged?.Invoke();
            }
            catch (OperationCanceledException)
            {
                _logger.LogInformation("{BatchName} continuous reading cancelled", batchName);
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "{BatchName} continuous reading error", batchName);
                
                // Don't process errors during subsystem reset
                if (!_isResetting)
                {
                    _tagReadError = true;
                    
                    // Immediately report connection failure
                    ReportConnectionStatus(false);
                    
                    // Show dialog (with cooldown)
                    ShowRuntimeCommunicationError();
                    
                    // Only start reconnection if no configuration errors
                    if (!_hasConfigurationErrors)
                    {
                        _ = Task.Run(async () => await CleanDisconnectionAsync());
                    }
                    else
                    {
                        _logger.LogInformation("Skipping reconnection attempts due to configuration errors");
                    }
                }
                else
                {
                }
                
                // Don't break - keep trying to reconnect
                // Add a longer delay before retrying after major errors
                try
                {
                    await Task.Delay(2000, cancellationToken); // 2 second delay before retry
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    private async Task MonitorPerformanceAsync(CancellationToken cancellationToken)
    {
        var logInterval = TimeSpan.FromMinutes(5); // Reduced frequency
        
        while (!cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(logInterval, cancellationToken);
            
            // Log basic performance stats occasionally
            lock (_perfLock)
            {
                var totalTags = _tags.Count;
                var avgMs = _totalReadCycles > 0 ? (double)_totalReadTimeMs / _totalReadCycles : 0;
                
                _logger.LogInformation("Performance: {TotalTags} tags, Avg: {AvgMs:F1}ms per batch", 
                    totalTags, avgMs);
            }
        }
    }

    private void HandleTagError(string tagName, int errorCode)
    {
        var errorMessage = LibPlcTag.DecodeError(errorCode);
        
        switch (errorCode)
        {
            case LibPlcTag.PLCTAG_ERR_NOT_FOUND:
                _notFoundTags.Add(tagName);
                break;
            case LibPlcTag.PLCTAG_ERR_NOT_ALLOWED:
                _illegalTags.Add(tagName);
                break;
            default:
                _unknownTags.Add($"{tagName}: {errorMessage}");
                break;
        }
    }

    private bool HasTagErrors()
    {
        return _notFoundTags.Count > 0 || _illegalTags.Count > 0 || _unknownTags.Count > 0;
    }

    private void ShowTagErrors()
    {
        _logger.LogError("ShowTagErrors called with: NotFound={NotFoundCount}, Illegal={IllegalCount}, Unknown={UnknownCount}", 
            _notFoundTags.Count, _illegalTags.Count, _unknownTags.Count);
        _logger.LogError("NotFound tags: {NotFoundTags}", string.Join(", ", _notFoundTags));
        _logger.LogError("Illegal tags: {IllegalTags}", string.Join(", ", _illegalTags));
        _logger.LogError("Unknown tags: {UnknownTags}", string.Join(", ", _unknownTags));
        
        _errorDialogService.ShowTagErrors(_notFoundTags, _illegalTags, _unknownTags);
    }

    private void ShowRuntimeCommunicationError()
    {
        // Don't show errors during subsystem reset/switching
        if (_isResetting)
        {
            return;
        }
        
        // Ensure dialog is shown only once per disconnection cycle
        lock (_errorStateLock)
        {
            if (_errorDialogShownThisDisconnection)
            {
                return;
            }

            // Don't show errors during reconnection/reset process
            if (_reconnectionInProgress)
            {
                return;
            }

            // Also respect the time-based cooldown as backup
            if (DateTime.Now - _lastErrorDialogTime < _errorDialogCooldown)
            {
                return;
            }

            _errorDialogShownThisDisconnection = true;
            _lastErrorDialogTime = DateTime.Now;
        }
        
        _logger.LogError("Runtime PLC communication failure detected - showing dialog (once per disconnection)");
        _errorDialogService.ShowPlcCommunicationError();
    }
    
    private void ReportConnectionStatus(bool isConnected)
    {
        if (_lastConnectionStatus != isConnected)
        {
            _lastConnectionStatus = isConnected;
            _logger.LogInformation("PLC connection status changed to: {Status}", isConnected ? "Connected" : "Disconnected");
            
            // Reset dialog flag when connection is restored
            if (isConnected)
            {
                lock (_errorStateLock)
                {
                    if (_errorDialogShownThisDisconnection)
                    {
                        _logger.LogDebug("Resetting error dialog flag after successful reconnection");
                        _errorDialogShownThisDisconnection = false;
                    }
                }
            }
            
            ConnectionStatusChanged?.Invoke(isConnected);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        
        _logger.LogInformation("NativeTagReaderService disposing...");
        
        // Cancel reading
        _readingCancellationToken?.Cancel();
        
        // Dispose all tags
        foreach (var tag in _tags)
        {
            try
            {
                tag.Dispose();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error disposing tag {Name}", tag.Name);
            }
        }
        
        _tags.Clear();
        
        // Shutdown the library
        LibPlcTag.plc_tag_shutdown();
        
        _readingCancellationToken?.Dispose();
        _performanceStopwatch?.Stop();
        
        lock (_perfLock)
        {
            if (_totalReadCycles > 0)
            {
                var avgReadTime = (double)_totalReadTimeMs / _totalReadCycles;
                _logger.LogInformation("Native P/Invoke final performance: {AvgMs:F1}ms average over {Cycles} total cycles", 
                    avgReadTime, _totalReadCycles);
            }
        }
        
        _disposed = true;
    }

    /// <summary>
    /// Completely reset the service for clean reconnection
    /// </summary>
    public async Task ResetForReconnectionAsync(bool isConfigurationChange = true)
    {
        _logger.LogInformation("Resetting TagReaderService for clean reconnection");
        
        // Set reset flag to block error dialogs during transition - but only for actual config changes
        _isResetting = isConfigurationChange;
        
        // First, disable error dialogs during cleanup
        lock (_errorStateLock)
        {
            _tagReadError = true; // Prevent new error dialogs
            _errorDialogShownThisDisconnection = true; // Block error dialogs during cleanup
        }
        
        // Cancel all reading operations
        _readingCancellationToken?.Cancel();
        
        // Wait longer for cancellation to propagate and tasks to complete
        await Task.Delay(500);
        
        // Dispose all tags
        foreach (var tag in _tags)
        {
            try
            {
                tag.Dispose();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error disposing tag {Name} during reset", tag.Name);
            }
        }
        
        _tags.Clear();
        
        // Clear tag error lists from previous subsystem
        _notFoundTags.Clear();
        _illegalTags.Clear();
        _unknownTags.Clear();
        
        // Wait another moment to ensure cleanup is complete
        await Task.Delay(300);
        
        // Reset all state - now safe to enable error dialogs again
        lock (_errorStateLock)
        {
            _tagReadError = false;
            _consecutiveErrorCycles = 0;
            _reconnectionInProgress = false;
            _errorDialogShownThisDisconnection = false; // Ready for new subsystem
            _hasConfigurationErrors = false; // Reset config error flag for new initialization
            
            // Only reset initial validation flag for actual configuration changes (subsystem switches)
            if (isConfigurationChange)
            {
                _initialValidationCompleted = false; // Force re-validation for new subsystem
                _logger.LogInformation("Configuration change detected - will perform individual validation again");
            }
            else
            {
                _logger.LogInformation("Runtime reconnection - will skip individual validation");
            }
        }
        
        _logger.LogInformation("TagReaderService reset completed");
    }

    /// <summary>
    /// Clean slate reconnection - dispose all tags and stop reading
    /// </summary>
    private async Task CleanDisconnectionAsync()
    {
        if (_reconnectionInProgress) return;
        
        _reconnectionInProgress = true;
        _logger.LogWarning("PLC disconnected - initiating clean disconnection process");
        
        // Cancel all reading operations
        _readingCancellationToken?.Cancel();
        
        // Dispose all tags
        foreach (var tag in _tags)
        {
            try
            {
                tag.Dispose();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error disposing tag {Name} during disconnection", tag.Name);
            }
        }
        
        _tags.Clear();
        _logger.LogInformation("All tags disposed after PLC disconnection");
        
        // Start reconnection attempts
        _ = Task.Run(async () => await AttemptReconnectionAsync());
    }

    /// <summary>
    /// Attempt to reconnect with fresh tags
    /// </summary>
    private async Task AttemptReconnectionAsync()
    {
        _logger.LogInformation("Starting PLC reconnection attempts");
        
        // Don't attempt reconnection if we have configuration errors
        if (_hasConfigurationErrors)
        {
            _logger.LogWarning("Aborting reconnection attempts due to configuration errors - fix tag definitions first");
            _reconnectionInProgress = false;
            return;
        }
        
        while (_reconnectionInProgress && !_disposed && !_hasConfigurationErrors)
        {
            try
            {
                await Task.Delay(5000); // Wait 5 seconds between attempts
                
                if (_disposed) break;
                
                _logger.LogInformation("Attempting PLC reconnection...");
                
                // Try to recreate tags from original list
                if (_originalTagList == null || !_originalTagList.Any())
                {
                    _logger.LogError("No original tag list available for reconnection");
                    break;
                }
                
                // Signal reconnection success - higher level service will handle tag reinitialization
                // Since _initialValidationCompleted is true, individual validation will be skipped
                _logger.LogInformation("Attempting reconnection - will let higher level service handle tag reinitialization (individual validation will be skipped)");
                _reconnectionInProgress = false;
                ReportConnectionStatus(true);
                
                // Trigger reinitialization through state change
                _logger.LogInformation("Triggering reinitialization after reconnection");
                StateChanged?.Invoke();
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Exception during reconnection attempt");
            }
        }
        
        _logger.LogInformation("PLC reconnection attempts stopped");
    }

    /// <summary>
    /// Check for persistent tag errors after new subsystem has had time to settle
    /// </summary>
    private async Task CheckErrorsAfterSettlingAsync()
    {
        try
        {
            _logger.LogInformation("Waiting for new subsystem to settle before checking for persistent tag errors...");
            
            // Wait for subsystem to settle
            await Task.Delay(3000);
            
            // If we're disposed or resetting again, don't show errors
            if (_disposed || _isResetting)
            {
                _logger.LogDebug("Service disposed or resetting - skipping error check");
                return;
            }
            
            // Clear old errors and test a few tags again
            var oldNotFoundCount = _notFoundTags.Count;
            var oldIllegalCount = _illegalTags.Count;
            var oldUnknownCount = _unknownTags.Count;
            
            _notFoundTags.Clear();
            _illegalTags.Clear();
            _unknownTags.Clear();
            
            _logger.LogInformation("Retesting tags to check for persistent errors (was {NotFound} not found, {Illegal} illegal, {Unknown} unknown)", 
                oldNotFoundCount, oldIllegalCount, oldUnknownCount);
            
            // Test a few tags to see if they still fail
            var tagsToTest = _tags.Take(Math.Min(10, _tags.Count)).ToList();
            var stillFailing = 0;
            
            foreach (var tag in tagsToTest)
            {
                try
                {
                    var status = await tag.ReadAsync();
                    if (status != LibPlcTag.PLCTAG_STATUS_OK)
                    {
                        HandleTagError(tag.Name, status);
                        stillFailing++;
                    }
                }
                catch (Exception ex)
                {
                    // Exception during tag testing after settling (no logging needed)
                    HandleTagError(tag.Name, -1);
                    stillFailing++;
                }
            }
            
            // Only show errors if tags are still failing consistently
            if (HasTagErrors() && stillFailing > 0)
            {
                _logger.LogWarning("Found {StillFailing} persistent tag errors after subsystem settled - showing error dialog", stillFailing);
                ShowTagErrors();
            }
            else
            {
                _logger.LogInformation("Tag errors were transitional - new subsystem is working correctly");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error checking for persistent tag errors");
        }
    }
} 