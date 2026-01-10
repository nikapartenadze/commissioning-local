using IO_Checkout_Tool.Services.Interfaces;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Shared.Library.Models.Entities;
using Shared.Library.Repositories.Interfaces;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Simulates PLC tag state changes for testing without physical hardware
/// </summary>
public class PlcSimulatorService : BackgroundService
{
    private readonly ILogger<PlcSimulatorService> _logger;
    private readonly IServiceProvider _serviceProvider;
    private readonly Random _random = new();
    private bool _isEnabled = false;
    private int _updateIntervalMs = 2000; // Default 2 seconds

    public PlcSimulatorService(
        ILogger<PlcSimulatorService> logger,
        IServiceProvider serviceProvider)
    {
        _logger = logger;
        _serviceProvider = serviceProvider;
    }

    public void Enable(int updateIntervalMs = 2000)
    {
        _isEnabled = true;
        _updateIntervalMs = updateIntervalMs;
        _logger.LogInformation("🎮 PLC Simulator ENABLED - Updates every {Interval}ms", updateIntervalMs);
    }

    public void Disable()
    {
        _isEnabled = false;
        _logger.LogInformation("🎮 PLC Simulator DISABLED");
    }

    public bool IsEnabled => _isEnabled;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("🎮 PLC Simulator Service started (disabled by default)");
        _logger.LogInformation("💡 Enable via API: POST /api/simulator/enable");

        while (!stoppingToken.IsCancellationRequested)
        {
            if (_isEnabled)
            {
                try
                {
                    await SimulateTagChanges();
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error in PLC simulator");
                }
            }

            await Task.Delay(_updateIntervalMs, stoppingToken);
        }
    }

    private async Task SimulateTagChanges()
    {
        using var scope = _serviceProvider.CreateScope();
        var signalRService = scope.ServiceProvider.GetRequiredService<ISignalRService>();
        var ioRepository = scope.ServiceProvider.GetRequiredService<IIoRepository>();

        var allIos = await ioRepository.GetAllAsync();
        if (!allIos.Any())
        {
            return; // No I/O points to simulate
        }

        // Simulate 1-3 random tag changes per cycle
        var numberOfChanges = _random.Next(1, 4);
        var iosToChange = allIos.OrderBy(x => _random.Next()).Take(numberOfChanges);

        foreach (var io in iosToChange)
        {
            // Skip if already tested (don't change tested points)
            if (!string.IsNullOrEmpty(io.Result))
            {
                continue;
            }

            // Determine if this is an input or output
            bool isOutput = io.IsOutput;

            if (isOutput)
            {
                // Outputs: Simulate activation (e.g., when user fires output)
                // For simulation, randomly activate outputs
                if (_random.Next(100) < 10) // 10% chance per cycle
                {
                    io.State = "TRUE";
                    _logger.LogDebug("🎮 Simulated OUTPUT activation: {Name} -> TRUE", io.Name);
                    await signalRService.SendIOUpdateAsync(io);
                }
            }
            else
            {
                // Inputs: Simulate state changes (sensor triggers, button presses, etc.)
                var shouldChange = _random.Next(100) < 15; // 15% chance per cycle

                if (shouldChange)
                {
                    // Toggle state or set to TRUE
                    var newState = io.State == "TRUE" ? "FALSE" : "TRUE";
                    
                    // Bias towards TRUE for testing (70% TRUE, 30% FALSE)
                    if (_random.Next(100) < 70)
                    {
                        newState = "TRUE";
                    }

                    io.State = newState;
                    _logger.LogDebug("🎮 Simulated INPUT change: {Name} -> {State}", io.Name, newState);
                    await signalRService.SendIOUpdateAsync(io);
                }
            }
        }
    }
}

/// <summary>
/// Simulation modes for different testing scenarios
/// </summary>
public enum SimulationMode
{
    /// <summary>
    /// Random state changes (default)
    /// </summary>
    Random,
    
    /// <summary>
    /// Sequential - goes through each I/O in order
    /// </summary>
    Sequential,
    
    /// <summary>
    /// All inputs go TRUE one by one
    /// </summary>
    AllInputsTrue,
    
    /// <summary>
    /// Rapid changes for stress testing
    /// </summary>
    RapidFire
}

