using Microsoft.AspNetCore.Mvc;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Controllers;

[ApiController]
[Route("api/network")]
public class NetworkController : ControllerBase
{
    private readonly IPlcCommunicationService _plcCommunication;
    private readonly ICloudSyncService _cloudSyncService;
    private readonly IConfigurationService _configuration;
    private readonly ILogger<NetworkController> _logger;

    public NetworkController(
        IPlcCommunicationService plcCommunication,
        ICloudSyncService cloudSyncService,
        IConfigurationService configuration,
        ILogger<NetworkController> logger)
    {
        _plcCommunication = plcCommunication;
        _cloudSyncService = cloudSyncService;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>
    /// Get the network chain status for diagnostics breadcrumbs
    /// Shows status of: Cloud -> Backend -> PLC -> Module -> IO Point
    /// </summary>
    [HttpGet("chain-status")]
    public ActionResult<object> GetChainStatus([FromQuery] string? tagName)
    {
        try
        {
            // Parse tag name to extract module/rack info
            // Tag format example: EPZ_PS2_FIO1:I.Pt00.Data
            var moduleName = "Unknown";
            var ioPointName = "Unknown";
            var tagConnected = false;
            string? tagStatusCode = null;
            string? tagMessage = null;

            if (!string.IsNullOrEmpty(tagName))
            {
                // Extract module name (everything before the colon)
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

                // Check if this specific tag is working
                var tagInfo = GetTagStatus(tagName);
                tagConnected = tagInfo.connected;
                tagStatusCode = tagInfo.statusCode;
                tagMessage = tagInfo.message;
            }
            else
            {
                // No specific tag, show general status
                moduleName = "All Modules";
                ioPointName = "All Points";
                tagConnected = _plcCommunication.IsPlcConnected;
            }

            // Get module-level error count
            var moduleErrorCount = GetModuleErrorCount(moduleName);
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
                    connected = true, // Always true if we're responding
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
                    connected = moduleConnected,
                    errorCount = moduleErrorCount,
                    message = GetModuleStatusMessage(moduleName, moduleConnected, moduleErrorCount)
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
    /// Get status for a specific tag
    /// </summary>
    private (bool connected, string? statusCode, string? message) GetTagStatus(string tagName)
    {
        try
        {
            // Check if tag exists in the tag list
            var tagList = _plcCommunication.TagList;
            var io = tagList?.FirstOrDefault(t =>
                t.Name?.Equals(tagName, StringComparison.OrdinalIgnoreCase) == true);

            if (io == null)
            {
                return (false, "NOT_FOUND", $"Tag '{tagName}' not found in configuration");
            }

            // Check if PLC is connected
            if (!_plcCommunication.IsPlcConnected)
            {
                return (false, "PLC_DISCONNECTED", "PLC connection lost");
            }

            // Tag exists and PLC is connected - check the state
            var state = io.State;
            if (state == null)
            {
                return (false, "NO_RESPONSE", "No response from tag - may be initializing");
            }

            // If we have a state value, the tag is working
            return (true, null, $"Current state: {state}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting tag status for {TagName}", tagName);
            return (false, "ERROR", ex.Message);
        }
    }

    /// <summary>
    /// Get error count for tags in a specific module
    /// </summary>
    private int GetModuleErrorCount(string moduleName)
    {
        try
        {
            if (moduleName == "All Modules" || moduleName == "Unknown")
            {
                return 0;
            }

            var tagList = _plcCommunication.TagList;
            if (tagList == null) return 0;

            // Count tags in this module that have no state (errors)
            var modulePrefix = moduleName + ":";
            var moduleTags = tagList.Where(t =>
                t.Name?.StartsWith(modulePrefix, StringComparison.OrdinalIgnoreCase) == true);

            var errorCount = moduleTags.Count(t => t.State == null);
            return errorCount;
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>
    /// Get status message for a module
    /// </summary>
    private string GetModuleStatusMessage(string moduleName, bool connected, int errorCount)
    {
        if (!connected)
        {
            return $"Module {moduleName} - PLC not connected";
        }

        if (errorCount == 0)
        {
            return $"Module {moduleName} - All tags responding";
        }

        if (errorCount == 1)
        {
            return $"Module {moduleName} - 1 tag not responding";
        }

        return $"Module {moduleName} - {errorCount} tags not responding";
    }

    /// <summary>
    /// Get detailed status for all modules
    /// </summary>
    [HttpGet("modules")]
    public ActionResult<object> GetModulesStatus()
    {
        try
        {
            var tagList = _plcCommunication.TagList;
            if (tagList == null || !tagList.Any())
            {
                return Ok(new { modules = Array.Empty<object>() });
            }

            // Group tags by module (prefix before colon)
            var moduleGroups = tagList
                .Where(t => !string.IsNullOrEmpty(t.Name) && t.Name.Contains(':'))
                .GroupBy(t => t.Name!.Split(':')[0])
                .Select(g => new
                {
                    name = g.Key,
                    totalTags = g.Count(),
                    respondingTags = g.Count(t => t.State != null),
                    errorTags = g.Count(t => t.State == null),
                    status = g.All(t => t.State != null) ? "ok" :
                             g.Any(t => t.State != null) ? "warning" : "error"
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
}
