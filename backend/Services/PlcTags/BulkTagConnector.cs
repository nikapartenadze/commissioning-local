using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IO_Checkout_Tool.Services.PlcTags.Native;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services.PlcTags;

/// <summary>
/// Optimized bulk tag connector for connecting 1000+ tags efficiently
/// </summary>
public class BulkTagConnector
{
    private readonly ILogger<BulkTagConnector> _logger;
    
    public BulkTagConnector(ILogger<BulkTagConnector> logger)
    {
        _logger = logger;
    }
    
    /// <summary>
    /// Connect all tags at once with parallel batching and progress reporting
    /// </summary>
    public async Task<BulkConnectionResult> ConnectAllTagsAsync(
        List<NativeTag> tags, 
        int maxConcurrentConnections = 50,
        IProgress<int>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var result = new BulkConnectionResult
        {
            TotalTags = tags.Count,
            StartTime = DateTime.UtcNow
        };
        
        var successfulTags = new ConcurrentBag<NativeTag>();
        var failedTags = new ConcurrentBag<(string tagName, string error)>();
        var completedCount = 0;
        
        _logger.LogInformation("Starting bulk connection of {TagCount} tags with max {MaxConcurrent} concurrent connections", 
            tags.Count, maxConcurrentConnections);
        
        var stopwatch = Stopwatch.StartNew();
        
        // Use Parallel.ForEachAsync for controlled parallelism
        var parallelOptions = new ParallelOptions
        {
            MaxDegreeOfParallelism = maxConcurrentConnections,
            CancellationToken = cancellationToken
        };
        
        await Parallel.ForEachAsync(tags, parallelOptions, async (tag, ct) =>
        {
            try
            {
                var tagStopwatch = Stopwatch.StartNew();
                var status = await Task.Run(() => tag.Initialize(), ct);
                
                if (status == LibPlcTag.PLCTAG_STATUS_OK)
                {
                    successfulTags.Add(tag);
                    _logger.LogTrace("Tag {Name} connected in {Ms}ms", tag.Name, tagStopwatch.ElapsedMilliseconds);
                }
                else
                {
                    var error = LibPlcTag.DecodeError(status);
                    failedTags.Add((tag.Name, error));
                    _logger.LogWarning("Failed to connect tag {Name}: {Error}", tag.Name, error);
                }
            }
            catch (Exception ex)
            {
                failedTags.Add((tag.Name, ex.Message));
                _logger.LogError(ex, "Exception connecting tag {Name}", tag.Name);
            }
            finally
            {
                var count = Interlocked.Increment(ref completedCount);
                progress?.Report((count * 100) / tags.Count);
                
                // Log progress every 100 tags
                if (count % 100 == 0)
                {
                    _logger.LogInformation("Connection progress: {Count}/{Total} tags ({Percent}%)", 
                        count, tags.Count, (count * 100) / tags.Count);
                }
            }
        });
        
        stopwatch.Stop();
        
        result.EndTime = DateTime.UtcNow;
        result.SuccessfulTags = successfulTags.ToList();
        result.FailedTags = failedTags.ToList();
        result.TotalTimeMs = stopwatch.ElapsedMilliseconds;
        result.AverageTimePerTagMs = result.TotalTimeMs / (double)tags.Count;
        
        _logger.LogInformation(
            "Bulk connection completed in {TotalMs}ms. Success: {SuccessCount}/{TotalCount} ({SuccessRate}%). " +
            "Average: {AvgMs}ms per tag", 
            result.TotalTimeMs, 
            result.SuccessfulTags.Count, 
            result.TotalTags,
            result.SuccessRate,
            result.AverageTimePerTagMs);
        
        return result;
    }
    
    /// <summary>
    /// Connect tags with adaptive batching based on connection success rate
    /// </summary>
    public async Task<BulkConnectionResult> ConnectWithAdaptiveBatchingAsync(
        List<NativeTag> tags,
        CancellationToken cancellationToken = default)
    {
        var batchSize = 100; // Start with 100 concurrent connections
        var minBatchSize = 10;
        var maxBatchSize = 200;
        var successRateThreshold = 0.95; // Adjust batch size if success rate drops below 95%
        
        _logger.LogInformation("Starting adaptive bulk connection with initial batch size {BatchSize}", batchSize);
        
        var result = new BulkConnectionResult
        {
            TotalTags = tags.Count,
            StartTime = DateTime.UtcNow
        };
        
        var allSuccessful = new List<NativeTag>();
        var allFailed = new List<(string tagName, string error)>();
        var progress = new Progress<int>(percent => 
            _logger.LogDebug("Overall progress: {Percent}%", percent));
        
        for (int i = 0; i < tags.Count; i += batchSize)
        {
            var batch = tags.Skip(i).Take(batchSize).ToList();
            var batchResult = await ConnectAllTagsAsync(batch, batchSize, null, cancellationToken);
            
            allSuccessful.AddRange(batchResult.SuccessfulTags);
            allFailed.AddRange(batchResult.FailedTags);
            
            // Adapt batch size based on success rate
            if (batchResult.SuccessRate < successRateThreshold && batchSize > minBatchSize)
            {
                batchSize = Math.Max(minBatchSize, batchSize / 2);
                _logger.LogWarning("Reducing batch size to {BatchSize} due to low success rate {Rate}%", 
                    batchSize, batchResult.SuccessRate);
            }
            else if (batchResult.SuccessRate > 0.98 && batchSize < maxBatchSize)
            {
                batchSize = Math.Min(maxBatchSize, batchSize * 2);
                _logger.LogInformation("Increasing batch size to {BatchSize} due to high success rate {Rate}%", 
                    batchSize, batchResult.SuccessRate);
            }
            
            // Report overall progress
            var overallProgress = ((i + batch.Count) * 100) / tags.Count;
            ((IProgress<int>)progress).Report(overallProgress);
            
            // Small delay between batches
            if (i + batchSize < tags.Count)
            {
                await Task.Delay(50, cancellationToken);
            }
        }
        
        result.EndTime = DateTime.UtcNow;
        result.SuccessfulTags = allSuccessful;
        result.FailedTags = allFailed;
        result.TotalTimeMs = (long)(result.EndTime - result.StartTime).TotalMilliseconds;
        result.AverageTimePerTagMs = result.TotalTimeMs / (double)tags.Count;
        
        return result;
    }
}

public class BulkConnectionResult
{
    public int TotalTags { get; set; }
    public List<NativeTag> SuccessfulTags { get; set; } = new();
    public List<(string tagName, string error)> FailedTags { get; set; } = new();
    public DateTime StartTime { get; set; }
    public DateTime EndTime { get; set; }
    public long TotalTimeMs { get; set; }
    public double AverageTimePerTagMs { get; set; }
    public double SuccessRate => (SuccessfulTags.Count * 100.0) / TotalTags;
} 