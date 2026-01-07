using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using IO_Checkout_Tool.Services.PlcTags.Native;

namespace IO_Checkout_Tool.Services.PlcTags;

/// <summary>
/// High-performance callback implementations using UnmanagedCallersOnly
/// </summary>
public static class NativeCallbacks
{
    // Store managed callbacks to prevent GC
    private static readonly ConcurrentDictionary<int, Action<int, int, int>> ManagedCallbacks = new();
    
    // Get function pointer for the static callback
    public static IntPtr GetCallbackPointer()
    {
        unsafe
        {
            return (IntPtr)(delegate* unmanaged[Cdecl]<int, int, int, void>)&StaticTagCallback;
        }
    }
    
    // Register a managed callback for a tag
    public static void RegisterCallback(int tagId, Action<int, int, int> callback)
    {
        ManagedCallbacks[tagId] = callback;
    }
    
    // Unregister a callback
    public static void UnregisterCallback(int tagId)
    {
        ManagedCallbacks.TryRemove(tagId, out _);
    }
    
    // High-performance static callback that can be called from unmanaged code
    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    public static void StaticTagCallback(int tagId, int eventType, int status)
    {
        // Fast path - check if we have a callback registered
        if (ManagedCallbacks.TryGetValue(tagId, out var callback))
        {
            try
            {
                callback(tagId, eventType, status);
            }
            catch
            {
                // Silently catch exceptions to prevent crashes
                // Log if needed, but don't let exceptions propagate to native code
            }
        }
    }
}

/// <summary>
/// Alternative callback approach using function pointers (requires unsafe)
/// </summary>
public unsafe class FastCallbackManager
{
    private readonly delegate* unmanaged[Cdecl]<int, int, int, void> _callbackPtr;
    
    public FastCallbackManager()
    {
        _callbackPtr = &NativeCallbacks.StaticTagCallback;
    }
    
    public IntPtr CallbackPointer => (IntPtr)_callbackPtr;
} 