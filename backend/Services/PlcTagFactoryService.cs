using Microsoft.Extensions.Logging;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Services.PlcTags;
using IO_Checkout_Tool.Constants;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

public class PlcTagFactoryService : IPlcTagFactoryService
{
    private readonly IConfigurationService _configService;
    private readonly ILogger<PlcTagFactoryService> _logger;
    private readonly ILoggerFactory _loggerFactory;

    public PlcTagFactoryService(
        IConfigurationService configService, 
        ILogger<PlcTagFactoryService> logger,
        ILoggerFactory loggerFactory)
    {
        _configService = configService;
        _logger = logger;
        _loggerFactory = loggerFactory;
    }

    public List<NativeTag> CreateReadTags(List<Io> tags)
    {
        var plcTags = new List<NativeTag>();
        
        foreach (var tag in tags)
        {
            plcTags.Add(CreateReadTag(tag.Name!));
        }
        
        return plcTags;
    }

    public NativeTag CreateReadTag(string tagName)
    {
        var logger = _loggerFactory.CreateLogger<NativeTag>();
        return new NativeTag(
            tagName, 
            _configService.Ip, 
            _configService.Path, 
            timeout: PlcConstants.OptimizedTagTimeout,
            logger: logger);
    }

    public NativeTag CreateWriteTag(string tagName)
    {
        // Write tags need longer timeout since they're created on-demand (not in tight read loop)
        var logger = _loggerFactory.CreateLogger<NativeTag>();
        return new NativeTag(
            tagName,
            _configService.Ip,
            _configService.Path,
            timeout: 5000, // 5s timeout for write tags (vs 800ms for read tags)
            logger: logger);
    }

    /// <summary>
    /// Creates a DINT-sized tag for reading parent data structures.
    /// Used by the DINT group optimization to read 32 boolean points in a single CIP request.
    /// </summary>
    public NativeTag CreateDintTag(string tagName)
    {
        var logger = _loggerFactory.CreateLogger<NativeTag>();
        return new NativeTag(
            tagName,
            _configService.Ip,
            _configService.Path,
            timeout: PlcConstants.OptimizedTagTimeout,
            logger: logger,
            elemSize: 4,
            elemCount: 1);
    }
} 