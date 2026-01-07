using System;
using System.Buffers;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;
using IO_Checkout_Tool.Services.PlcTags.Native;

namespace IO_Checkout_Tool.Services.PlcTags;

/// <summary>
/// Optimized bulk operations for multiple tags using pinned memory and SIMD
/// </summary>
public static class BulkOperations
{
    // Struct for batch operations (blittable for zero-copy marshaling)
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct TagOperation
    {
        public int Handle;
        public int Operation; // 0=Read, 1=Write
        public int Status;
        public int Reserved; // Padding for alignment
    }
    
    // P/Invoke for hypothetical batch operations (add to LibPlcTag.Native.cs if native library supports it)
    [DllImport("plctag", CallingConvention = CallingConvention.Cdecl)]
    private static extern unsafe int plc_tag_batch_ops(TagOperation* operations, int count, int timeout);
    
    /// <summary>
    /// Perform bulk read operations with pinned memory
    /// </summary>
    public static unsafe int[] BulkRead(int[] handles, int timeout = 0)
    {
        var count = handles.Length;
        var operations = ArrayPool<TagOperation>.Shared.Rent(count);
        var results = new int[count];
        
        try
        {
            // Initialize operations
            for (int i = 0; i < count; i++)
            {
                operations[i] = new TagOperation
                {
                    Handle = handles[i],
                    Operation = 0, // Read
                    Status = 0
                };
            }
            
            // Pin memory and execute batch operation
            fixed (TagOperation* opsPtr = operations)
            {
                var status = plc_tag_batch_ops(opsPtr, count, timeout);
                
                // Extract results
                for (int i = 0; i < count; i++)
                {
                    results[i] = operations[i].Status;
                }
            }
        }
        finally
        {
            ArrayPool<TagOperation>.Shared.Return(operations, clearArray: true);
        }
        
        return results;
    }
    
    /// <summary>
    /// SIMD-optimized value comparison for change detection
    /// </summary>
    public static unsafe bool[] CompareValuesSimd(sbyte[] oldValues, sbyte[] newValues)
    {
        if (oldValues.Length != newValues.Length)
            throw new ArgumentException("Arrays must have same length");
            
        var length = oldValues.Length;
        var results = new bool[length];
        
        // Use SIMD for bulk comparison if available
        if (Avx2.IsSupported && length >= Vector256<sbyte>.Count)
        {
            fixed (sbyte* oldPtr = oldValues)
            fixed (sbyte* newPtr = newValues)
            fixed (bool* resultPtr = results)
            {
                var i = 0;
                var vectorSize = Vector256<sbyte>.Count;
                
                // Process vectors
                for (; i <= length - vectorSize; i += vectorSize)
                {
                    var oldVec = Avx2.LoadVector256(oldPtr + i);
                    var newVec = Avx2.LoadVector256(newPtr + i);
                    var cmpResult = Avx2.CompareEqual(oldVec, newVec);
                    
                    // Convert comparison result to bool array
                    var mask = (uint)Avx2.MoveMask(cmpResult);
                    for (int j = 0; j < vectorSize; j++)
                    {
                        resultPtr[i + j] = ((mask >> j) & 1) == 0; // Inverted because we want differences
                    }
                }
                
                // Process remaining elements
                for (; i < length; i++)
                {
                    resultPtr[i] = oldPtr[i] != newPtr[i];
                }
            }
        }
        else
        {
            // Fallback to scalar comparison
            for (int i = 0; i < length; i++)
            {
                results[i] = oldValues[i] != newValues[i];
            }
        }
        
        return results;
    }
}

/// <summary>
/// Memory pool for tag values to reduce allocations
/// </summary>
public class TagValueMemoryPool
{
    private readonly ArrayPool<sbyte> _pool = ArrayPool<sbyte>.Create();
    
    public sbyte[] Rent(int minimumLength)
    {
        return _pool.Rent(minimumLength);
    }
    
    public void Return(sbyte[] array, bool clearArray = false)
    {
        _pool.Return(array, clearArray);
    }
} 