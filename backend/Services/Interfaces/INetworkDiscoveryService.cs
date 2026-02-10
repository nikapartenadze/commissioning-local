namespace IO_Checkout_Tool.Services.Interfaces;

public interface INetworkDiscoveryService
{
    /// <summary>
    /// Discovers network devices by parsing IO tag names for the given subsystem.
    /// Populates NetworkDevices table and sets Io.NetworkDeviceName for each IO.
    /// </summary>
    Task DiscoverDevicesAsync(int subsystemId);
}
