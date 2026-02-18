using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;
using IO_Checkout_Tool.Services;
using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Models.Entities;
using Shared.Library.Repositories.Interfaces;

namespace IO_Checkout_Tool.Controllers;

[Authorize]
[ApiController]
[Route("api/simulator")]
public class SimulatorController : ControllerBase
{
    private readonly PlcSimulatorService _simulator;
    private readonly ISignalRService _signalRService;
    private readonly IIoRepository _ioRepository;
    private readonly ILogger<SimulatorController> _logger;

    public SimulatorController(
        PlcSimulatorService simulator,
        ISignalRService signalRService,
        IIoRepository ioRepository,
        ILogger<SimulatorController> logger)
    {
        _simulator = simulator;
        _signalRService = signalRService;
        _ioRepository = ioRepository;
        _logger = logger;
    }

    /// <summary>
    /// Enable PLC simulator
    /// </summary>
    [HttpPost("enable")]
    public IActionResult Enable([FromQuery] int intervalMs = 2000)
    {
        if (intervalMs < 500 || intervalMs > 10000)
        {
            return BadRequest("Interval must be between 500ms and 10000ms");
        }

        _simulator.Enable(intervalMs);
        _logger.LogInformation("🎮 PLC Simulator enabled via API");
        
        return Ok(new 
        { 
            message = "PLC Simulator enabled",
            enabled = true,
            intervalMs,
            info = "Simulator will randomly change I/O states for testing"
        });
    }

    /// <summary>
    /// Disable PLC simulator
    /// </summary>
    [HttpPost("disable")]
    public IActionResult Disable()
    {
        _simulator.Disable();
        _logger.LogInformation("🎮 PLC Simulator disabled via API");
        
        return Ok(new 
        { 
            message = "PLC Simulator disabled",
            enabled = false
        });
    }

    /// <summary>
    /// Get simulator status
    /// </summary>
    [HttpGet("status")]
    public IActionResult GetStatus()
    {
        return Ok(new 
        { 
            enabled = _simulator.IsEnabled,
            message = _simulator.IsEnabled 
                ? "Simulator is running" 
                : "Simulator is stopped"
        });
    }

    /// <summary>
    /// Manually trigger a specific I/O state change
    /// </summary>
    [HttpPost("trigger/{id}")]
    public async Task<IActionResult> TriggerIoChange(int id, [FromQuery] string state = "TRUE")
    {
        try
        {
            var io = await _ioRepository.GetByIdAsync(id);
            if (io == null)
            {
                return NotFound($"I/O with ID {id} not found");
            }

            if (state != "TRUE" && state != "FALSE")
            {
                return BadRequest("State must be 'TRUE' or 'FALSE'");
            }

            io.State = state;
            await _signalRService.SendIOUpdateAsync(io);
            
            _logger.LogInformation("🎮 Manual trigger: {Name} -> {State}", io.Name, state);
            
            return Ok(new 
            { 
                message = $"I/O state changed to {state}",
                io = new 
                {
                    io.Id,
                    io.Name,
                    io.State
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error triggering I/O change");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Trigger all inputs to TRUE (for quick testing)
    /// </summary>
    [HttpPost("trigger-all-inputs")]
    public async Task<IActionResult> TriggerAllInputs()
    {
        try
        {
            var allIos = await _ioRepository.GetAllAsync();
            var inputs = allIos.Where(io => !io.IsOutput && string.IsNullOrEmpty(io.Result)).ToList();

            var triggered = 0;
            foreach (var io in inputs)
            {
                io.State = "TRUE";
                await _signalRService.SendIOUpdateAsync(io);
                triggered++;
                await Task.Delay(100); // Small delay to avoid overwhelming
            }

            _logger.LogInformation("🎮 Triggered all {Count} inputs to TRUE", triggered);

            return Ok(new 
            { 
                message = $"Triggered {triggered} inputs to TRUE",
                count = triggered
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error triggering all inputs");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Reset all I/O states to FALSE
    /// </summary>
    [HttpPost("reset-all")]
    public async Task<IActionResult> ResetAll()
    {
        try
        {
            var allIos = await _ioRepository.GetAllAsync();
            
            var reset = 0;
            foreach (var io in allIos)
            {
                if (io.State != "FALSE")
                {
                    io.State = "FALSE";
                    await _signalRService.SendIOUpdateAsync(io);
                    reset++;
                }
            }

            _logger.LogInformation("🎮 Reset all {Count} I/O states to FALSE", reset);

            return Ok(new 
            { 
                message = $"Reset {reset} I/O states to FALSE",
                count = reset
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error resetting I/O states");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Simulate a sequence of changes (for demo/testing)
    /// </summary>
    [HttpPost("run-sequence")]
    public async Task<IActionResult> RunSequence([FromQuery] int count = 10, [FromQuery] int delayMs = 1000)
    {
        try
        {
            var allIos = await _ioRepository.GetAllAsync();
            var untested = allIos.Where(io => string.IsNullOrEmpty(io.Result)).ToList();

            if (!untested.Any())
            {
                return BadRequest("No untested I/O points available");
            }

            var random = new Random();
            var changes = new List<string>();

            for (int i = 0; i < count && i < untested.Count; i++)
            {
                var io = untested[i];
                io.State = random.Next(100) < 70 ? "TRUE" : "FALSE";
                await _signalRService.SendIOUpdateAsync(io);
                changes.Add($"{io.Name} -> {io.State}");
                
                if (i < count - 1)
                {
                    await Task.Delay(delayMs);
                }
            }

            _logger.LogInformation("🎮 Ran sequence of {Count} changes", changes.Count);

            return Ok(new 
            { 
                message = $"Ran sequence of {changes.Count} changes",
                changes
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error running sequence");
            return StatusCode(500, "Internal server error");
        }
    }
}

