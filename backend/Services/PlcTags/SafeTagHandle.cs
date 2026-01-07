using System;
using System.Runtime.InteropServices;
using IO_Checkout_Tool.Services.PlcTags.Native;
using Microsoft.Win32.SafeHandles;

namespace IO_Checkout_Tool.Services.PlcTags;

/// <summary>
/// SafeHandle implementation for PLC tag handles to ensure proper cleanup
/// </summary>
public sealed class SafeTagHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private SafeTagHandle() : base(true)
    {
    }

    public SafeTagHandle(int handle) : base(true)
    {
        SetHandle(new IntPtr(handle));
    }

    protected override bool ReleaseHandle()
    {
        if (!IsInvalid)
        {
            // Destroy the tag handle
            LibPlcTag.plc_tag_destroy(handle.ToInt32());
        }
        return true;
    }

    public new int DangerousGetHandle()
    {
        return handle.ToInt32();
    }

    public static SafeTagHandle Create(string attribStr, int timeout)
    {
        var handle = LibPlcTag.plc_tag_create(attribStr, timeout);
        return new SafeTagHandle(handle);
    }
} 