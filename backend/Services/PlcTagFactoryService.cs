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
        // For native implementation, read and write tags are the same
        return CreateReadTag(tagName);
    }
} 