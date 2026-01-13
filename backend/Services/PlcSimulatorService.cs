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

        // Pick one random untested IO to pulse
        var untestedIos = allIos.Where(io => string.IsNullOrEmpty(io.Result)).ToList();
        if (!untestedIos.Any())
        {
            _logger.LogDebug("🎮 All IOs have been tested, nothing to simulate");
            return;
        }

        var io = untestedIos[_random.Next(untestedIos.Count)];

        // Pulse: TRUE -> brief delay -> FALSE (simulates button press or sensor trigger)
        io.State = "TRUE";
        _logger.LogDebug("🎮 Simulated PULSE: {Name} -> TRUE", io.Name);
        await signalRService.SendIOUpdateAsync(io);

        // Brief delay to simulate the pulse duration (150ms)
        await Task.Delay(150);

        // Return to FALSE
        io.State = "FALSE";
        _logger.LogDebug("🎮 Simulated PULSE: {Name} -> FALSE", io.Name);
        await signalRService.SendIOUpdateAsync(io);
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

