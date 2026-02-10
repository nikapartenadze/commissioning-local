using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;
using IO_Checkout_Tool.Services.Interfaces;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

public class NetworkDiscoveryService : INetworkDiscoveryService
{
    private readonly IDbContextFactory<TagsContext> _contextFactory;
    private readonly ILogger<NetworkDiscoveryService> _logger;

    public NetworkDiscoveryService(
        IDbContextFactory<TagsContext> contextFactory,
        ILogger<NetworkDiscoveryService> logger)
    {
        _contextFactory = contextFactory;
        _logger = logger;
    }

    public async Task DiscoverDevicesAsync(int subsystemId)
    {
        try
        {
            using var context = await _contextFactory.CreateDbContextAsync();

            // 1. Query all IOs for this subsystem
            var ios = await context.Ios
                .Where(io => io.SubsystemId == subsystemId)
                .ToListAsync();

            if (!ios.Any())
            {
                _logger.LogInformation("No IOs found for subsystem {SubsystemId}, skipping network discovery", subsystemId);
                return;
            }

            _logger.LogInformation("Starting network discovery for subsystem {SubsystemId} with {Count} IOs", subsystemId, ios.Count);

            // 2. Parse each IO name to extract module prefix before ':'
            var deviceGroups = new Dictionary<string, List<Io>>(StringComparer.OrdinalIgnoreCase);

            foreach (var io in ios)
            {
                if (string.IsNullOrEmpty(io.Name)) continue;

                var colonIndex = io.Name.IndexOf(':');
                var prefix = colonIndex > 0 ? io.Name.Substring(0, colonIndex) : io.Name;

                // 3. Set NetworkDeviceName on the IO
                io.NetworkDeviceName = prefix;

                if (!deviceGroups.ContainsKey(prefix))
                {
                    deviceGroups[prefix] = new List<Io>();
                }
                deviceGroups[prefix].Add(io);
            }

            // Batch update IOs with NetworkDeviceName
            await context.SaveChangesAsync();
            _logger.LogInformation("Updated NetworkDeviceName for {Count} IOs", ios.Count);

            // 4. Get existing network devices for this subsystem
            var existingDevices = await context.NetworkDevices
                .Where(d => d.SubsystemId == subsystemId)
                .ToDictionaryAsync(d => d.DeviceName, StringComparer.OrdinalIgnoreCase);

            var addedCount = 0;
            var updatedCount = 0;

            // 5. Create or update NetworkDevice records
            foreach (var (deviceName, deviceIos) in deviceGroups)
            {
                var deviceType = InferDeviceType(deviceName);
                var tagCount = deviceIos.Count;

                if (existingDevices.TryGetValue(deviceName, out var existing))
                {
                    // Update
                    existing.DeviceType = deviceType;
                    existing.TagCount = tagCount;
                    existing.UpdatedAt = DateTime.UtcNow;
                    updatedCount++;
                }
                else
                {
                    // Create
                    context.NetworkDevices.Add(new NetworkDevice
                    {
                        SubsystemId = subsystemId,
                        DeviceName = deviceName,
                        DeviceType = deviceType,
                        TagCount = tagCount,
                        CreatedAt = DateTime.UtcNow
                    });
                    addedCount++;
                }
            }

            // Remove devices that no longer have any IOs
            var staleDevices = existingDevices
                .Where(kvp => !deviceGroups.ContainsKey(kvp.Key))
                .Select(kvp => kvp.Value)
                .ToList();

            if (staleDevices.Any())
            {
                context.NetworkDevices.RemoveRange(staleDevices);
                _logger.LogInformation("Removed {Count} stale network devices", staleDevices.Count);
            }

            await context.SaveChangesAsync();
            _logger.LogInformation("Network discovery complete: Discovered {Total} devices ({Added} new, {Updated} updated)",
                deviceGroups.Count, addedCount, updatedCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during network discovery for subsystem {SubsystemId}", subsystemId);
        }
    }

    /// <summary>
    /// Infers device type from naming conventions in tag name prefixes.
    /// </summary>
    private static string? InferDeviceType(string deviceName)
    {
        var upper = deviceName.ToUpperInvariant();

        if (upper.Contains("FIO")) return "FIO";
        if (upper.Contains("VFD")) return "VFD";
        if (upper.Contains("PLC")) return "CompactLogix";
        if (upper.Contains("HMI")) return "HMI";
        if (upper.Contains("DRV") || upper.Contains("DRIVE")) return "Drive";
        if (upper.Contains("RIO") || upper.Contains("REMOTE")) return "Remote I/O";
        if (upper.Contains("IOL") || upper.Contains("IOLINK")) return "IO-Link Master";
        if (upper.Contains("BCN") || upper.Contains("BEACON")) return "Beacon";
        if (upper.Contains("MOT") || upper.Contains("MOTOR")) return "Motor";
        if (upper.Contains("VLV") || upper.Contains("VALVE")) return "Valve";
        if (upper.Contains("PS") && upper.Contains("_")) return "Power Supply";

        return null;
    }
}
