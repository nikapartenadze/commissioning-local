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

    public TagWriterService(IPlcTagFactoryService tagFactory, ILogger<TagWriterService> logger)
    {
        _tagFactory = tagFactory;
        _logger = logger;
    }

    public void InitializeOutputTag(Io tag)
    {
        _outputTag?.Dispose();
        _outputTag = _tagFactory.CreateWriteTag(tag.Name!);
        
        var status = _outputTag.Initialize();
        if (status != LibPlcTag.PLCTAG_STATUS_OK)
        {
            _logger.LogError("Failed to initialize output tag {Name}: {Error}", 
                tag.Name, LibPlcTag.DecodeError(status));
        }
    }

    public void ToggleBit()
    {
        if (_outputTag == null)
        {
            _logger.LogWarning("Output tag not initialized");
            return;
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

        try
        {
            var status = _outputTag.Write();
            if (status != LibPlcTag.PLCTAG_STATUS_OK)
            {
                _logger.LogWarning("Failed to write output tag: {Error}", LibPlcTag.DecodeError(status));
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception while toggling bit");
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