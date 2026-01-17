using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.Interfaces;

public interface ISignalRService
{
    Task SendMessageAsync(Io tag);
    Task SendDialogCloseAsync();
    Task SendIOUpdateAsync(Io io);
    Task SendStateUpdateAsync(Io io);

    /// <summary>
    /// Broadcasts that configuration is being reloaded due to external config.json change.
    /// Frontend should show a loading indicator.
    /// </summary>
    Task BroadcastConfigurationReloading();

    /// <summary>
    /// Broadcasts that configuration reload is complete.
    /// Frontend should refresh its data.
    /// </summary>
    Task BroadcastConfigurationReloaded();

    /// <summary>
    /// Broadcasts current configuration values to all connected clients.
    /// Used for frontend to get dynamic configuration without environment variables.
    /// </summary>
    Task BroadcastConfiguration(int backendPort, string subsystemId, string plcIp, bool cloudConnected);

    /// <summary>
    /// Broadcasts testing state change to all connected clients.
    /// All browsers will see the Start/Stop Testing button state change immediately.
    /// </summary>
    Task BroadcastTestingStateChanged(bool isTesting);

    /// <summary>
    /// Broadcasts comment update to all connected clients.
    /// </summary>
    Task BroadcastCommentUpdate(int ioId, string? comments);
} 