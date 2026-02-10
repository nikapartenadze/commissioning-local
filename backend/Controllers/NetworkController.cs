using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Models;

namespace IO_Checkout_Tool.Controllers;

[ApiController]
[Route("api/network")]
public class NetworkController : ControllerBase
{
    private readonly IPlcCommunicationService _plcCommunication;
    private readonly ICloudSyncService _cloudSyncService;
    private readonly IConfigurationService _configuration;
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly ILogger<NetworkController> _logger;

    public NetworkController(
        IPlcCommunicationService plcCommunication,
        ICloudSyncService cloudSyncService,
        IConfigurationService configuration,
        IDbContextFactory<TagsContext> contextFactory,
        ILogger<NetworkController> logger)
    {
        _plcCommunication = plcCommunication;
        _cloudSyncService = cloudSyncService;
        _configuration = configuration;
        _contextFactory = contextFactory;
        _logger = logger;
    }

    /// <summary>
    /// Get the network chain status for diagnostics breadcrumbs.
    /// Shows status of: Cloud -> Backend -> PLC -> Module -> IO Point
    /// When tagName is omitted, returns aggregate module health.
    /// </summary>
    [HttpGet("chain-status")]
    public async Task<ActionResult<object>> GetChainStatus([FromQuery] string? tagName)
    {
        try
        {
            var moduleName = "Unknown";
            var ioPointName = "Unknown";
            var tagConnected = false;
            string? tagStatusCode = null;
            string? tagMessage = null;
            string? deviceType = null;
            string? ipAddress = null;
            string? parentDevice = null;
            int totalTags = 0;
            int respondingTags = 0;
            int errorCount = 0;

            if (!string.IsNullOrEmpty(tagName))
            {
                // Specific tag mode
                var colonIndex = tagName.IndexOf(':');
                if (colonIndex > 0)
                {
                    moduleName = tagName.Substring(0, colonIndex);
                    ioPointName = tagName.Substring(colonIndex + 1);
                }
                else
                {
                    moduleName = tagName;
                    ioPointName = tagName;
                }

                var tagInfo = GetTagStatus(tagName);
                tagConnected = tagInfo.connected;
                tagStatusCode = tagInfo.statusCode;
                tagMessage = tagInfo.message;

                // Enrich with database device info
                var deviceInfo = await GetDeviceInfoAsync(moduleName);
                if (deviceInfo != null)
                {
                    deviceType = deviceInfo.DeviceType;
                    ipAddress = deviceInfo.IpAddress;
                    if (deviceInfo.ParentDeviceId.HasValue)
                    {
                        parentDevice = await GetDeviceNameByIdAsync(deviceInfo.ParentDeviceId.Value);
                    }
                }

                // Module-level stats
                var moduleStats = GetModuleStats(moduleName);
                totalTags = moduleStats.total;
                respondingTags = moduleStats.responding;
                errorCount = moduleStats.errors;
            }
            else
            {
                // Aggregate mode - show overall module health
                moduleName = "All Modules";
                ioPointName = "All Points";
                tagConnected = _plcCommunication.IsPlcConnected;

                var aggregateStats = GetAggregateModuleStats();
                totalTags = aggregateStats.totalTags;
                respondingTags = aggregateStats.respondingTags;
                errorCount = aggregateStats.errorTags;
            }

            var moduleConnected = _plcCommunication.IsPlcConnected;

            return Ok(new
            {
                cloud = new
                {
                    connected = _cloudSyncService.IsConnected,
                    message = _cloudSyncService.IsConnected
                        ? "Real-time sync active"
                        : "Cloud sync disconnected - working offline"
                },
                backend = new
                {
                    connected = true,
                    message = "Local server running"
                },
                plc = new
                {
                    connected = _plcCommunication.IsPlcConnected,
                    ip = _configuration.Ip,
                    path = _configuration.Path,
                    message = _plcCommunication.IsPlcConnected
                        ? $"Connected to {_configuration.Ip} (Path: {_configuration.Path})"
                        : $"Cannot reach PLC at {_configuration.Ip}:{44818}"
                },
                module = new
                {
                    name = moduleName,
                    deviceType,
                    ipAddress,
                    connected = moduleConnected,
                    totalTags,
                    respondingTags,
                    errorCount,
                    parentDevice,
                    message = GetModuleStatusMessage(moduleName, moduleConnected, errorCount)
                },
                ioPoint = new
                {
                    name = ioPointName,
                    connected = tagConnected,
                    statusCode = tagStatusCode,
                    message = tagMessage ?? (tagConnected ? "Reading OK" : "Read failed or not initialized")
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting network chain status");
            return StatusCode(500, "Failed to get network status");
        }
    }

    /// <summary>
    /// Get detailed status for all modules, enriched with database device info
    /// </summary>
    [HttpGet("modules")]
    public async Task<ActionResult<object>> GetModulesStatus()
    {
        try
        {
            var tagList = _plcCommunication.TagList;
            if (tagList == null || !tagList.Any())
            {
                return Ok(new { modules = Array.Empty<object>(), plcConnected = false, totalModules = 0 });
            }

            // Load device info from DB
            using var context = await _contextFactory.CreateDbContextAsync();
            var devices = await context.NetworkDevices
                .ToDictionaryAsync(d => d.DeviceName, StringComparer.OrdinalIgnoreCase);

            var moduleGroups = tagList
                .Where(t => !string.IsNullOrEmpty(t.Name) && t.Name.Contains(':'))
                .GroupBy(t => t.Name!.Split(':')[0])
                .Select(g =>
                {
                    devices.TryGetValue(g.Key, out var device);
                    return new
                    {
                        name = g.Key,
                        deviceType = device?.DeviceType,
                        ipAddress = device?.IpAddress,
                        parentDeviceId = device?.ParentDeviceId,
                        totalTags = g.Count(),
                        respondingTags = g.Count(t => t.State != null),
                        errorTags = g.Count(t => t.State == null),
                        status = g.All(t => t.State != null) ? "ok" :
                                 g.Any(t => t.State != null) ? "warning" : "error"
                    };
                })
                .OrderBy(m => m.name)
                .ToList();

            return Ok(new
            {
                plcConnected = _plcCommunication.IsPlcConnected,
                totalModules = moduleGroups.Count,
                modules = moduleGroups
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting modules status");
            return StatusCode(500, "Failed to get modules status");
        }
    }

    /// <summary>
    /// Get full list of discovered network devices with hierarchy
    /// </summary>
    [HttpGet("devices")]
    public async Task<ActionResult<object>> GetDevices()
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var devices = await context.NetworkDevices
                .OrderBy(d => d.DeviceName)
                .Select(d => new
                {
                    d.Id,
                    d.SubsystemId,
                    d.DeviceName,
                    d.DeviceType,
                    d.IpAddress,
                    d.ParentDeviceId,
                    d.TagCount,
                    d.Description,
                    d.CreatedAt,
                    d.UpdatedAt
                })
                .ToListAsync();

            return Ok(new
            {
                totalDevices = devices.Count,
                devices
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting network devices");
            return StatusCode(500, "Failed to get network devices");
        }
    }

    private (bool connected, string? statusCode, string? message) GetTagStatus(string tagName)
    {
        try
        {
            var tagList = _plcCommunication.TagList;
            var io = tagList?.FirstOrDefault(t =>
                t.Name?.Equals(tagName, StringComparison.OrdinalIgnoreCase) == true);

            if (io == null)
            {
                return (false, "NOT_FOUND", $"Tag '{tagName}' not found in configuration");
            }

            if (!_plcCommunication.IsPlcConnected)
            {
                return (false, "PLC_DISCONNECTED", "PLC connection lost");
            }

            var state = io.State;
            if (state == null)
            {
                return (false, "NO_RESPONSE", "No response from tag - may be initializing");
            }

            return (true, null, $"Current state: {state}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting tag status for {TagName}", tagName);
            return (false, "ERROR", ex.Message);
        }
    }

    private (int total, int responding, int errors) GetModuleStats(string moduleName)
    {
        try
        {
            if (moduleName == "All Modules" || moduleName == "Unknown")
                return (0, 0, 0);

            var tagList = _plcCommunication.TagList;
            if (tagList == null) return (0, 0, 0);

            var modulePrefix = moduleName + ":";
            var moduleTags = tagList.Where(t =>
                t.Name?.StartsWith(modulePrefix, StringComparison.OrdinalIgnoreCase) == true).ToList();

            var total = moduleTags.Count;
            var responding = moduleTags.Count(t => t.State != null);
            var errors = total - responding;

            return (total, responding, errors);
        }
        catch
        {
            return (0, 0, 0);
        }
    }

    private (int totalModules, int totalTags, int respondingTags, int errorTags) GetAggregateModuleStats()
    {
        try
        {
            var tagList = _plcCommunication.TagList;
            if (tagList == null || !tagList.Any())
                return (0, 0, 0, 0);

            var modulesWithTags = tagList
                .Where(t => !string.IsNullOrEmpty(t.Name) && t.Name.Contains(':'))
                .GroupBy(t => t.Name!.Split(':')[0]);

            var totalModules = modulesWithTags.Count();
            var totalTags = tagList.Count;
            var respondingTags = tagList.Count(t => t.State != null);
            var errorTags = totalTags - respondingTags;

            return (totalModules, totalTags, respondingTags, errorTags);
        }
        catch
        {
            return (0, 0, 0, 0);
        }
    }

    private async Task<Shared.Library.Models.Entities.NetworkDevice?> GetDeviceInfoAsync(string deviceName)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            return await context.NetworkDevices
                .FirstOrDefaultAsync(d => d.DeviceName == deviceName);
        }
        catch
        {
            return null;
        }
    }

    private async Task<string?> GetDeviceNameByIdAsync(int deviceId)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var device = await context.NetworkDevices.FindAsync(deviceId);
            return device?.DeviceName;
        }
        catch
        {
            return null;
        }
    }

    private string GetModuleStatusMessage(string moduleName, bool connected, int errorCount)
    {
        if (!connected)
            return $"Module {moduleName} - PLC not connected";
        if (errorCount == 0)
            return $"Module {moduleName} - All tags responding";
        if (errorCount == 1)
            return $"Module {moduleName} - 1 tag not responding";
        return $"Module {moduleName} - {errorCount} tags not responding";
    }
}
