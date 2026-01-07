using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Diagnostics;
using IO_Checkout_Tool.Services.PlcTags.Native;

namespace IO_Checkout_Tool.Services.PlcTags;

/// <summary>
/// Performance-critical helper methods with aggressive inlining
/// </summary>
public static class PerformanceHelpers
{
    // Windows-specific high-resolution timer for accurate measurements
    [DllImport("kernel32.dll")]
    private static extern bool QueryPerformanceCounter(out long lpPerformanceCount);
    
    [DllImport("kernel32.dll")]
    private static extern bool QueryPerformanceFrequency(out long lpFrequency);
    
    private static readonly long PerformanceFrequency;
    
    static PerformanceHelpers()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            QueryPerformanceFrequency(out PerformanceFrequency);
        }
        else
        {
            PerformanceFrequency = Stopwatch.Frequency;
        }
    }
    
    /// <summary>
    /// Get high-resolution timestamp
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static long GetTimestamp()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            QueryPerformanceCounter(out long timestamp);
            return timestamp;
        }
        return Stopwatch.GetTimestamp();
    }
    
    /// <summary>
    /// Convert timestamp to microseconds
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static double TimestampToMicroseconds(long timestamp)
    {
        return (double)timestamp * 1_000_000 / PerformanceFrequency;
    }
    
    /// <summary>
    /// Fast status check with minimal overhead
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsStatusOk(int status)
    {
        return status == LibPlcTag.PLCTAG_STATUS_OK;
    }
    
    /// <summary>
    /// Fast pending check
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsStatusPending(int status)
    {
        return status == LibPlcTag.PLCTAG_STATUS_PENDING;
    }
    
    /// <summary>
    /// Fast error check
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsError(int status)
    {
        return status < 0;
    }
    
    /// <summary>
    /// Optimized spin-wait for tag completion
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveOptimization)]
    public static int SpinWaitForCompletion(int tagHandle, int maxSpins = 100)
    {
        var spinner = new SpinWait();
        int status;
        
        for (int i = 0; i < maxSpins; i++)
        {
            status = LibPlcTag.plc_tag_status(tagHandle);
            if (!IsStatusPending(status))
                return status;
                
            spinner.SpinOnce();
        }
        
        // Final check after spinning
        return LibPlcTag.plc_tag_status(tagHandle);
    }
    
    /// <summary>
    /// Set thread affinity for reduced context switching
    /// </summary>
    public static void SetThreadAffinity(int processorIndex)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var thread = Thread.CurrentThread;
            var affinity = 1 << processorIndex;
            SetThreadAffinityMask(GetCurrentThread(), new IntPtr(affinity));
        }
    }
    
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentThread();
    
    [DllImport("kernel32.dll")]
    private static extern IntPtr SetThreadAffinityMask(IntPtr hThread, IntPtr dwThreadAffinityMask);
}

/// <summary>
/// Zero-allocation string builder for tag paths
/// </summary>
public ref struct TagPathBuilder
{
    private Span<char> _buffer;
    private int _position;
    
    public TagPathBuilder(Span<char> buffer)
    {
        _buffer = buffer;
        _position = 0;
    }
    
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Append(ReadOnlySpan<char> value)
    {
        value.CopyTo(_buffer.Slice(_position));
        _position += value.Length;
    }
    
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Append(char value)
    {
        _buffer[_position++] = value;
    }
    
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void AppendNumber(int value)
    {
        value.TryFormat(_buffer.Slice(_position), out int written);
        _position += written;
    }
    
    public ReadOnlySpan<char> AsSpan() => _buffer.Slice(0, _position);
    
    public override string ToString() => new string(AsSpan());
} 