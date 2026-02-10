using System;
using System.Runtime.InteropServices;
using System.Text;

namespace IO_Checkout_Tool.Services.PlcTags.Native;

/// <summary>
/// P/Invoke declarations for native libplctag C library
/// </summary>
public static class LibPlcTag
{
    private const string DllName = "plctag";
    
    // Status codes
    public const int PLCTAG_STATUS_PENDING = 1;
    public const int PLCTAG_STATUS_OK = 0;
    public const int PLCTAG_ERR_ABORT = -1;
    public const int PLCTAG_ERR_BAD_CONFIG = -2;
    public const int PLCTAG_ERR_BAD_CONNECTION = -3;
    public const int PLCTAG_ERR_BAD_DATA = -4;
    public const int PLCTAG_ERR_BAD_DEVICE = -5;
    public const int PLCTAG_ERR_BAD_GATEWAY = -6;
    public const int PLCTAG_ERR_BAD_PARAM = -7;
    public const int PLCTAG_ERR_BAD_REPLY = -8;
    public const int PLCTAG_ERR_BAD_STATUS = -9;
    public const int PLCTAG_ERR_CLOSE = -10;
    public const int PLCTAG_ERR_CREATE = -11;
    public const int PLCTAG_ERR_DUPLICATE = -12;
    public const int PLCTAG_ERR_ENCODE = -13;
    public const int PLCTAG_ERR_MUTEX_DESTROY = -14;
    public const int PLCTAG_ERR_MUTEX_INIT = -15;
    public const int PLCTAG_ERR_MUTEX_LOCK = -16;
    public const int PLCTAG_ERR_MUTEX_UNLOCK = -17;
    public const int PLCTAG_ERR_NOT_ALLOWED = -18;
    public const int PLCTAG_ERR_NOT_FOUND = -19;
    public const int PLCTAG_ERR_NOT_IMPLEMENTED = -20;
    public const int PLCTAG_ERR_NO_DATA = -21;
    public const int PLCTAG_ERR_NO_MATCH = -22;
    public const int PLCTAG_ERR_NO_MEM = -23;
    public const int PLCTAG_ERR_NO_RESOURCES = -24;
    public const int PLCTAG_ERR_NULL_PTR = -25;
    public const int PLCTAG_ERR_OPEN = -26;
    public const int PLCTAG_ERR_OUT_OF_BOUNDS = -27;
    public const int PLCTAG_ERR_READ = -28;
    public const int PLCTAG_ERR_REMOTE_ERR = -29;
    public const int PLCTAG_ERR_THREAD_CREATE = -30;
    public const int PLCTAG_ERR_THREAD_JOIN = -31;
    public const int PLCTAG_ERR_TIMEOUT = -32;
    public const int PLCTAG_ERR_TOO_LARGE = -33;
    public const int PLCTAG_ERR_TOO_SMALL = -34;
    public const int PLCTAG_ERR_UNSUPPORTED = -35;
    public const int PLCTAG_ERR_WINSOCK = -36;
    public const int PLCTAG_ERR_WRITE = -37;
    public const int PLCTAG_ERR_PARTIAL = -38;
    public const int PLCTAG_ERR_BUSY = -39;
    
    // Event types
    public const int PLCTAG_EVENT_CREATED = 7;
    public const int PLCTAG_EVENT_READ_STARTED = 1;
    public const int PLCTAG_EVENT_READ_COMPLETED = 2;
    public const int PLCTAG_EVENT_WRITE_STARTED = 3;
    public const int PLCTAG_EVENT_WRITE_COMPLETED = 4;
    public const int PLCTAG_EVENT_ABORTED = 5;
    public const int PLCTAG_EVENT_DESTROYED = 6;
    
    // Debug levels
    public const int PLCTAG_DEBUG_NONE = 0;
    public const int PLCTAG_DEBUG_ERROR = 1;
    public const int PLCTAG_DEBUG_WARN = 2;
    public const int PLCTAG_DEBUG_INFO = 3;
    public const int PLCTAG_DEBUG_DETAIL = 4;
    public const int PLCTAG_DEBUG_SPEW = 5;

    // Tag lifecycle functions
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_create([MarshalAs(UnmanagedType.LPStr)] string attrib_str, int timeout);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_create_ex(
        [MarshalAs(UnmanagedType.LPStr)] string attrib_str, 
        TagCallbackDelegate callback,
        IntPtr userdata,
        int timeout);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_destroy(int tag);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void plc_tag_shutdown();

    // Read/Write functions
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_read(int tag, int timeout);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_write(int tag, int timeout);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition] // Optimization for polling status
    public static extern int plc_tag_status(int tag);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_abort(int tag);

    // Data access functions
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_get_size(int tag);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_set_size(int tag, int new_size);
    
    // 8-bit accessors (for SINT) - HIGH FREQUENCY CALLS
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition] // Optimization for high-frequency calls
    public static extern byte plc_tag_get_uint8(int tag, int offset);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition] // Optimization for high-frequency calls
    public static extern int plc_tag_set_uint8(int tag, int offset, byte val);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition] // Optimization for high-frequency calls
    public static extern sbyte plc_tag_get_int8(int tag, int offset);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition] // Optimization for high-frequency calls
    public static extern int plc_tag_set_int8(int tag, int offset, sbyte val);
    
    // 16-bit accessors (for INT)
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition]
    public static extern short plc_tag_get_int16(int tag, int offset);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition]
    public static extern int plc_tag_set_int16(int tag, int offset, short val);

    // 32-bit accessors (for DINT) - used for DINT group reading optimization
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition]
    public static extern int plc_tag_get_int32(int tag, int offset);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition]
    public static extern int plc_tag_set_int32(int tag, int offset, int val);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition]
    public static extern uint plc_tag_get_uint32(int tag, int offset);

    // Bit accessors
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition] // Optimization for high-frequency calls
    public static extern int plc_tag_get_bit(int tag, int offset_bit);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    [SuppressGCTransition] // Optimization for high-frequency calls
    public static extern int plc_tag_set_bit(int tag, int offset_bit, int val);

    // Lock/Unlock for thread safety
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_lock(int tag);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_unlock(int tag);

    // Callback registration
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_register_callback(int tag, TagCallbackDelegate callback);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_register_callback_ex(int tag, TagCallbackDelegateEx callback, IntPtr userdata);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_unregister_callback(int tag);

    // Error decoding
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr plc_tag_decode_error(int err);
    
    // Helper method to decode error string
    public static string DecodeError(int err)
    {
        var ptr = plc_tag_decode_error(err);
        return Marshal.PtrToStringAnsi(ptr) ?? "Unknown error";
    }

    // Debug level
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void plc_tag_set_debug_level(int debug_level);
    
    // Version checking
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_check_lib_version(int req_major, int req_minor, int req_patch);
    
    // Attribute functions
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_get_int_attribute(int tag, [MarshalAs(UnmanagedType.LPStr)] string attrib_name, int default_value);
    
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int plc_tag_set_int_attribute(int tag, [MarshalAs(UnmanagedType.LPStr)] string attrib_name, int new_value);

    // Callback delegates
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    public delegate void TagCallbackDelegate(int tag_id, int @event, int status);
    
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    public delegate void TagCallbackDelegateEx(int tag_id, int @event, int status, IntPtr userdata);
    
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    public delegate void LogCallbackDelegate(int tag_id, int debug_level, [MarshalAs(UnmanagedType.LPStr)] string message);
} 