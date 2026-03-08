using Microsoft.Extensions.Logging;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.PlcTags;
using IO_Checkout_Tool.Services.PlcTags.Native;
using IO_Checkout_Tool.Constants;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

public class TagWriterService : ITagWriterService, IDisposable
{
    private readonly IPlcTagFactoryService _tagFactory;
    private readonly ILogger<TagWriterService> _logger;
    private NativeTag? _outputTag;
    private string? _outputTagName;

    public TagWriterService(IPlcTagFactoryService tagFactory, ILogger<TagWriterService> logger)
    {
        _tagFactory = tagFactory;
        _logger = logger;
    }

    public bool InitializeOutputTag(Io tag)
    {
        // Reuse existing tag if it's for the same output (avoids re-init on every fire)
        if (_outputTag != null && _outputTagName == tag.Name)
        {
            _logger.LogDebug("Reusing existing write tag for {Name}", tag.Name);
            return true;
        }

        _outputTag?.Dispose();
        _outputTag = _tagFactory.CreateWriteTag(tag.Name!);
        _outputTagName = tag.Name;

        // Acquire write gate to pause readers while we initialize
        var acquired = NativeTagReaderService.AcquireWriteGateAsync(3000).GetAwaiter().GetResult();
        if (!acquired)
        {
            _logger.LogWarning("Could not acquire write gate for tag init, attempting anyway");
        }

        try
        {
            var status = _outputTag.Initialize();
            if (status != LibPlcTag.PLCTAG_STATUS_OK)
            {
                _logger.LogError("Failed to initialize output tag {Name}: {Error}",
                    tag.Name, LibPlcTag.DecodeError(status));
                _outputTag = null;
                _outputTagName = null;
                return false;
            }
            return true;
        }
        finally
        {
            if (acquired) NativeTagReaderService.ReleaseWriteGate();
        }
    }

    public (bool success, string? error) ToggleBit()
    {
        if (_outputTag == null)
        {
            _logger.LogWarning("Output tag not initialized");
            return (false, "Output tag not initialized");
        }

        // Acquire write gate to pause readers during read-toggle-write
        var acquired = NativeTagReaderService.AcquireWriteGateAsync(3000).GetAwaiter().GetResult();
        if (!acquired)
        {
            _logger.LogWarning("Could not acquire write gate for toggle, attempting anyway");
        }

        try
        {
            // Read fresh value from PLC before toggling
            var readStatus = _outputTag.Read();
            if (readStatus != LibPlcTag.PLCTAG_STATUS_OK)
            {
                _logger.LogWarning("Failed to read current output value before toggle: {Error}", LibPlcTag.DecodeError(readStatus));
                // Continue with cached value - still attempt the toggle
            }

            // Toggle the value
            if (_outputTag.Value == 0)
            {
                _outputTag.Value = 1;
            }
            else
            {
                _outputTag.Value = 0;
            }

            var status = _outputTag.Write();
            if (status != LibPlcTag.PLCTAG_STATUS_OK)
            {
                var error = LibPlcTag.DecodeError(status);
                _logger.LogWarning("Failed to write output tag: {Error}", error);
                return (false, $"PLC write failed: {error}");
            }
            return (true, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception while toggling bit");
            return (false, ex.Message);
        }
        finally
        {
            if (acquired) NativeTagReaderService.ReleaseWriteGate();
        }
    }

    public (bool success, string? error) SetBit(int value)
    {
        if (_outputTag == null)
        {
            _logger.LogWarning("Output tag not initialized");
            return (false, "Output tag not initialized");
        }

        var acquired = NativeTagReaderService.AcquireWriteGateAsync(3000).GetAwaiter().GetResult();
        if (!acquired)
        {
            _logger.LogWarning("Could not acquire write gate for SetBit, attempting anyway");
        }

        try
        {
            _outputTag.Value = (sbyte)value;
            var status = _outputTag.Write();
            if (status != LibPlcTag.PLCTAG_STATUS_OK)
            {
                var error = LibPlcTag.DecodeError(status);
                _logger.LogWarning("Failed to set output tag to {Value}: {Error}", value, error);
                return (false, $"PLC write failed: {error}");
            }
            return (true, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception while setting bit to {Value}", value);
            return (false, ex.Message);
        }
        finally
        {
            if (acquired) NativeTagReaderService.ReleaseWriteGate();
        }
    }

    public void EnableOutput()
    {
        if (_outputTag != null)
        {
            _outputTag.Value = TestConstants.PlcValues.OUTPUT_ENABLED;

            var status = _outputTag.Write();
            if (status != LibPlcTag.PLCTAG_STATUS_OK)
            {
                _logger.LogWarning("Failed to enable output: {Error}", LibPlcTag.DecodeError(status));
            }
        }
    }

    public void Dispose()
    {
        _outputTag?.Dispose();
    }
}
