using Microsoft.AspNetCore.SignalR.Client;

namespace IO_Checkout_Tool.Services.Interfaces;

/// <summary>
/// Abstraction for SignalR communication with cloud service.
/// Enables testing by allowing mock/test implementations.
/// </summary>
public interface ISignalRCloudClient
{
    /// <summary>
    /// Gets whether the SignalR connection is currently connected
    /// </summary>
    bool IsConnected { get; }

    /// <summary>
    /// Gets the current state of the SignalR connection
    /// </summary>
    HubConnectionState State { get; }

    /// <summary>
    /// Event fired when the connection state changes
    /// </summary>
    event Action? ConnectionStateChanged;

    /// <summary>
    /// Connects to the SignalR hub at the specified URL with optional API key
    /// </summary>
    /// <param name="url">The SignalR hub URL</param>
    /// <param name="apiKey">Optional API key for authentication</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>True if connection succeeded, false otherwise</returns>
    Task<bool> ConnectAsync(string url, string? apiKey, CancellationToken cancellationToken = default);

    /// <summary>
    /// Invokes a method on the SignalR hub
    /// </summary>
    /// <param name="methodName">Name of the hub method to invoke</param>
    /// <param name="args">Arguments to pass to the hub method</param>
    Task InvokeAsync(string methodName, params object[] args);

    /// <summary>
    /// Disconnects from the SignalR hub
    /// </summary>
    Task DisconnectAsync();

    /// <summary>
    /// Disposes the SignalR connection
    /// </summary>
    ValueTask DisposeAsync();
}
