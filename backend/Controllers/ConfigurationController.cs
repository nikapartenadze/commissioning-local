using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;
using IO_Checkout_Tool.Services.Interfaces;

namespace IO_Checkout_Tool.Controllers;

[Route("api/[controller]")]
[ApiController]
public class ConfigurationController : ControllerBase
{
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly IConfigurationService _configurationService;
    private readonly IPlcCommunicationService _plcCommunicationService;
    private readonly ILogger<ConfigurationController> _logger;

    public ConfigurationController(
        IDbContextFactory<TagsContext> contextFactory,
        IConfigurationService configurationService,
        IPlcCommunicationService plcCommunicationService,
        ILogger<ConfigurationController> logger)
    {
        _contextFactory = contextFactory;
        _configurationService = configurationService;
        _plcCommunicationService = plcCommunicationService;
        _logger = logger;
    }

    // GET: api/configuration
    [HttpGet]
    public async Task<ActionResult<IEnumerable<SubsystemConfiguration>>> GetAllConfigurations()
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var configurations = await context.SubsystemConfigurations
                .OrderBy(c => c.ProjectName)
                .ThenBy(c => c.SubsystemId)
                .ToListAsync();
            
            return Ok(configurations);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving configurations");
            return StatusCode(500, "Error retrieving configurations");
        }
    }

    // GET: api/configuration/active
    [HttpGet("active")]
    public async Task<ActionResult<SubsystemConfiguration>> GetActiveConfiguration()
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var activeConfig = await context.SubsystemConfigurations
                .FirstOrDefaultAsync(c => c.IsActive);
            
            if (activeConfig == null)
            {
                return NotFound("No active configuration found");
            }
            
            return Ok(activeConfig);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving active configuration");
            return StatusCode(500, "Error retrieving active configuration");
        }
    }

    // GET: api/configuration/{id}
    [HttpGet("{id}")]
    public async Task<ActionResult<SubsystemConfiguration>> GetConfiguration(int id)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var config = await context.SubsystemConfigurations.FindAsync(id);
            
            if (config == null)
            {
                return NotFound($"Configuration with ID {id} not found");
            }
            
            return Ok(config);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving configuration {ConfigId}", id);
            return StatusCode(500, "Error retrieving configuration");
        }
    }

    // GET: api/configuration/project/{projectName}/subsystem/{subsystemId}
    [HttpGet("project/{projectName}/subsystem/{subsystemId}")]
    public async Task<ActionResult<SubsystemConfiguration>> GetConfigurationByProjectAndSubsystem(
        string projectName, int subsystemId)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var config = await context.SubsystemConfigurations
                .FirstOrDefaultAsync(c => c.ProjectName == projectName && c.SubsystemId == subsystemId);
            
            if (config == null)
            {
                return NotFound($"Configuration for {projectName} - Subsystem {subsystemId} not found");
            }
            
            return Ok(config);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving configuration for {ProjectName} - Subsystem {SubsystemId}", 
                projectName, subsystemId);
            return StatusCode(500, "Error retrieving configuration");
        }
    }

    // POST: api/configuration
    [HttpPost]
    public async Task<ActionResult<SubsystemConfiguration>> CreateConfiguration(
        [FromBody] SubsystemConfiguration configuration)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            
            // Check if configuration already exists
            var existing = await context.SubsystemConfigurations
                .FirstOrDefaultAsync(c => c.ProjectName == configuration.ProjectName && 
                                         c.SubsystemId == configuration.SubsystemId);
            
            if (existing != null)
            {
                return Conflict($"Configuration for {configuration.ProjectName} - Subsystem {configuration.SubsystemId} already exists");
            }
            
            configuration.CreatedAt = DateTime.UtcNow;
            configuration.UpdatedAt = DateTime.UtcNow;
            configuration.IsActive = false; // New configs are not active by default
            
            context.SubsystemConfigurations.Add(configuration);
            await context.SaveChangesAsync();
            
            _logger.LogInformation("Created configuration for {ProjectName} - Subsystem {SubsystemId}", 
                configuration.ProjectName, configuration.SubsystemId);
            
            return CreatedAtAction(nameof(GetConfiguration), new { id = configuration.Id }, configuration);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating configuration");
            return StatusCode(500, "Error creating configuration");
        }
    }

    // PUT: api/configuration/{id}
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateConfiguration(int id, [FromBody] SubsystemConfiguration configuration)
    {
        try
        {
            if (id != configuration.Id)
            {
                return BadRequest("ID mismatch");
            }
            
            using var context = await _contextFactory.CreateDbContextAsync();
            var existing = await context.SubsystemConfigurations.FindAsync(id);
            
            if (existing == null)
            {
                return NotFound($"Configuration with ID {id} not found");
            }
            
            // Update properties
            existing.ProjectName = configuration.ProjectName;
            existing.SubsystemId = configuration.SubsystemId;
            existing.SubsystemName = configuration.SubsystemName;
            existing.Ip = configuration.Ip;
            existing.Path = configuration.Path;
            existing.RemoteUrl = configuration.RemoteUrl;
            existing.ApiPassword = configuration.ApiPassword;
            existing.OrderMode = configuration.OrderMode;
            existing.DisableWatchdog = configuration.DisableWatchdog;
            existing.ShowStateColumn = configuration.ShowStateColumn;
            existing.ShowResultColumn = configuration.ShowResultColumn;
            existing.ShowTimestampColumn = configuration.ShowTimestampColumn;
            existing.ShowHistoryColumn = configuration.ShowHistoryColumn;
            existing.Description = configuration.Description;
            existing.UpdatedAt = DateTime.UtcNow;
            
            await context.SaveChangesAsync();
            
            _logger.LogInformation("Updated configuration for {ProjectName} - Subsystem {SubsystemId}", 
                existing.ProjectName, existing.SubsystemId);
            
            return NoContent();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating configuration {ConfigId}", id);
            return StatusCode(500, "Error updating configuration");
        }
    }

    // DELETE: api/configuration/{id}
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteConfiguration(int id)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var config = await context.SubsystemConfigurations.FindAsync(id);
            
            if (config == null)
            {
                return NotFound($"Configuration with ID {id} not found");
            }
            
            if (config.IsActive)
            {
                return BadRequest("Cannot delete active configuration. Switch to another configuration first.");
            }
            
            context.SubsystemConfigurations.Remove(config);
            await context.SaveChangesAsync();
            
            _logger.LogInformation("Deleted configuration for {ProjectName} - Subsystem {SubsystemId}", 
                config.ProjectName, config.SubsystemId);
            
            return NoContent();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting configuration {ConfigId}", id);
            return StatusCode(500, "Error deleting configuration");
        }
    }

    // POST: api/configuration/{id}/activate
    [HttpPost("{id}/activate")]
    public async Task<IActionResult> ActivateConfiguration(int id)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            var config = await context.SubsystemConfigurations.FindAsync(id);
            
            if (config == null)
            {
                return NotFound($"Configuration with ID {id} not found");
            }
            
            // Deactivate all other configurations
            var allConfigs = await context.SubsystemConfigurations.ToListAsync();
            foreach (var c in allConfigs)
            {
                c.IsActive = (c.Id == id);
            }
            
            await context.SaveChangesAsync();
            
            // Update runtime configuration
            var switchSuccess = await _configurationService.SwitchToConfigurationAsync(
                config.Ip, 
                config.Path, 
                config.SubsystemId.ToString(),
                config.RemoteUrl ?? string.Empty,
                config.ApiPassword ?? string.Empty,
                config.OrderMode,
                config.DisableWatchdog,
                config.ShowStateColumn,
                config.ShowResultColumn,
                config.ShowTimestampColumn,
                config.ShowHistoryColumn
            );
            
            if (!switchSuccess)
            {
                _logger.LogError("Failed to switch to configuration {ConfigId}", id);
                return StatusCode(500, "Failed to activate configuration");
            }
            
            // Reconnect PLC with new configuration
            await _plcCommunicationService.ReconnectAsync(config.Ip, config.Path);
            
            _logger.LogInformation("Activated configuration for {ProjectName} - Subsystem {SubsystemId}", 
                config.ProjectName, config.SubsystemId);
            
            return Ok(new { 
                message = $"Successfully switched to {config.ProjectName} - Subsystem {config.SubsystemId}",
                configuration = config
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error activating configuration {ConfigId}", id);
            return StatusCode(500, "Error activating configuration");
        }
    }

    // GET: api/configuration/runtime
    /// <summary>
    /// Returns runtime configuration for the frontend.
    /// This allows the frontend to dynamically discover the backend port for SignalR connections
    /// without relying on environment variables that are fixed at startup.
    /// </summary>
    [HttpGet("runtime")]
    public async Task<ActionResult<FrontendRuntimeConfig>> GetRuntimeConfiguration()
    {
        try
        {
            // Get the port from the current request
            var backendPort = HttpContext.Request.Host.Port ?? 5000;

            // Check cloud connection status
            var cloudSyncService = HttpContext.RequestServices.GetService<ICloudSyncService>();
            var cloudConnected = cloudSyncService != null && await cloudSyncService.IsCloudAvailable();

            // Build SignalR hub URL dynamically
            var signalRHubUrl = $"{HttpContext.Request.Scheme}://{HttpContext.Request.Host}/hub";

            var config = new FrontendRuntimeConfig
            {
                BackendPort = backendPort,
                SubsystemId = _configurationService.SubsystemId,
                PlcIp = _configurationService.Ip,
                CloudConnected = cloudConnected,
                IsReloading = _configurationService.IsReinitializing,
                ShowStateColumn = _configurationService.ShowStateColumn,
                ShowResultColumn = _configurationService.ShowResultColumn,
                ShowTimestampColumn = _configurationService.ShowTimestampColumn,
                ShowHistoryColumn = _configurationService.ShowHistoryColumn,
                OrderMode = _configurationService.OrderMode,
                SignalRHubUrl = signalRHubUrl
            };

            return Ok(config);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving runtime configuration");
            return StatusCode(500, "Error retrieving runtime configuration");
        }
    }

    // POST: api/configuration/import-from-config-json
    [HttpPost("import-from-config-json")]
    public async Task<IActionResult> ImportFromConfigJson()
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();
            
            // Check if we already have configurations
            var existingCount = await context.SubsystemConfigurations.CountAsync();
            if (existingCount > 0)
            {
                return BadRequest("Configurations already exist in database. Use update endpoint instead.");
            }
            
            // Create configuration from current config.json values
            var config = new SubsystemConfiguration
            {
                ProjectName = "Default Project",
                SubsystemId = int.Parse(_configurationService.SubsystemId),
                SubsystemName = $"Subsystem {_configurationService.SubsystemId}",
                Ip = _configurationService.Ip,
                Path = _configurationService.Path,
                RemoteUrl = _configurationService.RemoteUrl,
                ApiPassword = _configurationService.ApiPassword,
                OrderMode = _configurationService.OrderMode,
                DisableWatchdog = _configurationService.DisableWatchdog,
                ShowStateColumn = _configurationService.ShowStateColumn,
                ShowResultColumn = _configurationService.ShowResultColumn,
                ShowTimestampColumn = _configurationService.ShowTimestampColumn,
                ShowHistoryColumn = _configurationService.ShowHistoryColumn,
                IsActive = true,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
                Description = "Imported from config.json"
            };
            
            context.SubsystemConfigurations.Add(config);
            await context.SaveChangesAsync();
            
            _logger.LogInformation("Imported configuration from config.json");
            
            return Ok(new { message = "Successfully imported configuration from config.json", configuration = config });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error importing from config.json");
            return StatusCode(500, "Error importing configuration");
        }
    }

    // POST: api/configuration/update-config-json
    [HttpPost("update-config-json")]
    public async Task<IActionResult> UpdateConfigJson([FromBody] ConfigJsonUpdateRequest request)
    {
        try
        {
            // Validate request
            if (string.IsNullOrEmpty(request.Ip) || string.IsNullOrEmpty(request.Path) || string.IsNullOrEmpty(request.SubsystemId))
            {
                return BadRequest("IP, Path, and SubsystemId are required");
            }

            // Update the configuration using the existing service
            var success = await _configurationService.UpdateConfigurationAsync(
                request.Ip,
                request.Path,
                request.SubsystemId,
                request.RemoteUrl ?? string.Empty,
                request.ApiPassword ?? string.Empty,
                request.OrderMode ?? false,
                request.DisableWatchdog ?? false,
                request.ShowStateColumn ?? true,
                request.ShowResultColumn ?? true,
                request.ShowTimestampColumn ?? true,
                request.ShowHistoryColumn ?? true
            );

            if (!success)
            {
                return StatusCode(500, "Failed to update configuration");
            }

            // Reinitialize the application with new settings
            await _configurationService.ReinitializeApplicationAsync();

            // Get IO count after reinitialization
            int ioCount = 0;
            try
            {
                var plcService = HttpContext.RequestServices.GetService<IPlcCommunicationService>();
                ioCount = plcService?.TagList?.Count ?? 0;
            }
            catch { /* Ignore errors getting IO count */ }

            _logger.LogInformation("Updated config.json and reinitialized application. IP={Ip}, Path={Path}, SubsystemId={SubsystemId}, IOs={IoCount}",
                request.Ip, request.Path, request.SubsystemId, ioCount);

            return Ok(new {
                message = "Configuration updated and application reinitialized successfully",
                ip = request.Ip,
                path = request.Path,
                subsystemId = request.SubsystemId,
                disableWatchdog = request.DisableWatchdog,
                ioCount = ioCount
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating config.json");
            return StatusCode(500, "Error updating configuration");
        }
    }
}

public class ConfigJsonUpdateRequest
{
    public string Ip { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string SubsystemId { get; set; } = string.Empty;
    public string? RemoteUrl { get; set; }
    public string? ApiPassword { get; set; }
    public bool? OrderMode { get; set; }
    public bool? DisableWatchdog { get; set; }
    public bool? ShowStateColumn { get; set; }
    public bool? ShowResultColumn { get; set; }
    public bool? ShowTimestampColumn { get; set; }
    public bool? ShowHistoryColumn { get; set; }
}

/// <summary>
/// Response model for frontend runtime configuration.
/// This allows the frontend to dynamically fetch configuration without relying on environment variables.
/// </summary>
public class FrontendRuntimeConfig
{
    /// <summary>
    /// The port the backend is running on. Frontend uses this for SignalR connections.
    /// </summary>
    public int BackendPort { get; set; }

    /// <summary>
    /// The current subsystem ID being used.
    /// </summary>
    public string SubsystemId { get; set; } = string.Empty;

    /// <summary>
    /// The PLC IP address (for display purposes).
    /// </summary>
    public string PlcIp { get; set; } = string.Empty;

    /// <summary>
    /// Whether the cloud connection is available.
    /// </summary>
    public bool CloudConnected { get; set; }

    /// <summary>
    /// Whether configuration is currently being reloaded.
    /// </summary>
    public bool IsReloading { get; set; }

    /// <summary>
    /// Column visibility settings.
    /// </summary>
    public bool ShowStateColumn { get; set; }
    public bool ShowResultColumn { get; set; }
    public bool ShowTimestampColumn { get; set; }
    public bool ShowHistoryColumn { get; set; }

    /// <summary>
    /// Order mode (sequential testing).
    /// </summary>
    public bool OrderMode { get; set; }

    /// <summary>
    /// SignalR hub URL for WebSocket connections.
    /// </summary>
    public string SignalRHubUrl { get; set; } = string.Empty;
}

